/**
 * Custom Matter Behavior Classes for Homebridge
 *
 * These custom behaviors extend the base Matter.js behaviors and override
 * command methods to allow plugins to inject custom handlers.
 *
 * Note: Only clusters with user-triggered commands need custom behaviors.
 * Read-only clusters (like sensors) don't need custom behaviors since
 * they only report state, they don't receive commands.
 */

import type { MaybePromise } from '@matter/main'
import type {
  ColorControl,
  Identify,
  LevelControl,
  ServiceArea,
  Thermostat,
  WindowCovering,
} from '@matter/main/clusters'

import type { MatterAccessoryMap, MatterCommandHandler } from './matterTypes.js'

import {
  ColorControlServer,
  DoorLockServer,
  FanControlServer,
  IdentifyServer,
  LevelControlServer,
  OnOffServer,
  RvcCleanModeServer,
  RvcOperationalStateServer,
  RvcRunModeServer,
  ServiceAreaServer,
  ThermostatServer,
  WindowCoveringBaseServer,
} from '@matter/main/behaviors'
import { RvcOperationalState } from '@matter/main/clusters'

import { Logger } from '../logger.js'
import { clusterNames } from './matterTypes.js'

const log = Logger.withPrefix('Matter/Behaviours')

/**
 * Result type for Matter commands
 * MaybePromise allows both sync and async returns, matching Matter.js base classes
 */
type MatterCommandResult = MaybePromise<void>

/**
 * Command names for each cluster
 * Provides type safety and autocomplete for command names
 */
const commandNames = {
  OnOff: {
    on: 'on',
    off: 'off',
    toggle: 'toggle',
  },
  LevelControl: {
    moveToLevel: 'moveToLevel',
    moveToLevelWithOnOff: 'moveToLevelWithOnOff',
    move: 'move',
    step: 'step',
    stop: 'stop',
  },
  WindowCovering: {
    upOrOpen: 'upOrOpen',
    downOrClose: 'downOrClose',
    stopMotion: 'stopMotion',
    goToLiftPercentage: 'goToLiftPercentage',
    goToTiltPercentage: 'goToTiltPercentage',
  },
  FanControl: {
    step: 'step',
    fanModeChange: 'fanModeChange',
    percentSettingChange: 'percentSettingChange',
  },
  DoorLock: {
    lockDoor: 'lockDoor',
    unlockDoor: 'unlockDoor',
  },
  Thermostat: {
    setpointRaiseLower: 'setpointRaiseLower',
    systemModeChange: 'systemModeChange',
    occupiedHeatingSetpointChange: 'occupiedHeatingSetpointChange',
    occupiedCoolingSetpointChange: 'occupiedCoolingSetpointChange',
  },
  Identify: {
    identify: 'identify',
  },
  ColorControl: {
    moveToColorTemperatureLogic: 'moveToColorTemperatureLogic',
    moveToHueAndSaturationLogic: 'moveToHueAndSaturationLogic',
    moveToColorLogic: 'moveToColorLogic',
    moveToHueLogic: 'moveToHueLogic',
    moveToSaturationLogic: 'moveToSaturationLogic',
    stopAllColorMovement: 'stopAllColorMovement',
  },
  RvcOperationalState: {
    pause: 'pause',
    resume: 'resume',
    goHome: 'goHome',
  },
  RvcRunMode: {
    changeToMode: 'changeToMode',
  },
  RvcCleanMode: {
    changeToMode: 'changeToMode',
  },
  ServiceArea: {
    selectAreas: 'selectAreas',
    skipArea: 'skipArea',
  },
} as const

/**
 * Store for custom handlers
 * Maps endpoint ID -> cluster name -> command name -> handler
 */
const handlerStore = new Map<string, Map<string, Map<string, MatterCommandHandler>>>()

/**
 * Store for accessory references
 * This allows handlers to update cached clusters after state changes
 */
let accessoriesMap: MatterAccessoryMap | null = null

/**
 * Mapping of endpoint IDs to their parent UUID and part ID (for composed devices)
 * Format: Map<endpointId, { parentUuid: string, partId: string }>
 */
const partEndpointMap = new Map<string, { parentUuid: string, partId: string }>()

/**
 * Set the accessories map reference for cache syncing
 */
export function setAccessoriesMap(map: MatterAccessoryMap): void {
  accessoriesMap = map
}

/**
 * Register a part endpoint mapping
 * This associates a part endpoint ID with its parent accessory UUID and part ID
 *
 * @param endpointId - The endpoint ID (e.g., '{parentUuid}-part-{partId}')
 * @param parentUuid - The parent accessory UUID
 * @param partId - The part identifier within the parent
 */
export function registerPartEndpoint(endpointId: string, parentUuid: string, partId: string): void {
  partEndpointMap.set(endpointId, { parentUuid, partId })
  log.debug(`Registered part endpoint mapping: ${endpointId} -> parent=${parentUuid}, partId=${partId}`)
}

/**
 * Sync endpoint state back to cached clusters
 * Ensures state changes from handlers persist across restarts
 *
 * @param endpointId - Unique endpoint identifier (accessory UUID)
 * @param clusterName - Name of the Matter cluster
 * @param attributes - Cluster attributes to sync
 */
function syncEndpointStateToCache(endpointId: string, clusterName: string, attributes: Record<string, unknown>): void {
  if (!accessoriesMap) {
    return
  }

  const accessory = accessoriesMap.get(endpointId)
  if (!accessory || !accessory.clusters) {
    return
  }

  // Update the cached clusters with the new state
  if (!accessory.clusters[clusterName]) {
    accessory.clusters[clusterName] = {}
  }
  accessory.clusters[clusterName] = {
    ...accessory.clusters[clusterName],
    ...attributes,
  }

  log.debug(`Synced ${clusterName} state to cache for ${endpointId}:`, attributes)
}

/**
 * Register a handler for a specific endpoint/cluster/command
 *
 * @param endpointId - Unique endpoint identifier (typically the accessory UUID)
 * @param clusterName - Name of the Matter cluster (e.g., 'onOff', 'levelControl')
 * @param commandName - Name of the command method (e.g., 'on', 'off', 'moveToLevel')
 * @param handler - Callback function to execute when the command is received
 *
 * @example
 * ```typescript
 * registerHandler('my-light-uuid', 'onOff', 'on', async () => {
 *   console.log('Light turned on!')
 * })
 * ```
 */
export function registerHandler(
  endpointId: string,
  clusterName: string,
  commandName: string,
  handler: MatterCommandHandler,
) {
  if (!handlerStore.has(endpointId)) {
    handlerStore.set(endpointId, new Map())
  }
  const endpointHandlers = handlerStore.get(endpointId)!

  if (!endpointHandlers.has(clusterName)) {
    endpointHandlers.set(clusterName, new Map())
  }
  const clusterHandlers = endpointHandlers.get(clusterName)!

  clusterHandlers.set(commandName, handler)
  log.debug(`Registered handler for ${endpointId}.${clusterName}.${commandName}`)
}

/**
 * Get a handler for a specific endpoint/cluster/command
 */
function getHandler(endpointId: string, clusterName: string, commandName: string): MatterCommandHandler | undefined {
  return handlerStore.get(endpointId)?.get(clusterName)?.get(commandName)
}

/**
 * Optional methods that are called internally by Matter.js
 * These are typically handled by their combined counterparts (e.g., moveToHueAndSaturationLogic)
 */
const OPTIONAL_METHODS = new Set<string>([
  commandNames.ColorControl.moveToHueLogic,
  commandNames.ColorControl.moveToSaturationLogic,
  commandNames.ColorControl.stopAllColorMovement,
])

/**
 * Execute a handler with consistent error handling and logging
 *
 * @param endpointId - Unique endpoint identifier (accessory UUID or part endpoint ID)
 * @param clusterName - Name of the Matter cluster
 * @param commandName - Name of the command method
 * @param request - Optional request data passed to the handler
 */
function executeHandler(
  endpointId: string,
  clusterName: string,
  commandName: string,
  request?: unknown,
): void {
  const handler = getHandler(endpointId, clusterName, commandName)

  log.debug(`${clusterName}.${commandName} called for endpoint ${endpointId}`)

  if (handler) {
    // Build context for the handler
    // Check if this endpoint is a part of a composed device
    const partInfo = partEndpointMap.get(endpointId)
    const context = partInfo
      ? { uuid: partInfo.parentUuid, partId: partInfo.partId }
      : { uuid: endpointId, partId: undefined }

    handler(request, context)
    log.debug(`  ✓ Plugin handler for ${endpointId}.${clusterName}.${commandName} executed successfully`)
  } else if (!OPTIONAL_METHODS.has(commandName)) {
    // warn about missing handlers, except for optional methods
    log.warn(`  ⚠ No handler registered for ${endpointId}.${clusterName}.${commandName}`)
  }
}

/**
 * Custom OnOff Server that calls plugin handlers
 */
export class HomebridgeOnOffServer extends OnOffServer {
  override on(): MatterCommandResult {
    const endpointId = this.endpoint.id
    executeHandler(endpointId, clusterNames.OnOff, commandNames.OnOff.on)

    const result = super.on()
    syncEndpointStateToCache(endpointId, clusterNames.OnOff, { onOff: true })

    return result
  }

  override off(): MatterCommandResult {
    const endpointId = this.endpoint.id
    executeHandler(endpointId, clusterNames.OnOff, commandNames.OnOff.off)

    const result = super.off()
    syncEndpointStateToCache(endpointId, clusterNames.OnOff, { onOff: false })

    return result
  }

  override toggle(): MatterCommandResult {
    const endpointId = this.endpoint.id
    executeHandler(endpointId, clusterNames.OnOff, commandNames.OnOff.toggle)

    const result = super.toggle()

    // Read the new state from the endpoint and sync to cache
    const newState = this.state.onOff
    syncEndpointStateToCache(endpointId, clusterNames.OnOff, { onOff: newState })

    return result
  }
}

/**
 * Custom LevelControl Server that calls plugin handlers
 */
export class HomebridgeLevelControlServer extends LevelControlServer {
  override moveToLevel(request: LevelControl.MoveToLevelRequest): MatterCommandResult {
    const endpointId = this.endpoint.id
    executeHandler(endpointId, clusterNames.LevelControl, commandNames.LevelControl.moveToLevel, request)

    const result = super.moveToLevel(request)
    syncEndpointStateToCache(endpointId, clusterNames.LevelControl, { currentLevel: request.level })

    return result
  }

  override moveToLevelWithOnOff(request: LevelControl.MoveToLevelRequest): MaybePromise {
    const endpointId = this.endpoint.id

    // Try specific handler first, fall back to moveToLevel handler
    const handler = getHandler(endpointId, clusterNames.LevelControl, commandNames.LevelControl.moveToLevelWithOnOff)
      || getHandler(endpointId, clusterNames.LevelControl, commandNames.LevelControl.moveToLevel)

    log.debug(`LevelControl.moveToLevelWithOnOff called for endpoint ${endpointId} with level ${request.level}`)

    if (handler) {
      handler(request)
      log.debug(`  ✓ Plugin handler for ${endpointId}.LevelControl.moveToLevelWithOnOff executed successfully`)
    } else {
      log.warn(`  ⚠ No handler registered for ${endpointId}.levelControl.moveToLevelWithOnOff or moveToLevel`)
    }

    const result = super.moveToLevelWithOnOff(request)
    syncEndpointStateToCache(endpointId, clusterNames.LevelControl, { currentLevel: request.level })

    return result
  }

  override move(request: LevelControl.MoveRequest): MaybePromise {
    const endpointId = this.endpoint.id
    executeHandler(endpointId, clusterNames.LevelControl, commandNames.LevelControl.move, request)
    return super.move(request)
  }

  override step(request: LevelControl.StepRequest): MaybePromise {
    const endpointId = this.endpoint.id
    executeHandler(endpointId, clusterNames.LevelControl, commandNames.LevelControl.step, request)
    return super.step(request)
  }

  override stop(request: LevelControl.StopRequest): MaybePromise {
    const endpointId = this.endpoint.id
    executeHandler(endpointId, clusterNames.LevelControl, commandNames.LevelControl.stop, request)
    return super.stop(request)
  }
}

/**
 * WindowCovering state property names
 * These correspond to the Matter.js WindowCovering cluster attribute names
 */
const WindowCoveringStateProps = {
  targetPositionLiftPercent100ths: 'targetPositionLiftPercent100ths' as const,
  currentPositionLiftPercent100ths: 'currentPositionLiftPercent100ths' as const,
  targetPositionTiltPercent100ths: 'targetPositionTiltPercent100ths' as const,
  currentPositionTiltPercent100ths: 'currentPositionTiltPercent100ths' as const,
} satisfies Record<string, keyof WindowCoveringBaseServer.State>

/**
 * Custom WindowCovering Server that calls plugin handlers
 */
export class HomebridgeWindowCoveringServer extends WindowCoveringBaseServer {
  /**
   * Sync window covering position state to cache
   * @param endpointId - The endpoint ID
   * @param targetProperty - Target position property name (e.g., 'targetPositionLiftPercent100ths')
   * @param currentProperty - Current position property name (e.g., 'currentPositionLiftPercent100ths')
   */
  private syncPositionStateToCache<
    TTarget extends keyof WindowCoveringBaseServer.State,
    TCurrent extends keyof WindowCoveringBaseServer.State,
  >(
    endpointId: string,
    targetProperty: TTarget,
    currentProperty: TCurrent,
  ): void {
    const currentState = this.state
    const stateUpdate: Record<string, any> = {}
    if (currentState[targetProperty] !== undefined) {
      stateUpdate[targetProperty as string] = currentState[targetProperty]
    }
    if (currentState[currentProperty] !== undefined) {
      stateUpdate[currentProperty as string] = currentState[currentProperty]
    }
    syncEndpointStateToCache(endpointId, clusterNames.WindowCovering, stateUpdate)
  }

  override upOrOpen(): MaybePromise {
    const endpointId = this.endpoint.id
    executeHandler(endpointId, clusterNames.WindowCovering, commandNames.WindowCovering.upOrOpen)

    const result = super.upOrOpen()

    // Sync state to cache - window covering opening
    this.syncPositionStateToCache(
      endpointId,
      WindowCoveringStateProps.targetPositionLiftPercent100ths,
      WindowCoveringStateProps.currentPositionLiftPercent100ths,
    )

    return result
  }

  override downOrClose(): MaybePromise {
    const endpointId = this.endpoint.id
    executeHandler(endpointId, clusterNames.WindowCovering, commandNames.WindowCovering.downOrClose)

    const result = super.downOrClose()

    // Sync state to cache - window covering closing
    this.syncPositionStateToCache(
      endpointId,
      WindowCoveringStateProps.targetPositionLiftPercent100ths,
      WindowCoveringStateProps.currentPositionLiftPercent100ths,
    )

    return result
  }

  override stopMotion(): MaybePromise {
    const endpointId = this.endpoint.id
    executeHandler(endpointId, clusterNames.WindowCovering, commandNames.WindowCovering.stopMotion)

    const result = super.stopMotion()

    // Sync state to cache - window covering stopped
    this.syncPositionStateToCache(
      endpointId,
      WindowCoveringStateProps.targetPositionLiftPercent100ths,
      WindowCoveringStateProps.currentPositionLiftPercent100ths,
    )

    return result
  }

  override goToLiftPercentage(request: WindowCovering.GoToLiftPercentageRequest): MaybePromise {
    const endpointId = this.endpoint.id
    executeHandler(endpointId, clusterNames.WindowCovering, commandNames.WindowCovering.goToLiftPercentage, request)

    const result = super.goToLiftPercentage(request)

    // Sync state to cache - window covering moving to target position
    this.syncPositionStateToCache(
      endpointId,
      WindowCoveringStateProps.targetPositionLiftPercent100ths,
      WindowCoveringStateProps.currentPositionLiftPercent100ths,
    )

    return result
  }

  override goToTiltPercentage(request: WindowCovering.GoToTiltPercentageRequest): MaybePromise {
    const endpointId = this.endpoint.id
    executeHandler(endpointId, clusterNames.WindowCovering, commandNames.WindowCovering.goToTiltPercentage, request)

    const result = super.goToTiltPercentage(request)

    // Sync state to cache - window covering tilting to target angle
    this.syncPositionStateToCache(
      endpointId,
      WindowCoveringStateProps.targetPositionTiltPercent100ths,
      WindowCoveringStateProps.currentPositionTiltPercent100ths,
    )

    return result
  }
}

/**
 * Custom FanControl Server that calls plugin handlers
 */
export class HomebridgeFanControlServer extends FanControlServer {
  override initialize(): void {
    super.initialize()

    // React to fanMode attribute changes (on/off)
    this.reactTo(this.events.fanMode$Changed, this.#handleFanModeChange)

    // React to percentSetting attribute changes (speed)
    this.reactTo(this.events.percentSetting$Changed, this.#handlePercentSettingChange)
  }

  #handleFanModeChange(value: number, oldValue: number): void {
    const endpointId = this.endpoint.id
    executeHandler(endpointId, clusterNames.FanControl, commandNames.FanControl.fanModeChange, { fanMode: value, oldFanMode: oldValue })

    syncEndpointStateToCache(endpointId, clusterNames.FanControl, { fanMode: value })
  }

  #handlePercentSettingChange(value: number | null, oldValue: number | null): void {
    const endpointId = this.endpoint.id
    executeHandler(endpointId, clusterNames.FanControl, commandNames.FanControl.percentSettingChange, {
      percentSetting: value,
      oldPercentSetting: oldValue,
    })

    syncEndpointStateToCache(endpointId, clusterNames.FanControl, {
      percentSetting: value,
      percentCurrent: value,
    })
  }
}

/**
 * Custom DoorLock Server that calls plugin handlers
 */
export class HomebridgeDoorLockServer extends DoorLockServer {
  override lockDoor(): MaybePromise {
    const endpointId = this.endpoint.id
    executeHandler(endpointId, clusterNames.DoorLock, commandNames.DoorLock.lockDoor)

    const result = super.lockDoor()

    // Sync lock state to cache
    const currentState = this.state as any
    if (currentState.lockState !== undefined) {
      syncEndpointStateToCache(endpointId, clusterNames.DoorLock, { lockState: currentState.lockState })
    }

    return result
  }

  override unlockDoor(): MaybePromise {
    const endpointId = this.endpoint.id
    executeHandler(endpointId, clusterNames.DoorLock, commandNames.DoorLock.unlockDoor)

    const result = super.unlockDoor()

    // Sync lock state to cache
    const currentState = this.state as any
    if (currentState.lockState !== undefined) {
      syncEndpointStateToCache(endpointId, clusterNames.DoorLock, { lockState: currentState.lockState })
    }

    return result
  }
}

/**
 * Custom Thermostat Server that calls plugin handlers
 */
export class HomebridgeThermostatServer extends ThermostatServer {
  override initialize(): void {
    super.initialize()

    // React to systemMode attribute changes (off, heat, cool, auto, etc.)
    this.reactTo(this.events.systemMode$Changed, this.#handleSystemModeChange)

    // React to occupiedHeatingSetpoint attribute changes (target heating temperature)
    const events = this.events as any
    if (events.occupiedHeatingSetpoint$Changing) {
      this.reactTo(events.occupiedHeatingSetpoint$Changing, this.#handleOccupiedHeatingSetpointChanging)
    }

    // React to occupiedCoolingSetpoint attribute changes (target cooling temperature)
    if (events.occupiedCoolingSetpoint$Changing) {
      this.reactTo(events.occupiedCoolingSetpoint$Changing, this.#handleOccupiedCoolingSetpointChanging)
    }
  }

  #handleSystemModeChange(value: number, oldValue: number): void {
    const endpointId = this.endpoint.id
    executeHandler(endpointId, clusterNames.Thermostat, commandNames.Thermostat.systemModeChange, {
      systemMode: value,
      oldSystemMode: oldValue,
    })

    syncEndpointStateToCache(endpointId, clusterNames.Thermostat, { systemMode: value })
  }

  #handleOccupiedHeatingSetpointChanging(value: unknown): void {
    const endpointId = this.endpoint.id
    const oldValue = (this.state as any).occupiedHeatingSetpoint
    executeHandler(endpointId, clusterNames.Thermostat, commandNames.Thermostat.occupiedHeatingSetpointChange, {
      occupiedHeatingSetpoint: value as number,
      oldOccupiedHeatingSetpoint: oldValue,
    })

    syncEndpointStateToCache(endpointId, clusterNames.Thermostat, { occupiedHeatingSetpoint: value })
  }

  #handleOccupiedCoolingSetpointChanging(value: unknown): void {
    const endpointId = this.endpoint.id
    const oldValue = (this.state as any).occupiedCoolingSetpoint
    executeHandler(endpointId, clusterNames.Thermostat, commandNames.Thermostat.occupiedCoolingSetpointChange, {
      occupiedCoolingSetpoint: value as number,
      oldOccupiedCoolingSetpoint: oldValue,
    })

    syncEndpointStateToCache(endpointId, clusterNames.Thermostat, { occupiedCoolingSetpoint: value })
  }

  override setpointRaiseLower(request: Thermostat.SetpointRaiseLowerRequest): MaybePromise {
    const endpointId = this.endpoint.id
    executeHandler(endpointId, clusterNames.Thermostat, commandNames.Thermostat.setpointRaiseLower, request)

    const result = super.setpointRaiseLower(request)

    // Sync thermostat setpoints to cache
    const currentState = this.state as any
    const stateUpdate: Record<string, any> = {}
    if (currentState.occupiedCoolingSetpoint !== undefined) {
      stateUpdate.occupiedCoolingSetpoint = currentState.occupiedCoolingSetpoint
    }
    if (currentState.occupiedHeatingSetpoint !== undefined) {
      stateUpdate.occupiedHeatingSetpoint = currentState.occupiedHeatingSetpoint
    }
    syncEndpointStateToCache(endpointId, clusterNames.Thermostat, stateUpdate)

    return result
  }
}

/**
 * Custom Identify Server that calls plugin handlers
 */
export class HomebridgeIdentifyServer extends IdentifyServer {
  override identify(request: Identify.IdentifyRequest): MaybePromise {
    const endpointId = this.endpoint.id
    executeHandler(endpointId, clusterNames.Identify, commandNames.Identify.identify, request)
    return super.identify(request)
  }
}

/**
 * Custom ColorControl Server that calls plugin handlers
 *
 * ColorControl handles color changes for lights (hue, saturation, XY color, color temperature).
 * Plugin developers can override these *Logic methods to handle color changes in their hardware.
 *
 * Features (Xy, ColorTemperature, HueSaturation) are added by the device type, not this behavior.
 * This ensures each device only gets the features it needs.
 */
export class HomebridgeColorControlServer extends ColorControlServer {
  /**
   * Called when color temperature is changed
   * @param colorTemperatureMireds - Target color temperature in mireds (micro reciprocal degrees)
   * @param transitionTime - Transition time in seconds (0 = as fast as possible)
   */
  override moveToColorTemperatureLogic(colorTemperatureMireds: number, transitionTime: number): MaybePromise {
    const endpointId = this.endpoint.id
    executeHandler(endpointId, clusterNames.ColorControl, commandNames.ColorControl.moveToColorTemperatureLogic, { colorTemperatureMireds, transitionTime })

    const result = super.moveToColorTemperatureLogic(colorTemperatureMireds, transitionTime)

    // Sync color temperature to cache
    const currentState = this.state as any
    if (currentState.colorTemperatureMireds !== undefined) {
      syncEndpointStateToCache(endpointId, clusterNames.ColorControl, {
        colorTemperatureMireds: currentState.colorTemperatureMireds,
      })
    }

    return result
  }

  /**
   * Called when hue and saturation are changed together
   * @param hue - Target hue value (0-254 for normal hue, 0-65535 for enhanced hue)
   * @param saturation - Target saturation value (0-254)
   * @param transitionTime - Transition time in seconds (0 = as fast as possible)
   */
  override moveToHueAndSaturationLogic(hue: number, saturation: number, transitionTime: number): MaybePromise {
    const endpointId = this.endpoint.id
    executeHandler(endpointId, clusterNames.ColorControl, commandNames.ColorControl.moveToHueAndSaturationLogic, { hue, saturation, transitionTime })

    const result = super.moveToHueAndSaturationLogic(hue, saturation, transitionTime)

    // Sync hue and saturation to cache
    const currentState = this.state as any
    const stateUpdate: Record<string, any> = {}
    if (currentState.currentHue !== undefined) {
      stateUpdate.currentHue = currentState.currentHue
    }
    if (currentState.currentSaturation !== undefined) {
      stateUpdate.currentSaturation = currentState.currentSaturation
    }
    syncEndpointStateToCache(endpointId, clusterNames.ColorControl, stateUpdate)

    return result
  }

  /**
   * Called when XY color coordinates are changed
   * @param targetX - Target X value (0-65535 representing 0.0-1.0 in CIE color space)
   * @param targetY - Target Y value (0-65535 representing 0.0-1.0 in CIE color space)
   * @param transitionTime - Transition time in seconds (0 = as fast as possible)
   */
  override moveToColorLogic(targetX: number, targetY: number, transitionTime: number): MaybePromise {
    const endpointId = this.endpoint.id
    executeHandler(endpointId, clusterNames.ColorControl, commandNames.ColorControl.moveToColorLogic, { targetX, targetY, transitionTime })

    const result = super.moveToColorLogic(targetX, targetY, transitionTime)

    // Sync XY color to cache
    const currentState = this.state as any
    const stateUpdate: Record<string, any> = {}
    if (currentState.currentX !== undefined) {
      stateUpdate.currentX = currentState.currentX
    }
    if (currentState.currentY !== undefined) {
      stateUpdate.currentY = currentState.currentY
    }
    syncEndpointStateToCache(endpointId, clusterNames.ColorControl, stateUpdate)

    return result
  }

  /**
   * Called when hue is changed individually
   * @param targetHue - Target hue value
   * @param direction - Direction to move (shortest, longest, up, down)
   * @param transitionTime - Transition time in seconds
   * @param isEnhancedHue - Whether this is enhanced hue (16-bit) or normal hue (8-bit)
   */
  override moveToHueLogic(targetHue: number, direction: ColorControl.Direction, transitionTime: number, isEnhancedHue = false): MaybePromise {
    const endpointId = this.endpoint.id
    executeHandler(endpointId, clusterNames.ColorControl, commandNames.ColorControl.moveToHueLogic, { targetHue, direction, transitionTime, isEnhancedHue })

    const result = super.moveToHueLogic(targetHue, direction, transitionTime, isEnhancedHue)

    // Sync hue to cache
    const currentState = this.state as any
    const stateUpdate: Record<string, any> = {}
    if (isEnhancedHue && currentState.enhancedCurrentHue !== undefined) {
      stateUpdate.enhancedCurrentHue = currentState.enhancedCurrentHue
    } else if (currentState.currentHue !== undefined) {
      stateUpdate.currentHue = currentState.currentHue
    }
    syncEndpointStateToCache(endpointId, clusterNames.ColorControl, stateUpdate)

    return result
  }

  /**
   * Called when saturation is changed individually
   * @param targetSaturation - Target saturation value (0-254)
   * @param transitionTime - Transition time in seconds
   */
  override moveToSaturationLogic(targetSaturation: number, transitionTime: number): MaybePromise {
    const endpointId = this.endpoint.id
    executeHandler(endpointId, clusterNames.ColorControl, commandNames.ColorControl.moveToSaturationLogic, { targetSaturation, transitionTime })

    const result = super.moveToSaturationLogic(targetSaturation, transitionTime)

    // Sync saturation to cache
    const currentState = this.state as any
    if (currentState.currentSaturation !== undefined) {
      syncEndpointStateToCache(endpointId, clusterNames.ColorControl, {
        currentSaturation: currentState.currentSaturation,
      })
    }

    return result
  }

  /**
   * Called when all color movement should be stopped
   */
  override stopAllColorMovement(): MaybePromise {
    const endpointId = this.endpoint.id
    executeHandler(endpointId, clusterNames.ColorControl, commandNames.ColorControl.stopAllColorMovement)
    return super.stopAllColorMovement()
  }
}

/**
 * Custom RvcOperationalState Server that calls plugin handlers
 * Handles robotic vacuum cleaner operational state commands
 */
export class HomebridgeRvcOperationalStateServer extends RvcOperationalStateServer {
  override pause(): MaybePromise<RvcOperationalState.OperationalCommandResponse> {
    const endpointId = this.endpoint.id
    executeHandler(endpointId, clusterNames.RvcOperationalState, commandNames.RvcOperationalState.pause)
    return super.pause()
  }

  override resume(): MaybePromise<RvcOperationalState.OperationalCommandResponse> {
    const endpointId = this.endpoint.id
    executeHandler(endpointId, clusterNames.RvcOperationalState, commandNames.RvcOperationalState.resume)
    return super.resume()
  }

  override goHome(): MaybePromise<RvcOperationalState.OperationalCommandResponse> {
    const endpointId = this.endpoint.id
    executeHandler(endpointId, clusterNames.RvcOperationalState, commandNames.RvcOperationalState.goHome)
    // Return success response instead of calling unimplemented base method
    return {
      commandResponseState: {
        errorStateId: RvcOperationalState.ErrorState.NoError,
      },
    }
  }
}

/**
 * Custom RvcRunMode Server that calls plugin handlers
 * Handles robotic vacuum cleaner run mode changes
 */
export class HomebridgeRvcRunModeServer extends RvcRunModeServer {
  override changeToMode(request: any): any {
    const endpointId = this.endpoint.id
    executeHandler(endpointId, clusterNames.RvcRunMode, commandNames.RvcRunMode.changeToMode, request)
    return super.changeToMode(request)
  }
}

/**
 * Custom RvcCleanMode Server that calls plugin handlers
 * Handles robotic vacuum cleaner cleaning mode changes
 */
export class HomebridgeRvcCleanModeServer extends RvcCleanModeServer {
  override changeToMode(request: any): any {
    const endpointId = this.endpoint.id
    executeHandler(endpointId, clusterNames.RvcCleanMode, commandNames.RvcCleanMode.changeToMode, request)
    return super.changeToMode(request)
  }
}

/**
 * Custom ServiceArea Server that calls plugin handlers
 * Handles service area selection for robotic vacuum cleaners
 */
export class HomebridgeServiceAreaServer extends ServiceAreaServer {
  override selectAreas(request: ServiceArea.SelectAreasRequest): MaybePromise<ServiceArea.SelectAreasResponse> {
    const endpointId = this.endpoint.id
    executeHandler(endpointId, clusterNames.ServiceArea, commandNames.ServiceArea.selectAreas, request)
    return super.selectAreas(request)
  }

  override skipArea(request: ServiceArea.SkipAreaRequest): MaybePromise<ServiceArea.SkipAreaResponse> {
    const endpointId = this.endpoint.id
    executeHandler(endpointId, clusterNames.ServiceArea, commandNames.ServiceArea.skipArea, request)
    return super.skipArea(request)
  }
}
