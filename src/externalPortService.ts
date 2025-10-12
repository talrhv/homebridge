import type { MacAddress } from 'hap-nodejs'

import type { ChildBridgeFork } from './childBridgeFork.js'

import { Logger } from './logger.js'

export interface ExternalPortsConfiguration {
  start: number
  end: number
}

/**
 * Allocates ports from the user defined `config.ports` and `config.matterPorts` options
 * This service is used to allocate ports for external accessories on the main bridge, and child bridges.
 * HAP ports and Matter ports are managed separately with their own ranges.
 */
export class ExternalPortService {
  private nextExternalPort?: number
  private nextMatterPort?: number
  private allocatedPorts: Map<MacAddress, number | undefined> = new Map()
  private allocatedMatterPorts: Map<string, number | undefined> = new Map()

  constructor(
    private externalPorts?: ExternalPortsConfiguration,
    private matterPorts?: ExternalPortsConfiguration,
  ) {}

  /**
   * Returns the next available HAP port in the external port config.
   * If the external port is not configured by the user it will return undefined.
   * If the port range has been exhausted it will return undefined.
   */
  public async requestPort(username: MacAddress): Promise<number | undefined> {
    // check to see if this device has already requested an external port
    const existingPortAllocation = this.allocatedPorts.get(username)
    if (existingPortAllocation) {
      return existingPortAllocation
    }

    // get the next unused port
    const port = this.getNextFreePort()
    this.allocatedPorts.set(username, port)
    return port
  }

  /**
   * Returns the next available Matter port in the Matter port config.
   * If Matter ports are not configured, falls back to range 5530-5541.
   * If the port range has been exhausted it will return undefined.
   *
   * @param uuid - Unique identifier for the Matter accessory (can be accessory UUID or other unique string)
   */
  public async requestMatterPort(uuid: string): Promise<number | undefined> {
    // check to see if this accessory has already requested a Matter port
    const existingPortAllocation = this.allocatedMatterPorts.get(uuid)
    if (existingPortAllocation) {
      return existingPortAllocation
    }

    // get the next unused Matter port
    const port = this.getNextFreeMatterPort()
    this.allocatedMatterPorts.set(uuid, port)
    return port
  }

  /**
   * Get an unused Matter port without allocating it.
   * Useful for UI/API to get a suggested port.
   * Falls back to random port in range 5530-5541 if no port range configured.
   */
  public getUnusedMatterPort(): number {
    if (!this.matterPorts) {
      // Fallback to Matter default range if not configured
      return Math.floor(Math.random() * (5541 - 5530 + 1) + 5530)
    }

    // Try to find an unused port in the configured range
    const port = this.getNextFreeMatterPort()
    if (port) {
      return port
    }

    // If all ports exhausted, return random from configured range
    return Math.floor(Math.random() * (this.matterPorts.end - this.matterPorts.start + 1) + this.matterPorts.start)
  }

  private getNextFreePort(): number | undefined {
    if (!this.externalPorts) {
      return undefined
    }

    if (this.nextExternalPort === undefined) {
      this.nextExternalPort = this.externalPorts.start
      return this.nextExternalPort
    }

    this.nextExternalPort++

    if (this.nextExternalPort <= this.externalPorts.end) {
      return this.nextExternalPort
    }

    Logger.internal.warn('External HAP port pool ran out of ports. Falling back to random port assignment.')

    return undefined
  }

  private getNextFreeMatterPort(): number | undefined {
    if (!this.matterPorts) {
      // Fallback to Matter default range
      return Math.floor(Math.random() * (5541 - 5530 + 1) + 5530)
    }

    if (this.nextMatterPort === undefined) {
      this.nextMatterPort = this.matterPorts.start
      return this.nextMatterPort
    }

    this.nextMatterPort++

    if (this.nextMatterPort <= this.matterPorts.end) {
      return this.nextMatterPort
    }

    Logger.internal.warn('Matter port pool ran out of ports. Falling back to random port assignment in range 5530-5541.')

    // Fallback to random in default Matter range
    return Math.floor(Math.random() * (5541 - 5530 + 1) + 5530)
  }
}

/**
 * This is the child bridge version of the port allocation service.
 * It requests free ports from the main bridge's port service via IPC.
 */
export class ChildBridgeExternalPortService extends ExternalPortService {
  constructor(
    private childBridge: ChildBridgeFork,
  ) {
    super()
  }

  public async requestPort(username: MacAddress): Promise<number | undefined> {
    return await this.childBridge.requestExternalPort(username)
  }

  public async requestMatterPort(uniqueId: string): Promise<number | undefined> {
    // For child bridges, request Matter port from parent via IPC
    return await this.childBridge.requestMatterPort(uniqueId)
  }

  public getUnusedMatterPort(): number {
    // For child bridges without IPC call, return random port in default range
    return Math.floor(Math.random() * (5541 - 5530 + 1) + 5530)
  }
}
