/* global NodeJS */

import type { MacAddress } from 'hap-nodejs'

import type { AccessoryPlugin, PlatformPlugin } from './api.js'
import type {
  AccessoryConfig,
  BridgeConfiguration,
  BridgeOptions,
  PlatformConfig,
} from './bridgeService.js'
import type {
  ChildBridgePairedStatusEventData,
  ChildProcessLoadEventData,
  ChildProcessMessageEvent,
  ChildProcessPluginLoadedEventData,
  ChildProcessPortAllocatedEventData,
  ChildProcessPortRequestEventData,
} from './childBridgeService.js'
import type { MatterConfig } from './matter/index.js'
import type { Plugin } from './plugin.js'

import process from 'node:process'

import { AccessoryEventTypes, HAPStorage } from 'hap-nodejs'

import { HomebridgeAPI, InternalAPIEvent, PluginType } from './api.js'
import { BridgeService } from './bridgeService.js'
import { ChildProcessMessageEventType } from './childBridgeService.js'
import { ChildBridgeExternalPortService } from './externalPortService.js'
import { Logger } from './logger.js'
import { MatterServer } from './matter/index.js'
import { PluginManager } from './pluginManager.js'
import { User } from './user.js'
import { generate } from './util/mac.js'

import 'source-map-support/register.js'

/**
 * This is a standalone script executed as a child process fork
 */

process.title = 'homebridge: child bridge'

export class ChildBridgeFork {
  private bridgeService!: BridgeService
  private api!: HomebridgeAPI
  private pluginManager!: PluginManager
  private externalPortService!: ChildBridgeExternalPortService
  private matterServer?: MatterServer

  // External Matter servers for accessories that need their own bridge
  private readonly externalMatterServers: Map<string, MatterServer> = new Map()

  private matterConfig?: MatterConfig
  private matterSerialNumber?: string

  private type!: PluginType
  private plugin!: Plugin
  private identifier!: string
  private pluginConfig!: Array<PlatformConfig | AccessoryConfig>
  private bridgeConfig!: BridgeConfiguration
  private bridgeOptions!: BridgeOptions

  private portRequestCallback: Map<MacAddress, (port: number | undefined) => void> = new Map()

  constructor() {
    // tell the parent process we are ready to accept plugin config
    this.sendMessage(ChildProcessMessageEventType.READY)
  }

  sendMessage<T = unknown>(type: ChildProcessMessageEventType, data?: T): void {
    if (process.send) {
      process.send({
        id: type,
        data,
      })
    }
  }

  async loadPlugin(data: ChildProcessLoadEventData): Promise<void> {
    // set data
    this.type = data.type
    this.identifier = data.identifier
    this.pluginConfig = data.pluginConfig
    this.bridgeConfig = data.bridgeConfig
    this.bridgeOptions = data.bridgeOptions

    // remove the _bridge key (some plugins do not like unknown config)
    for (const config of this.pluginConfig) {
      delete config._bridge
    }

    // set bridge settings (inherited from main bridge)
    if (this.bridgeOptions.noLogTimestamps) {
      Logger.setTimestampEnabled(false)
    }

    if (this.bridgeOptions.debugModeEnabled) {
      Logger.setDebugEnabled(true)
    }

    if (this.bridgeOptions.forceColourLogging) {
      Logger.forceColor()
    }

    if (this.bridgeOptions.customStoragePath) {
      User.setStoragePath(this.bridgeOptions.customStoragePath)
    }

    // Initialize HAP-NodeJS with a custom persist directory
    HAPStorage.setCustomStoragePath(User.persistPath())

    // load api
    this.api = new HomebridgeAPI()
    this.pluginManager = new PluginManager(this.api)
    this.externalPortService = new ChildBridgeExternalPortService(this)

    // load plugin
    this.plugin = this.pluginManager.loadPlugin(data.pluginPath)
    await this.plugin.load()
    await this.pluginManager.initializePlugin(this.plugin, data.identifier)

    // change process title to include plugin name
    process.title = `homebridge: ${this.plugin.getPluginIdentifier()}`

    this.sendMessage<ChildProcessPluginLoadedEventData>(ChildProcessMessageEventType.LOADED, {
      version: this.plugin.version,
    })
  }

  async startBridge(): Promise<void> {
    // Check if Matter is configured
    this.matterConfig = this.bridgeConfig.matter

    // Initialize Matter if it's configured
    if (this.matterConfig) {
      Logger.internal.debug('Child bridge has Matter config (Combined HAP+Matter), starting Matter server')

      // If Matter doesn't have a port configured, allocate one
      if (!this.matterConfig.port) {
        // Generate a unique username for Matter port allocation
        const matterUsername = `${this.bridgeConfig.username}:MATTER` as MacAddress
        const matterPort = await this.externalPortService.requestPort(matterUsername)

        if (!matterPort) {
          throw new Error(
            'Failed to allocate Matter port for child bridge. '
            + 'Please specify a port manually in the _bridge.matter configuration, or free up ports in the configured range.',
          )
        }

        this.matterConfig.port = matterPort
        Logger.internal.debug(`Allocated Matter port: ${this.matterConfig.port} (HAP port: ${this.bridgeConfig.port})`)
      }

      // Start Matter server
      await this.startMatterServer(this.matterConfig)
      // Unified status with both HAP and Matter info will be sent when HAP bridge is advertised
    }

    this.bridgeService = new BridgeService(
      this.api,
      this.pluginManager,
      this.externalPortService,
      this.bridgeOptions,
      this.bridgeConfig,
    )

    // watch bridge events to check when server is online
    this.bridgeService.bridge.on(AccessoryEventTypes.ADVERTISED, () => {
      this.sendPairedStatusEvent()
    })

    // watch for the paired event to update the server status
    this.bridgeService.bridge.on(AccessoryEventTypes.PAIRED, () => {
      this.sendPairedStatusEvent()
    })

    // watch for the unpaired event to update the server status
    this.bridgeService.bridge.on(AccessoryEventTypes.UNPAIRED, () => {
      this.sendPairedStatusEvent()
    })

    // load the cached accessories
    await this.bridgeService.loadCachedPlatformAccessoriesFromDisk()

    for (const config of this.pluginConfig) {
      if (this.type === PluginType.PLATFORM) {
        const plugin = this.pluginManager.getPluginForPlatform(this.identifier)
        const displayName = config.name || plugin.getPluginIdentifier()
        const logger = Logger.withPrefix(displayName)
        const constructor = plugin.getPlatformConstructor(this.identifier)
        const platform: PlatformPlugin = new constructor(logger, config as PlatformConfig, this.api)

        if (HomebridgeAPI.isDynamicPlatformPlugin(platform)) {
          plugin.assignDynamicPlatform(this.identifier, platform)
        } else if (HomebridgeAPI.isStaticPlatformPlugin(platform)) { // Plugin 1.0, load accessories
          await this.bridgeService.loadPlatformAccessories(plugin, platform, this.identifier, logger)
        } else {
          // otherwise it's a IndependentPlatformPlugin which doesn't expose any methods at all.
          // We just call the constructor and let it be enabled.
        }
      } else if (this.type === PluginType.ACCESSORY) {
        const plugin = this.pluginManager.getPluginForAccessory(this.identifier)
        const displayName = config.name

        if (!displayName) {
          Logger.internal.warn('Could not load accessory %s as it is missing the required \'name\' property!', this.identifier)
          return
        }

        const logger = Logger.withPrefix(displayName)
        const constructor = plugin.getAccessoryConstructor(this.identifier)
        const accessoryInstance: AccessoryPlugin = new constructor(logger, config as AccessoryConfig, this.api)

        // pass accessoryIdentifier for UUID generation, and optional parameter uuid_base which can be used instead of displayName for UUID generation
        const accessory = this.bridgeService.createHAPAccessory(plugin, accessoryInstance, displayName, this.identifier, config.uuid_base)

        if (accessory) {
          this.bridgeService.bridge.addBridgedAccessory(accessory)
        } else {
          logger('Accessory %s returned empty set of services. Won\'t adding it to the bridge!', this.identifier)
        }
      }
    }

    // restore the cached accessories
    this.bridgeService.restoreCachedPlatformAccessories()

    // Only restore Matter accessories if Matter is enabled for this bridge
    if (this.matterServer) {
      this.restoreCachedMatterAccessories()
    }

    this.bridgeService.publishBridge()
    this.api.signalFinished()

    // tell the parent we are online
    this.sendMessage(ChildProcessMessageEventType.ONLINE)
  }

  /**
   * Request the next available external HAP port from the parent process
   * @param username
   */
  public async requestExternalPort(username: MacAddress): Promise<number | undefined> {
    return new Promise((resolve) => {
      const requestTimeout = setTimeout(() => {
        Logger.internal.warn('Parent process did not respond to port allocation request within 5 seconds - assigning random port.')
        resolve(undefined)
      }, 5000)

      // setup callback
      const callback = (port: number | undefined) => {
        clearTimeout(requestTimeout)
        resolve(port)
        this.portRequestCallback.delete(username)
      }
      this.portRequestCallback.set(username, callback)

      // send port request
      this.sendMessage<ChildProcessPortRequestEventData>(ChildProcessMessageEventType.PORT_REQUEST, { username })
    })
  }

  /**
   * Request the next available Matter port from the parent process
   * @param uniqueId - MAC-derived identifier (without colons)
   */
  public async requestMatterPort(uniqueId: string): Promise<number | undefined> {
    return new Promise((resolve) => {
      const requestTimeout = setTimeout(() => {
        Logger.internal.warn('Parent process did not respond to Matter port allocation request within 5 seconds - assigning random port.')
        resolve(undefined)
      }, 5000)

      // Use uniqueId as the key for the callback map
      const mac = uniqueId as MacAddress

      // setup callback
      const callback = (port: number | undefined) => {
        clearTimeout(requestTimeout)
        resolve(port)
        this.portRequestCallback.delete(mac)
      }
      this.portRequestCallback.set(mac, callback)

      // send Matter port request
      this.sendMessage<ChildProcessPortRequestEventData>(ChildProcessMessageEventType.PORT_REQUEST, {
        username: mac,
        portType: 'matter',
      })
    })
  }

  /**
   * Handles the port allocation response message from the parent process
   * @param data
   */
  public handleExternalResponse(data: ChildProcessPortAllocatedEventData): void {
    const callback = this.portRequestCallback.get(data.username)
    if (callback) {
      callback(data.port)
    }
  }

  /**
   * Sends the current pairing status of the child bridge to the parent process
   */
  public sendPairedStatusEvent() {
    // Get Matter commissioning info if Matter is configured
    let matterInfo
    if (this.matterConfig && this.matterServer) {
      const commissioningInfo = this.matterServer.getCommissioningInfo()
      matterInfo = {
        qrCode: commissioningInfo.qrCode,
        manualPairingCode: commissioningInfo.manualPairingCode,
        serialNumber: this.matterSerialNumber || commissioningInfo.serialNumber,
        commissioned: commissioningInfo.commissioned || false,
        deviceCount: this.matterServer.getAccessories().length,
      }
      Logger.internal.debug('Including Matter info in unified status update')
    }

    this.sendMessage<ChildBridgePairedStatusEventData>(ChildProcessMessageEventType.STATUS_UPDATE, {
      paired: this.bridgeService?.bridge?._accessoryInfo?.paired() ?? null,
      setupUri: this.bridgeService?.bridge?.setupURI() ?? null,
      // Include Matter commissioning info in unified message
      ...(matterInfo && { matter: matterInfo }),
    } as any)
  }

  /**
   * Restore cached Matter accessories
   */
  private restoreCachedMatterAccessories(): void {
    if (!this.matterServer) {
      Logger.internal.debug('Matter server not available for restoring cached accessories')
      return
    }

    const cachedAccessories = this.matterServer.getAllCachedAccessories()
    Logger.internal.debug(`Restoring ${cachedAccessories.length} cached Matter accessories`)

    for (const cachedAccessory of cachedAccessories) {
      let plugin = this.pluginManager.getPlugin(cachedAccessory.plugin)

      if (!plugin) {
        try {
          // Try to find plugin by platform name (handles plugin renames)
          plugin = this.pluginManager.getPluginByActiveDynamicPlatform(cachedAccessory.platform)

          if (plugin) {
            Logger.internal.info(`When searching for the associated plugin of the Matter accessory '${cachedAccessory.displayName}' `
              + `it seems like the plugin name changed from '${cachedAccessory.plugin}' to '${
                plugin.getPluginIdentifier()}'. Plugin association is now being transformed!`)
          }
        } catch (error: any) {
          Logger.internal.warn(`Could not find the associated plugin for the Matter accessory '${cachedAccessory.displayName}'. `
            + `Tried to find the plugin by the platform name but ${error.message}`)
        }
      }

      const platformPlugin = plugin && plugin.getActiveDynamicPlatform(cachedAccessory.platform)

      if (!platformPlugin) {
        Logger.internal.warn(`Failed to find plugin to handle Matter accessory ${cachedAccessory.displayName} (plugin: ${cachedAccessory.plugin}, platform: ${cachedAccessory.platform})`)
        // Note: Matter accessories are not added to the bridge here - they're registered via plugin's didFinishLaunching
        // The plugin can check if this accessory still exists and re-register or remove it
      } else {
        // Call configureMatterAccessory if the plugin implements it
        if (platformPlugin.configureMatterAccessory) {
          Logger.internal.debug(`Calling configureMatterAccessory for ${cachedAccessory.displayName}`)
          platformPlugin.configureMatterAccessory(cachedAccessory)
        } else {
          Logger.internal.debug(`Platform ${cachedAccessory.platform} does not implement configureMatterAccessory`)
        }
      }
    }
  }

  /**
   * Start Matter server for child bridge
   */
  private async startMatterServer(matterConfig: MatterConfig): Promise<void> {
    Logger.internal.info('Starting Matter server in child bridge process')

    // Create Matter server with the provided configuration
    const serialNumber = this.bridgeConfig.username.replace(/:/g, '')

    // Normalize bind config to array format
    const networkInterfaces = this.bridgeConfig.bind
      ? Array.isArray(this.bridgeConfig.bind)
        ? this.bridgeConfig.bind
        : [this.bridgeConfig.bind]
      : undefined

    this.matterServer = new MatterServer({
      port: matterConfig.port || 5540,
      uniqueId: serialNumber,
      storagePath: User.matterPath(),
      debugModeEnabled: this.bridgeOptions.debugModeEnabled,
      manufacturer: this.bridgeConfig.manufacturer,
      model: this.bridgeConfig.model,
      firmwareRevision: this.bridgeConfig.firmwareRevision,
      serialNumber,
      networkInterfaces,
    })

    await this.matterServer.start()

    // Inform the API that Matter is enabled
    this.api._setMatterEnabled(true)

    // Set the Matter server reference for API methods like getAccessoryState
    this.api._setMatterServer(this.matterServer)

    const commissioningInfo = this.matterServer.getCommissioningInfo()
    Logger.internal.info('Matter server started with commissioning info:', commissioningInfo)

    // Store the serial number for status updates
    this.matterSerialNumber = commissioningInfo.serialNumber

    // Listen for Matter commissioning events to update status
    this.matterServer.on('commissioning-changed', (commissioned: boolean, fabricCount: number) => {
      Logger.internal.info(`Matter commissioning state changed: commissioned=${commissioned}, fabricCount=${fabricCount}`)
      this.sendPairedStatusEvent()
    })

    // Set up event listeners for Matter API calls
    this.api.on(InternalAPIEvent.PUBLISH_EXTERNAL_MATTER_ACCESSORIES, (accessories: any[]) => {
      this.handlePublishExternalMatterAccessories(accessories).catch((error) => {
        Logger.internal.error('Failed to publish external Matter accessories:', error)
      })
    })
    this.api.on(InternalAPIEvent.REGISTER_MATTER_PLATFORM_ACCESSORIES, (pluginIdentifier: string, platformName: string, accessories: any[]) => {
      if (this.matterServer) {
        this.matterServer.registerPlatformAccessories(pluginIdentifier, platformName, accessories).catch((error) => {
          Logger.internal.error(`Failed to register Matter accessories for ${pluginIdentifier}:`, error)
        })
      }
    })
    this.api.on(InternalAPIEvent.UNREGISTER_MATTER_PLATFORM_ACCESSORIES, (pluginIdentifier: string, platformName: string, accessories: any[]) => {
      if (this.matterServer) {
        this.matterServer.unregisterPlatformAccessories(pluginIdentifier, platformName, accessories).catch((error) => {
          Logger.internal.error(`Failed to unregister Matter accessories for ${pluginIdentifier}:`, error)
        })
      }
    })
    this.api.on(InternalAPIEvent.UPDATE_MATTER_ACCESSORY_STATE, (uuid: string, cluster: string, attributes: Record<string, any>, partId?: string) => {
      // Check if this is an external accessory first (each has its own MatterServer)
      if (this.externalMatterServers.has(uuid)) {
        const externalServer = this.externalMatterServers.get(uuid)!
        externalServer.updateAccessoryState(uuid, cluster, attributes, partId).catch((error) => {
          Logger.internal.error(`Failed to update Matter accessory state for external accessory ${uuid}:`, error)
        })
      } else if (this.matterServer) {
        // Otherwise, try the main child bridge Matter server
        this.matterServer.updateAccessoryState(uuid, cluster, attributes, partId).catch((error) => {
          Logger.internal.error(`Failed to update Matter accessory state for ${uuid}:`, error)
        })
      }
    })
  }

  /**
   * Handle external Matter accessories - each gets its own dedicated Matter server
   * This is required for devices like Robotic Vacuum Cleaners that Apple Home
   * requires to be on their own bridge.
   */
  private async handlePublishExternalMatterAccessories(accessories: any[]): Promise<void> {
    Logger.internal.info(`Publishing ${accessories.length} external Matter accessor${accessories.length === 1 ? 'y' : 'ies'} from child bridge`)

    for (const accessory of accessories) {
      try {
        // Validate accessory has required fields
        if (!accessory.uuid) {
          Logger.internal.error('External Matter accessory missing UUID - skipping')
          continue
        }

        if (!accessory.displayName) {
          Logger.internal.error(`External Matter accessory ${accessory.uuid} missing displayName - skipping`)
          continue
        }

        // Check if already published
        if (this.externalMatterServers.has(accessory.uuid)) {
          Logger.internal.warn(`External Matter accessory ${accessory.displayName} (${accessory.uuid}) is already published`)
          continue
        }

        // Generate deterministic MAC address from UUID (same pattern as HAP external accessories)
        const advertiseAddress = generate(accessory.uuid)

        // For Matter, use the MAC without colons as uniqueId
        const uniqueId = advertiseAddress.replace(/:/g, '')

        // Allocate Matter port from parent process via IPC
        const port = await this.externalPortService.requestMatterPort(uniqueId)
        if (!port) {
          Logger.internal.error(`Failed to allocate Matter port for external Matter accessory ${accessory.displayName}`)
          Logger.internal.error('Please configure matterPorts in config.json or free up ports in the default range (5530-5541)')
          continue
        }

        Logger.internal.info(`Allocated port ${port} for external Matter accessory: ${accessory.displayName}`)

        // Normalize bind config to array format (inherit from bridge)
        const networkInterfaces = this.bridgeConfig.bind
          ? Array.isArray(this.bridgeConfig.bind)
            ? this.bridgeConfig.bind
            : [this.bridgeConfig.bind]
          : undefined

        // Create dedicated Matter server for this accessory
        const matterServer = new MatterServer({
          port,
          uniqueId,
          storagePath: User.matterPath(),
          manufacturer: accessory.manufacturer,
          model: accessory.model,
          firmwareRevision: accessory.firmwareRevision,
          serialNumber: accessory.serialNumber || uniqueId, // Use uniqueId as fallback serial number
          debugModeEnabled: this.bridgeOptions.debugModeEnabled,
          externalAccessory: true, // external accessory, so added before server runs
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

        Logger.internal.info(`✓ External Matter accessory published: ${accessory.displayName} on port ${port}`)

        // Log commissioning info
        const commissioningInfo = matterServer.getCommissioningInfo()
        if (commissioningInfo.qrCode && commissioningInfo.manualPairingCode) {
          Logger.internal.info(`📱 Commissioning codes for ${accessory.displayName}:`)
          Logger.internal.info(`   QR Code: ${commissioningInfo.qrCode}`)
          Logger.internal.info(`   Manual Code: ${commissioningInfo.manualPairingCode}`)
        }
      } catch (error) {
        Logger.internal.error(`Failed to publish external Matter accessory ${accessory.displayName}:`, error)
      }
    }
  }

  /**
   * Handle metadata request from parent process
   * Sends unified HAP+Matter status
   */
  public handleMetadataRequest(): void {
    // Send unified status with both HAP and Matter information
    this.sendPairedStatusEvent()
  }

  shutdown(): void {
    this.bridgeService.teardown()

    // Stop main Matter server if it was initialized
    if (this.matterServer && typeof this.matterServer.stop === 'function') {
      Logger.internal.debug('Stopping Matter server')
      this.matterServer.stop().catch((error: any) => {
        Logger.internal.error('Error stopping Matter server:', error)
      })
    }

    // Stop all external Matter servers
    for (const [uuid, matterServer] of this.externalMatterServers) {
      Logger.internal.debug(`Stopping external Matter server for ${uuid}`)
      matterServer.stop().catch((error: any) => {
        Logger.internal.error(`Error stopping external Matter server for ${uuid}:`, error)
      })
    }
    this.externalMatterServers.clear()
  }
}

/**
 * Start Self
 */
const childPluginFork = new ChildBridgeFork()

/**
 * Handle incoming IPC messages from the parent Homebridge process
 */
process.on('message', (message: ChildProcessMessageEvent<unknown>) => {
  if (typeof message !== 'object' || !message.id) {
    return
  }

  switch (message.id) {
    case ChildProcessMessageEventType.LOAD: {
      childPluginFork.loadPlugin(message.data as ChildProcessLoadEventData)
      break
    }
    case ChildProcessMessageEventType.START: {
      childPluginFork.startBridge()
      break
    }
    case ChildProcessMessageEventType.PORT_ALLOCATED: {
      childPluginFork.handleExternalResponse(message.data as ChildProcessPortAllocatedEventData)
      break
    }
  }
})

/**
 * Handle the sigterm shutdown signals
 */
let shuttingDown = false
function signalHandler(signal: NodeJS.Signals, signalNum: number): void {
  if (shuttingDown) {
    return
  }
  shuttingDown = true

  Logger.internal.info('Got %s, shutting down child bridge process...', signal)

  try {
    childPluginFork.shutdown()
  } catch (error: any) {
    // do nothing
  }

  setTimeout(() => process.exit(128 + signalNum), 5000)
}

process.on('SIGINT', signalHandler.bind(undefined, 'SIGINT', 2))
process.on('SIGTERM', signalHandler.bind(undefined, 'SIGTERM', 15))

/**
 * Ensure orphaned processes are cleaned up
 */
setInterval(() => {
  if (!process.connected) {
    Logger.internal.info('Parent process not connected, terminating process...')
    process.exit(1)
  }
}, 5000)
