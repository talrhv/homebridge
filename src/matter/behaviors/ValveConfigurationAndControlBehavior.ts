/**
 * Valve Configuration and Control Cluster Behavior
 *
 * Handles water valve open/close commands and writable valve settings.
 */

import type { ValveConfigurationAndControl } from '@matter/main/clusters'

import {
  ValveConfigurationAndControlBehavior,
  ValveConfigurationAndControlServer,
} from '@matter/main/behaviors/valve-configuration-and-control'
import { Status, StatusResponseError } from '@matter/main/types'

import { MatterStatus } from '../errors.js'
import { getRegistryManager } from './EndpointContext.js'

/**
 * Custom ValveConfigurationAndControl Server that calls plugin handlers
 */
export class HomebridgeValveConfigurationAndControlServer extends ValveConfigurationAndControlServer {
  /**
   * Get the registry for this behavior's endpoint
   */
  private getRegistry() {
    return getRegistryManager(this.endpoint).getRegistry(this.endpoint.id)
  }

  override initialize(): void {
    super.initialize()

    // React to writes of the mandatory writable defaultOpenDuration attribute.
    this.reactTo(
      this.events.defaultOpenDuration$Changed,
      this.#handleDefaultOpenDurationChange,
      { offline: true },
    )

    // Optional LVL feature support:
    // If you expose the Level feature for a proportional valve, you can also react
    // to defaultOpenLevel writes by uncommenting the handler below.
    //
    // const defaultOpenLevelChanged = (this.events as { defaultOpenLevel$Changed?: unknown }).defaultOpenLevel$Changed
    // if (defaultOpenLevelChanged) {
    //   this.reactTo(defaultOpenLevelChanged as any, this.#handleDefaultOpenLevelChange as any, { offline: true })
    // }
  }

  /**
   * Sync valve state to cache for UI updates
   */
  private syncValveStateToCache(): void {
    const endpointId = this.endpoint.id
    const registry = this.getRegistry()
    const currentState = this.state as ValveConfigurationAndControlBehavior.State
    const stateUpdate: Partial<ValveConfigurationAndControlBehavior.State> = {}

    if (currentState.openDuration !== undefined) {
      stateUpdate.openDuration = currentState.openDuration
    }
    if (currentState.defaultOpenDuration !== undefined) {
      stateUpdate.defaultOpenDuration = currentState.defaultOpenDuration
    }
    if (currentState.remainingDuration !== undefined) {
      stateUpdate.remainingDuration = currentState.remainingDuration
    }
    if (currentState.currentState !== undefined) {
      stateUpdate.currentState = currentState.currentState
    }
    if (currentState.targetState !== undefined) {
      stateUpdate.targetState = currentState.targetState
    }

    // Optional TimeSync feature
    if (currentState.autoCloseTime !== undefined) {
      stateUpdate.autoCloseTime = currentState.autoCloseTime
    }

    // Optional Level feature
    if (currentState.currentLevel !== undefined) {
      stateUpdate.currentLevel = currentState.currentLevel
    }
    if (currentState.targetLevel !== undefined) {
      stateUpdate.targetLevel = currentState.targetLevel
    }
    if (currentState.defaultOpenLevel !== undefined) {
      stateUpdate.defaultOpenLevel = currentState.defaultOpenLevel
    }
    if (currentState.levelStep !== undefined) {
      stateUpdate.levelStep = currentState.levelStep
    }

    // Optional fault reporting
    if (currentState.valveFault !== undefined) {
      stateUpdate.valveFault = currentState.valveFault
    }

    if (Object.keys(stateUpdate).length > 0) {
      registry.syncStateToCache(endpointId, 'valveConfigurationAndControl', stateUpdate)
    }
  }

  /**
   * Handle Open command
   */
  override async open(request: ValveConfigurationAndControl.OpenRequest): Promise<void> {
    const endpointId = this.endpoint.id
    const registry = this.getRegistry()

    try {
      // Execute user handler
      await registry.executeHandler(
        endpointId,
        'valveConfigurationAndControl',
        'open',
        request,
      )

      // Only reached if handler succeeded - update Matter state
      await super.open(request)

      // Sync state to cache
      this.syncValveStateToCache()
    } catch (error) {
      // If user handler already threw a StatusResponseError, propagate it as-is
      // This sends a proper Matter protocol error response to the controller
      if (MatterStatus.isMatterProtocolError(error)) {
        throw error
      }

      // For other errors, wrap in appropriate StatusResponseError
      // This prevents the endpoint from crashing and keeps the device online
      const message = error instanceof Error ? error.message : String(error)
      throw new StatusResponseError(`Failed to open valve: ${message}`, Status.Failure)
    }
  }

  /**
   * Handle Close command
   */
  override async close(): Promise<void> {
    const endpointId = this.endpoint.id
    const registry = this.getRegistry()

    try {
      // Execute user handler
      await registry.executeHandler(
        endpointId,
        'valveConfigurationAndControl',
        'close',
      )

      // Only reached if handler succeeded - update Matter state
      await super.close()

      // Sync state to cache
      this.syncValveStateToCache()
    } catch (error) {
      // If user handler already threw a StatusResponseError, propagate it as-is
      // This sends a proper Matter protocol error response to the controller
      if (MatterStatus.isMatterProtocolError(error)) {
        throw error
      }

      // For other errors, wrap in appropriate StatusResponseError
      // This prevents the endpoint from crashing and keeps the device online
      const message = error instanceof Error ? error.message : String(error)
      throw new StatusResponseError(`Failed to close valve: ${message}`, Status.Failure)
    }
  }

  /**
   * Handle writes to the mandatory DefaultOpenDuration attribute
   */
  async #handleDefaultOpenDurationChange(
    value: number | null,
    oldValue: number | null,
  ): Promise<void> {
    const endpointId = this.endpoint.id
    const registry = this.getRegistry()

    try {
      // Execute user handler
      await registry.executeHandler(
        endpointId,
        'valveConfigurationAndControl',
        'defaultOpenDurationChange',
        {
          defaultOpenDuration: value,
          oldDefaultOpenDuration: oldValue,
        },
      )

      // Sync state to cache
      registry.syncStateToCache(endpointId, 'valveConfigurationAndControl', {
        defaultOpenDuration: value,
      })
    } catch (error) {
      // If user handler already threw a StatusResponseError, propagate it as-is
      // This sends a proper Matter protocol error response to the controller
      if (MatterStatus.isMatterProtocolError(error)) {
        throw error
      }

      // For other errors, wrap in appropriate StatusResponseError
      // This prevents the endpoint from crashing and keeps the device online
      const message = error instanceof Error ? error.message : String(error)
      throw new StatusResponseError(
        `Failed to change default open duration: ${message}`,
        Status.Failure,
      )
    }
  }

  // Optional Level feature handler for proportional valves
  // async #handleDefaultOpenLevelChange(value: number, oldValue: number): Promise<void> {
  //   const endpointId = this.endpoint.id
  //   const registry = this.getRegistry()
  //
  //   try {
  //     await registry.executeHandler(
  //       endpointId,
  //       'valveConfigurationAndControl',
  //       'defaultOpenLevelChange',
  //       {
  //         defaultOpenLevel: value,
  //         oldDefaultOpenLevel: oldValue,
  //       },
  //     )
  //
  //     registry.syncStateToCache(endpointId, 'valveConfigurationAndControl', {
  //       defaultOpenLevel: value,
  //     })
  //   } catch (error) {
  //     if (MatterStatus.isMatterProtocolError(error)) {
  //       throw error
  //     }
  //
  //     const message = error instanceof Error ? error.message : String(error)
  //     throw new StatusResponseError(
  //       `Failed to change default open level: ${message}`,
  //       Status.Failure,
  //     )
  //   }
  // }
}
