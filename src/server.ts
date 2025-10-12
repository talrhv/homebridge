import type { MacAddress } from 'hap-nodejs'

import type {
  AccessoryIdentifier,
  AccessoryName,
  AccessoryPlugin,
  AccessoryPluginConstructor,
  PlatformIdentifier,
  PlatformName,
  PlatformPlugin,
  PlatformPluginConstructor,
} from './api.js'
import type { BridgeConfiguration, BridgeOptions, HomebridgeConfig } from './bridgeService.js'
import type { Plugin } from './plugin.js'
import type { PluginManagerOptions } from './pluginManager.js'

import { existsSync, readFileSync } from 'node:fs'
import process from 'node:process'

import chalk from 'chalk'
import { AccessoryEventTypes, MDNSAdvertiser } from 'hap-nodejs'
import qrcode from 'qrcode-terminal'

import { HomebridgeAPI, InternalAPIEvent, PluginType } from './api.js'
import { BridgeService } from './bridgeService.js'
import { ChildBridgeService } from './childBridgeService.js'
import { ExternalPortService } from './externalPortService.js'
import { IpcIncomingEvent, IpcOutgoingEvent, IpcService, ServerStatusUpdate } from './ipcService.js'
import { Logger } from './logger.js'
import { MatterConfigValidator, MatterServer } from './matter/index.js'
import { PlatformAccessory } from './platformAccessory.js'
import { PluginManager } from './pluginManager.js'
import { User } from './user.js'
import { generate, validMacAddress } from './util/mac.js'

const log = Logger.internal

export interface HomebridgeOptions {
  keepOrphanedCachedAccessories?: boolean
  hideQRCode?: boolean
  insecureAccess?: boolean
  customPluginPath?: string
  noLogTimestamps?: boolean
  debugModeEnabled?: boolean
  forceColourLogging?: boolean
  customStoragePath?: string
  strictPluginResolution?: boolean
}

// eslint-disable-next-line no-restricted-syntax
export const enum ServerStatus {
  /**
   * When the server is starting up
   */
  PENDING = 'pending',

  /**
   * When the server is online and has published the main bridge
   */
  OK = 'ok',

  /**
   * When the server is shutting down
   */
  DOWN = 'down',
}

export class Server {
  private readonly api: HomebridgeAPI
  private readonly pluginManager: PluginManager
  private readonly bridgeService: BridgeService
  private readonly ipcService: IpcService
  private readonly externalPortService: ExternalPortService

  private readonly config: HomebridgeConfig

  // used to keep track of child bridges
  // Key is HAP username (MAC address)
  private readonly childBridges: Map<string, ChildBridgeService> = new Map()

  // Matter server instance for main bridge (if enabled)
  private matterServer?: MatterServer

  // External Matter servers for accessories that need their own bridge
  // Key is accessory UUID, value is MatterServer instance
  private readonly externalMatterServers: Map<string, MatterServer> = new Map()

  // current server status
  private serverStatus: ServerStatus = ServerStatus.PENDING

  constructor(
    private options: HomebridgeOptions = {},
  ) {
    this.config = Server.loadConfig()

    // object we feed to Plugins and BridgeService
    this.api = new HomebridgeAPI()
    this.ipcService = new IpcService()
    this.externalPortService = new ExternalPortService(this.config.ports, this.config.matterPorts)

    // set status to pending
    this.setServerStatus(ServerStatus.PENDING)

    // create new plugin manager
    const pluginManagerOptions: PluginManagerOptions = {
      activePlugins: this.config.plugins,
      disabledPlugins: this.config.disabledPlugins,
      customPluginPath: options.customPluginPath,
      strictPluginResolution: options.strictPluginResolution,
    }
    this.pluginManager = new PluginManager(this.api, pluginManagerOptions)

    // create new bridge service
    const bridgeConfig: BridgeOptions = {
      cachedAccessoriesDir: User.cachedAccessoryPath(),
      cachedAccessoriesItemName: 'cachedAccessories',
    }

    // shallow copy the homebridge options to the bridge options object
    Object.assign(bridgeConfig, this.options)

    this.bridgeService = new BridgeService(
      this.api,
      this.pluginManager,
      this.externalPortService,
      bridgeConfig,
      this.config.bridge,
    )

    // Handle platform accessory registration
    this.api.on(InternalAPIEvent.REGISTER_PLATFORM_ACCESSORIES, this.handleRegisterPlatformAccessories.bind(this))
    this.api.on(InternalAPIEvent.UNREGISTER_PLATFORM_ACCESSORIES, this.handleUnregisterPlatformAccessories.bind(this))

    // Handle external accessories (cameras, etc.)
    this.api.on(InternalAPIEvent.PUBLISH_EXTERNAL_ACCESSORIES, this.handlePublishExternalAccessories.bind(this))

    // Handle Matter accessory registration (matching HAP pattern)
    this.api.on(InternalAPIEvent.PUBLISH_EXTERNAL_MATTER_ACCESSORIES, this.handlePublishExternalMatterAccessories.bind(this))
    this.api.on(InternalAPIEvent.REGISTER_MATTER_PLATFORM_ACCESSORIES, this.handleRegisterMatterPlatformAccessories.bind(this))
    this.api.on(InternalAPIEvent.UNREGISTER_MATTER_PLATFORM_ACCESSORIES, this.handleUnregisterMatterPlatformAccessories.bind(this))
    this.api.on(InternalAPIEvent.UPDATE_MATTER_ACCESSORY_STATE, this.handleUpdateMatterAccessoryState.bind(this))

    // watch bridge events to check when server is online
    this.bridgeService.bridge.on(AccessoryEventTypes.ADVERTISED, () => {
      this.setServerStatus(ServerStatus.OK)
    })

    // watch for the paired event to update the server status
    this.bridgeService.bridge.on(AccessoryEventTypes.PAIRED, () => {
      this.setServerStatus(this.serverStatus)
    })

    // watch for the unpaired event to update the server status
    this.bridgeService.bridge.on(AccessoryEventTypes.UNPAIRED, () => {
      this.setServerStatus(this.serverStatus)
    })
  }

  /**
   * Set the current server status and update parent via IPC
   * @param status
   */
  private setServerStatus(status: ServerStatus) {
    this.serverStatus = status

    const statusUpdate: ServerStatusUpdate = {
      status: this.serverStatus,
      paired: this.bridgeService?.bridge?._accessoryInfo?.paired() ?? null,
      setupUri: this.bridgeService?.bridge?.setupURI() ?? null,
      name: this.config.bridge.name,
      username: this.config.bridge.username,
      pin: this.config.bridge.pin,
      matter: {
        enabled: false,
      },
    }

    // Include Matter commissioning info if Matter is enabled
    if (this.matterServer) {
      const commissioningInfo = this.matterServer.getCommissioningInfo()
      statusUpdate.matter = {
        enabled: true,
        port: this.config.bridge.matter?.port,
        setupUri: commissioningInfo.qrCode,
        pin: commissioningInfo.manualPairingCode,
        serialNumber: commissioningInfo.serialNumber,
        commissioned: commissioningInfo.commissioned || false,
        deviceCount: this.matterServer.getAccessories().length,
      }
    } else if (this.config.bridge.matter) {
      // Matter is configured but not yet started (or failed to start)
      statusUpdate.matter = {
        enabled: false,
        port: this.config.bridge.matter?.port,
      }
    }

    this.ipcService.sendMessage(IpcOutgoingEvent.SERVER_STATUS_UPDATE, statusUpdate)
  }

  public async start(): Promise<void> {
    if (this.config.bridge.disableIpc !== true) {
      this.initializeIpcEventHandlers()
    }

    const promises: Promise<void>[] = []

    // load the cached accessories
    await this.bridgeService.loadCachedPlatformAccessoriesFromDisk()

    // initialize plugins
    await this.pluginManager.initializeInstalledPlugins()

    // Initialize Matter server for main bridge if enabled
    await this.initializeMatterServer()

    if (this.config.platforms.length > 0) {
      promises.push(...this.loadPlatforms())
    }
    if (this.config.accessories.length > 0) {
      this.loadAccessories()
    }

    // start child bridges
    for (const childBridge of this.childBridges.values()) {
      childBridge.start()
    }

    // restore cached accessories
    this.bridgeService.restoreCachedPlatformAccessories()
    this.restoreCachedMatterAccessories()

    this.api.signalFinished()

    // wait for all platforms to publish their accessories before we publish the bridge
    await Promise.all(promises)
      .then(() => this.publishBridge())
  }

  /**
   * Initialize Matter server for main bridge if enabled
   */
  private async initializeMatterServer(): Promise<void> {
    // Check if main bridge has matter configuration
    if (!this.config.bridge.matter) {
      return
    }

    // Declare matterPort outside try block so it's accessible in catch
    let matterPort: number | undefined

    try {
      log.info('Initializing Matter server for main bridge...')

      // Allocate port from pool if not explicitly configured
      matterPort = this.config.bridge.matter.port
      if (!matterPort) {
        matterPort = await this.externalPortService.requestPort(`${this.config.bridge.username}:MATTER` as MacAddress)
        if (!matterPort) {
          matterPort = 5540 // Default Matter port
          log.warn('No port available from pool for main Matter bridge, using default port 5540')
        } else {
          log.info(`Allocated port ${matterPort} from pool for main Matter bridge`)
        }
      }

      // Create Matter server instance with config inheritance from main bridge
      const serialNumber = this.config.bridge.username.replace(/:/g, '')

      // Normalize bind config to array format
      const networkInterfaces = this.config.bridge.bind
        ? Array.isArray(this.config.bridge.bind)
          ? this.config.bridge.bind
          : [this.config.bridge.bind]
        : undefined

      this.matterServer = new MatterServer({
        storagePath: User.matterPath(),
        port: matterPort,
        uniqueId: serialNumber,
        manufacturer: this.config.bridge.manufacturer,
        model: this.config.bridge.model,
        firmwareRevision: this.config.bridge.firmwareRevision,
        serialNumber,
        debugModeEnabled: this.options.debugModeEnabled,
        networkInterfaces,
      })

      // Start the Matter server
      await this.matterServer.start()

      log.info('Matter server initialized for main bridge')

      // Inform the API that Matter is enabled
      this.api._setMatterEnabled(true)

      // Set the Matter server reference for API methods like getAccessoryState
      this.api._setMatterServer(this.matterServer)

      // Listen for Matter commissioning events to update status
      this.matterServer.on('commissioning-changed', (commissioned: boolean, fabricCount: number) => {
        log.info(`Matter commissioning state changed: commissioned=${commissioned}, fabricCount=${fabricCount}`)
        this.setServerStatus(this.serverStatus)
      })
    } catch (error: any) {
      log.error('Failed to initialize Matter server for main bridge:', error)

      // Provide user-friendly guidance for common errors
      if (error.message && error.message.includes('corrupted')) {
        log.error('')
        log.error('╔════════════════════════════════════════════════════════════════════════════╗')
        log.error('║  MATTER STORAGE CORRUPTED                                                  ║')
        log.error('╠════════════════════════════════════════════════════════════════════════════╣')
        log.error('║  Your Matter storage has become corrupted. This can happen when:          ║')
        log.error('║  • Matter.js library version changes                                       ║')
        log.error('║  • Storage format upgrades occur                                           ║')
        log.error('║  • Incomplete writes during shutdown                                       ║')
        log.error('║                                                                            ║')
        log.error('║  To fix this, delete the corrupted storage directory:                     ║')
        log.error(`║  rm -rf ~/.homebridge/matter/${this.config.bridge.username}                                   ║`)
        log.error('║                                                                            ║')
        log.error('║  Note: You will need to re-pair your Matter devices after deletion.       ║')
        log.error('╚════════════════════════════════════════════════════════════════════════════╝')
        log.error('')
      } else if (error.code === 'EADDRINUSE' || (error.message && error.message.includes('address already in use'))) {
        log.error('')
        log.error('╔════════════════════════════════════════════════════════════════════════════╗')
        log.error('║  MATTER PORT ALREADY IN USE                                                ║')
        log.error('╠════════════════════════════════════════════════════════════════════════════╣')
        log.error(`║  Port ${matterPort} is already in use by another application.                    ║`)
        log.error('║                                                                            ║')
        log.error('║  To fix this:                                                              ║')
        log.error('║  1. Stop the application using this port, or                              ║')
        log.error('║  2. Configure a different port in your config.json:                       ║')
        log.error('║     "bridge": {                                                            ║')
        log.error('║       "matter": {                                                          ║')
        log.error('║         "port": <different-port>                                           ║')
        log.error('║       }                                                                    ║')
        log.error('║     }                                                                      ║')
        log.error('╚════════════════════════════════════════════════════════════════════════════╝')
        log.error('')
      }
    }
  }

  public async teardown(): Promise<void> {
    this.bridgeService.teardown()

    // Stop main Matter server if running
    if (this.matterServer) {
      try {
        await this.matterServer.stop()
      } catch (error) {
        log.error('Failed to stop Matter server:', error)
      }
    }

    // Stop all external Matter servers
    for (const [uuid, matterServer] of this.externalMatterServers) {
      try {
        await matterServer.stop()
        log.debug(`Stopped external Matter server for ${uuid}`)
      } catch (error) {
        log.error(`Failed to stop external Matter server for ${uuid}:`, error)
      }
    }
    this.externalMatterServers.clear()

    // Child bridge Matter servers are stopped by their own forked processes

    this.setServerStatus(ServerStatus.DOWN)
  }

  private publishBridge(): void {
    this.bridgeService.publishBridge()
    this.printSetupInfo(this.config.bridge.pin)
  }

  private handlePublishExternalAccessories(accessories: PlatformAccessory[]): void {
    log.info(`Publishing ${accessories.length} external accessories`)
    // External accessories are published via HAP
    // Plugins should use api.matter to register Matter accessories explicitly
  }

  /**
   * Handle external Matter accessories - each gets its own dedicated Matter server
   * This is required for devices like Robotic Vacuum Cleaners that Apple Home
   * requires to be on their own bridge.
   */
  private async handlePublishExternalMatterAccessories(accessories: any[]): Promise<void> {
    log.info(`Publishing ${accessories.length} external Matter accessor${accessories.length === 1 ? 'y' : 'ies'}`)

    for (const accessory of accessories) {
      try {
        // Validate accessory has required fields
        if (!accessory.uuid) {
          log.error('External Matter accessory missing UUID - skipping')
          continue
        }

        if (!accessory.displayName) {
          log.error(`External Matter accessory ${accessory.uuid} missing displayName - skipping`)
          continue
        }

        // Check if already published
        if (this.externalMatterServers.has(accessory.uuid)) {
          log.warn(`External Matter accessory ${accessory.displayName} (${accessory.uuid}) is already published`)
          continue
        }

        // Generate deterministic MAC address from UUID (same pattern as HAP external accessories)
        const advertiseAddress = generate(accessory.uuid)

        // For Matter, use the MAC without colons as uniqueId
        const uniqueId = advertiseAddress.replace(/:/g, '')

        // Allocate Matter port for the external Matter server
        const port = await this.externalPortService.requestMatterPort(uniqueId)
        if (!port) {
          log.error(`Failed to allocate Matter port for external Matter accessory ${accessory.displayName}`)
          log.error('Please configure matterPorts in config.json or free up ports in the default range (5530-5541)')
          continue
        }

        log.info(`Allocated port ${port} for external Matter accessory: ${accessory.displayName}`)

        // Normalize bind config to array format (inherit from main bridge)
        const networkInterfaces = this.config.bridge.bind
          ? Array.isArray(this.config.bridge.bind)
            ? this.config.bridge.bind
            : [this.config.bridge.bind]
          : undefined

        // Create dedicated Matter server for this accessory
        const matterServer = new MatterServer({
          port,
          uniqueId,
          storagePath: User.matterPath(),
          manufacturer: accessory.manufacturer,
          model: accessory.model,
          firmwareRevision: accessory.firmwareRevision,
          serialNumber: accessory.serialNumber || uniqueId, // use uniqueId as fallback serial number
          debugModeEnabled: this.options.debugModeEnabled,
          externalAccessory: true, // external accessory, added before server runs
          networkInterfaces,
        })

        // Start the Matter server (but don't run it yet due to externalAccessory mode)
        await matterServer.start()

        // Get plugin identifier from accessory
        const pluginIdentifier = (accessory as any)._associatedPlugin || 'unknown'

        // Register the accessory to this dedicated server
        await matterServer.registerPlatformAccessories(pluginIdentifier, 'ExternalMatter', [accessory])

        // Now run the server with the device already attached (required for external accessories)
        await matterServer.runServer()

        // Store the server instance
        this.externalMatterServers.set(accessory.uuid, matterServer)

        log.info(`✓ External Matter accessory published: ${accessory.displayName} on port ${port}`)

        // Log commissioning info
        const commissioningInfo = matterServer.getCommissioningInfo()
        if (commissioningInfo.qrCode && commissioningInfo.manualPairingCode) {
          log.info(`📱 Commissioning codes for ${accessory.displayName}:`)
          log.info(`   QR Code: ${commissioningInfo.qrCode}`)
          log.info(`   Manual Code: ${commissioningInfo.manualPairingCode}`)
        }
      } catch (error) {
        log.error(`Failed to publish external Matter accessory ${accessory.displayName}:`, error)
      }
    }
  }

  private handleRegisterPlatformAccessories(accessories: PlatformAccessory[]): void {
    // Route to HAP bridge
    this.bridgeService.handleRegisterPlatformAccessories(accessories)
  }

  private handleUnregisterPlatformAccessories(accessories: PlatformAccessory[]): void {
    // Route to HAP bridge
    this.bridgeService.handleUnregisterPlatformAccessories(accessories)
  }

  private handleRegisterMatterPlatformAccessories(pluginIdentifier: string, platformName: string, accessories: any[]): void {
    if (!this.matterServer) {
      log.warn('Cannot register Matter accessories - Matter server is not running')
      return
    }
    this.matterServer.registerPlatformAccessories(pluginIdentifier, platformName, accessories).catch((error) => {
      log.error(`Failed to register Matter accessories for ${pluginIdentifier}:`, error)
    })
  }

  private handleUnregisterMatterPlatformAccessories(pluginIdentifier: string, platformName: string, accessories: any[]): void {
    if (!this.matterServer) {
      log.warn('Cannot unregister Matter accessories - Matter server is not running')
      return
    }
    this.matterServer.unregisterPlatformAccessories(pluginIdentifier, platformName, accessories).catch((error) => {
      log.error(`Failed to unregister Matter accessories for ${pluginIdentifier}:`, error)
    })
  }

  private handleUpdateMatterAccessoryState(uuid: string, cluster: string, attributes: Record<string, any>, partId?: string): void {
    if (!this.matterServer) {
      log.warn('Cannot update Matter accessory state - Matter server is not running')
      return
    }
    this.matterServer.updateAccessoryState(uuid, cluster, attributes, partId).catch((error) => {
      log.error(`Failed to update Matter accessory state for ${uuid}:`, error)
    })
  }

  /**
   * Restore cached Matter accessories (matching HAP pattern)
   */
  private restoreCachedMatterAccessories(): void {
    if (!this.matterServer) {
      log.debug('Matter server not available for restoring cached accessories')
      return
    }

    const cachedAccessories = this.matterServer.getAllCachedAccessories()
    log.debug(`Restoring ${cachedAccessories.length} cached Matter accessories`)

    for (const cachedAccessory of cachedAccessories) {
      let plugin = this.pluginManager.getPlugin(cachedAccessory.plugin)

      if (!plugin) {
        try {
          // Try to find plugin by platform name (handles plugin renames)
          plugin = this.pluginManager.getPluginByActiveDynamicPlatform(cachedAccessory.platform)

          if (plugin) {
            log.info(`When searching for the associated plugin of the Matter accessory '${cachedAccessory.displayName}' `
              + `it seems like the plugin name changed from '${cachedAccessory.plugin}' to '${
                plugin.getPluginIdentifier()}'. Plugin association is now being transformed!`)
          }
        } catch (error: any) {
          log.warn(`Could not find the associated plugin for the Matter accessory '${cachedAccessory.displayName}'. `
            + `Tried to find the plugin by the platform name but ${error.message}`)
        }
      }

      const platformPlugin = plugin && plugin.getActiveDynamicPlatform(cachedAccessory.platform)

      if (!platformPlugin) {
        log.warn(`Failed to find plugin to handle Matter accessory ${cachedAccessory.displayName} (plugin: ${cachedAccessory.plugin}, platform: ${cachedAccessory.platform})`)
        // Note: Matter accessories are not added to the bridge here - they're registered via plugin's didFinishLaunching
        // The plugin can check if this accessory still exists and re-register or remove it
      } else {
        // Call configureMatterAccessory if the plugin implements it
        if (platformPlugin.configureMatterAccessory) {
          log.debug(`Calling configureMatterAccessory for ${cachedAccessory.displayName}`)
          platformPlugin.configureMatterAccessory(cachedAccessory)
        } else {
          log.debug(`Platform ${cachedAccessory.platform} does not implement configureMatterAccessory`)
        }
      }
    }
  }

  private static loadConfig(): HomebridgeConfig {
    // Look for the configuration file
    const configPath = User.configPath()

    const defaultBridge: BridgeConfiguration = {
      name: 'Homebridge',
      username: 'CC:22:3D:E3:CE:30',
      pin: '031-45-154',
    }

    if (!existsSync(configPath)) {
      log.warn('config.json (%s) not found.', configPath)
      return { // return a default configuration
        bridge: defaultBridge,
        accessories: [],
        platforms: [],
      }
    }

    let config: Partial<HomebridgeConfig>
    try {
      config = JSON.parse(readFileSync(configPath, { encoding: 'utf8' }))
    } catch (error: any) {
      log.error('There was a problem reading your config.json file.')
      log.error('Please try pasting your config.json file here to validate it: https://jsonlint.com')
      log.error('')
      throw error
    }

    if (config.ports !== undefined) {
      if (config.ports.start && config.ports.end) {
        if (config.ports.start > config.ports.end) {
          log.error('Invalid port pool configuration. End should be greater than or equal to start.')
          config.ports = undefined
        }
      } else {
        log.error('Invalid configuration for \'ports\'. Missing \'start\' and \'end\' properties! Ignoring it!')
        config.ports = undefined
      }
    }

    if (config.matterPorts !== undefined) {
      if (config.matterPorts.start && config.matterPorts.end) {
        if (config.matterPorts.start > config.matterPorts.end) {
          log.error('Invalid Matter port pool configuration. End should be greater than or equal to start.')
          config.matterPorts = undefined
        }
      } else {
        log.error('Invalid configuration for \'matterPorts\'. Missing \'start\' and \'end\' properties! Ignoring it!')
        config.matterPorts = undefined
      }
    }

    const bridge: BridgeConfiguration = config.bridge || defaultBridge
    bridge.name = bridge.name || defaultBridge.name
    bridge.username = bridge.username || defaultBridge.username
    bridge.pin = bridge.pin || defaultBridge.pin
    config.bridge = bridge

    const username = config.bridge.username
    if (!validMacAddress(username)) {
      throw new Error(`Not a valid username: ${username}. Must be 6 pairs of colon-separated hexadecimal chars (A-F 0-9), like a MAC address.`)
    }

    config.accessories = config.accessories || []
    config.platforms = config.platforms || []

    if (!Array.isArray(config.accessories)) {
      log.error('Value provided for accessories must be an array[]')
      config.accessories = []
    }

    if (!Array.isArray(config.platforms)) {
      log.error('Value provided for platforms must be an array[]')
      config.platforms = []
    }

    log.info('Loaded config.json with %s accessories and %s platforms.', config.accessories.length, config.platforms.length)

    // Validate Matter configuration for port conflicts
    if (config.bridge.matter || config.platforms.some((p: any) => p._bridge?.matter) || config.accessories.some((a: any) => a._bridge?.matter)) {
      // Validate main bridge Matter config
      if (config.bridge.matter) {
        const validation = MatterConfigValidator.validate(config.bridge.matter)
        if (!validation.isValid) {
          log.error('Main bridge Matter configuration is invalid. Matter will not be enabled for the main bridge.')
          delete config.bridge.matter
        }
      }

      // Validate all child bridge Matter configs and check for port conflicts
      const childMatterValidation = MatterConfigValidator.validateAllChildMatterConfigs(
        config.platforms as any[],
        config.accessories as any[],
      )

      if (!childMatterValidation.isValid) {
        log.error('Some child bridge Matter configurations are invalid. Check the errors above.')
      }

      // Additionally, check for conflicts between main bridge Matter port and child bridge ports
      if (config.bridge.matter?.port) {
        const mainMatterPort = config.bridge.matter.port
        const childMatterPorts: number[] = []

        for (const platform of config.platforms as any[]) {
          if (platform._bridge?.matter?.port) {
            childMatterPorts.push(platform._bridge.matter.port)
          }
        }

        for (const accessory of config.accessories as any[]) {
          if (accessory._bridge?.matter?.port) {
            childMatterPorts.push(accessory._bridge.matter.port)
          }
        }

        if (childMatterPorts.includes(mainMatterPort)) {
          log.error(`Main bridge Matter port ${mainMatterPort} conflicts with a child bridge Matter port. Please use unique ports.`)
        }

        // Check for conflict with main bridge HAP port
        if (config.bridge.port && Math.abs(config.bridge.port - mainMatterPort) < 10) {
          log.warn(`Main bridge HAP port ${config.bridge.port} and Matter port ${mainMatterPort} are very close. Consider spacing them further apart.`)
        }
      }
    }

    if (config.bridge.advertiser) {
      if (![
        MDNSAdvertiser.BONJOUR,
        MDNSAdvertiser.CIAO,
        MDNSAdvertiser.AVAHI,
        MDNSAdvertiser.RESOLVED,
      ].includes(config.bridge.advertiser)) {
        config.bridge.advertiser = undefined
        log.error('Value provided in bridge.advertiser is not valid, reverting to platform default.')
      }
    } else {
      config.bridge.advertiser = undefined
    }

    return config as HomebridgeConfig
  }

  private loadAccessories(): void {
    log.info(`Loading ${this.config.accessories.length} accessories...`)

    this.config.accessories.forEach((accessoryConfig, index) => {
      if (!accessoryConfig.accessory) {
        log.warn('Your config.json contains an illegal accessory configuration object at position %d. '
          + 'Missing property \'accessory\'. Skipping entry...', index + 1) // we rather count from 1 for the normal people?
        return
      }

      const accessoryIdentifier: AccessoryName | AccessoryIdentifier = accessoryConfig.accessory
      const displayName = accessoryConfig.name
      if (!displayName) {
        log.warn('Could not load accessory %s at position %d as it is missing the required \'name\' property!', accessoryIdentifier, index + 1)
        return
      }

      let plugin: Plugin
      let constructor: AccessoryPluginConstructor

      try {
        plugin = this.pluginManager.getPluginForAccessory(accessoryIdentifier)
      } catch (error: any) {
        log.error(error.message)
        return
      }

      // check the plugin is not disabled
      if (plugin.disabled) {
        log.warn(`Ignoring config for the accessory "${accessoryIdentifier}" in your config.json as the plugin "${plugin.getPluginIdentifier()}" has been disabled.`)
        return
      }

      try {
        constructor = plugin.getAccessoryConstructor(accessoryIdentifier)
      } catch (error: any) {
        log.error(`Error loading the accessory "${accessoryIdentifier}" requested in your config.json at position ${index + 1} - this is likely an issue with the "${plugin.getPluginIdentifier()}" plugin.`)
        log.error(error) // error message contains more information and full stack trace
        return
      }

      const logger = Logger.withPrefix(displayName)
      logger('Initializing %s accessory...', accessoryIdentifier)

      if (accessoryConfig._bridge) {
        // ensure the username is always uppercase
        accessoryConfig._bridge.username = accessoryConfig._bridge.username.toUpperCase()

        try {
          this.validateChildBridgeConfig(PluginType.ACCESSORY, accessoryIdentifier, accessoryConfig._bridge)
        } catch (error: any) {
          log.error(error.message)
          return
        }

        let childBridge: ChildBridgeService

        if (this.childBridges.has(accessoryConfig._bridge.username)) {
          childBridge = this.childBridges.get(accessoryConfig._bridge.username)!
          logger(`Adding to existing child bridge ${accessoryConfig._bridge.username}`)
        } else {
          logger(`Initializing child bridge ${accessoryConfig._bridge.username}`)
          childBridge = new ChildBridgeService(
            PluginType.ACCESSORY,
            accessoryIdentifier,
            plugin,
            accessoryConfig._bridge,
            this.config,
            this.options,
            this.api,
            this.ipcService,
            this.externalPortService,
          )

          this.childBridges.set(accessoryConfig._bridge.username, childBridge)
        }

        // add config to child bridge service
        childBridge.addConfig(accessoryConfig)

        return
      }

      const accessoryInstance: AccessoryPlugin = new constructor(logger, accessoryConfig, this.api)

      // pass accessoryIdentifier for UUID generation, and optional parameter uuid_base which can be used instead of displayName for UUID generation
      const accessory = this.bridgeService.createHAPAccessory(plugin, accessoryInstance, displayName, accessoryIdentifier, accessoryConfig.uuid_base)

      if (accessory) {
        try {
          this.bridgeService.bridge.addBridgedAccessory(accessory)
        } catch (error: any) {
          logger.error(`Error loading the accessory "${accessoryIdentifier}" from "${plugin.getPluginIdentifier()}" requested in your config.json:`, error.message)
        }
      } else {
        logger.info('Accessory %s returned empty set of services; not adding it to the bridge.', accessoryIdentifier)
      }
    })
  }

  private loadPlatforms(): Promise<void>[] {
    log.info(`Loading ${this.config.platforms.length} platforms...`)

    const promises: Promise<void>[] = []
    this.config.platforms.forEach((platformConfig, index) => {
      if (!platformConfig.platform) {
        log.warn('Your config.json contains an illegal platform configuration object at position %d. '
          + 'Missing property \'platform\'. Skipping entry...', index + 1) // we rather count from 1 for the normal people?
        return
      }

      const platformIdentifier: PlatformName | PlatformIdentifier = platformConfig.platform
      const displayName = platformConfig.name || platformIdentifier

      let plugin: Plugin
      let constructor: PlatformPluginConstructor

      // do not load homebridge-config-ui-x when running in service mode
      if (platformIdentifier === 'config' && process.env.UIX_SERVICE_MODE === '1') {
        return
      }

      try {
        plugin = this.pluginManager.getPluginForPlatform(platformIdentifier)
      } catch (error: any) {
        log.error(error.message)
        return
      }

      // check the plugin is not disabled
      if (plugin.disabled) {
        log.warn(`Ignoring config for the platform "${platformIdentifier}" in your config.json as the plugin "${plugin.getPluginIdentifier()}" has been disabled.`)
        return
      }

      try {
        constructor = plugin.getPlatformConstructor(platformIdentifier)
      } catch (error: any) {
        log.error(`Error loading the platform "${platformIdentifier}" requested in your config.json at position ${index + 1} - this is likely an issue with the "${plugin.getPluginIdentifier()}" plugin.`)
        log.error(error) // error message contains more information and full stack trace
        return
      }

      const logger = Logger.withPrefix(displayName)
      logger('Initializing %s platform...', platformIdentifier)

      if (platformConfig._bridge) {
        // ensure the username is always uppercase
        platformConfig._bridge.username = platformConfig._bridge.username.toUpperCase()

        try {
          this.validateChildBridgeConfig(PluginType.PLATFORM, platformIdentifier, platformConfig._bridge)
        } catch (error: any) {
          log.error(error.message)
          return
        }

        logger(`Initializing child bridge ${platformConfig._bridge.username}`)
        const childBridge = new ChildBridgeService(
          PluginType.PLATFORM,
          platformIdentifier,
          plugin,
          platformConfig._bridge,
          this.config,
          this.options,
          this.api,
          this.ipcService,
          this.externalPortService,
        )

        this.childBridges.set(platformConfig._bridge.username, childBridge)

        // add config to child bridge service
        childBridge.addConfig(platformConfig)
        return
      }

      const platform: PlatformPlugin = new constructor(logger, platformConfig, this.api)

      if (HomebridgeAPI.isDynamicPlatformPlugin(platform)) {
        plugin.assignDynamicPlatform(platformIdentifier, platform)
      } else if (HomebridgeAPI.isStaticPlatformPlugin(platform)) { // Plugin 1.0, load accessories
        promises.push(this.bridgeService.loadPlatformAccessories(plugin, platform, platformIdentifier, logger))
      } else {
        // otherwise it's a IndependentPlatformPlugin which doesn't expose any methods at all.
        // We just call the constructor and let it be enabled.
      }
    })

    return promises
  }

  /**
   * Validate an external bridge config
   */
  private validateChildBridgeConfig(type: PluginType, identifier: string, bridgeConfig: BridgeConfiguration): void {
    // All child bridges require username
    if (!bridgeConfig.username) {
      throw new Error(
        `Error loading the ${type} "${identifier}" requested in your config.json - `
        + 'Missing required field "_bridge.username".',
      )
    }

    if (!validMacAddress(bridgeConfig.username)) {
      throw new Error(
        `Error loading the ${type} "${identifier}" requested in your config.json - `
        + `not a valid username in _bridge.username: "${bridgeConfig.username}". Must be 6 pairs of colon-separated hexadecimal chars (A-F 0-9), like a MAC address.`,
      )
    }

    if (this.childBridges.has(bridgeConfig.username)) {
      const childBridge = this.childBridges.get(bridgeConfig.username)
      if (type === PluginType.PLATFORM) {
        // only a single platform can exist on one child bridge
        throw new Error(
          `Error loading the ${type} "${identifier}" requested in your config.json - `
          + `Duplicate username found in _bridge.username: "${bridgeConfig.username}". Each platform child bridge must have it's own unique username.`,
        )
      } else if (childBridge?.identifier !== identifier) {
        // only accessories of the same type can be added to the same child bridge
        throw new Error(
          `Error loading the ${type} "${identifier}" requested in your config.json - `
          + `Duplicate username found in _bridge.username: "${bridgeConfig.username}". You can only group accessories of the same type in a child bridge.`,
        )
      }
    }

    if (bridgeConfig.username === this.config.bridge.username.toUpperCase()) {
      throw new Error(
        `Error loading the ${type} "${identifier}" requested in your config.json - `
        + `Username found in _bridge.username: "${bridgeConfig.username}" is the same as the main bridge. Each child bridge platform/accessory must have it's own unique username.`,
      )
    }
  }

  /**
   * Takes care of the IPC Events sent to Homebridge
   */
  private initializeIpcEventHandlers() {
    // start ipc service
    this.ipcService.start()

    // handle restart child bridge event
    this.ipcService.on(IpcIncomingEvent.RESTART_CHILD_BRIDGE, (username) => {
      // noinspection SuspiciousTypeOfGuard
      if (typeof username === 'string') {
        const childBridge = this.childBridges.get(username.toUpperCase())
        childBridge?.restartChildBridge()
      }
    })

    // handle stop child bridge event
    this.ipcService.on(IpcIncomingEvent.STOP_CHILD_BRIDGE, (username) => {
      // noinspection SuspiciousTypeOfGuard
      if (typeof username === 'string') {
        const childBridge = this.childBridges.get(username.toUpperCase())
        childBridge?.stopChildBridge()
      }
    })

    // handle start child bridge event
    this.ipcService.on(IpcIncomingEvent.START_CHILD_BRIDGE, (username) => {
      // noinspection SuspiciousTypeOfGuard
      if (typeof username === 'string') {
        const childBridge = this.childBridges.get(username.toUpperCase())
        childBridge?.startChildBridge()
      }
    })

    this.ipcService.on(IpcIncomingEvent.CHILD_BRIDGE_METADATA_REQUEST, () => {
      this.ipcService.sendMessage(
        IpcOutgoingEvent.CHILD_BRIDGE_METADATA_RESPONSE,
        Array.from(this.childBridges.values()).map(x => x.getMetadata()),
      )
    })
  }

  private printSetupInfo(pin: string): void {
    /* eslint-disable no-console */
    console.log('Setup Payload:')
    console.log(this.bridgeService.bridge.setupURI())

    if (!this.options.hideQRCode) {
      console.log('Scan this code with your HomeKit app on your iOS device to pair with Homebridge:')
      qrcode.setErrorLevel('M') // HAP specifies level M or higher for ECC
      qrcode.generate(this.bridgeService.bridge.setupURI())
      console.log('Or enter this code with your HomeKit app on your iOS device to pair with Homebridge:')
    } else {
      console.log('Enter this code with your HomeKit app on your iOS device to pair with Homebridge:')
    }

    console.log(chalk.black.bgWhite('                       '))
    console.log(chalk.black.bgWhite('    ┌────────────┐     '))
    console.log(chalk.black.bgWhite(`    │ ${pin} │     `))
    console.log(chalk.black.bgWhite('    └────────────┘     '))
    console.log(chalk.black.bgWhite('                       '))
    /* eslint-enable no-console */
  }
}
