import type { AssistantDriver } from './assistant-driver'

const DRIVER_ID_PATTERN = /^[a-z][a-z0-9-]{0,79}$/

/** Dynamic driver registry. Runtime orchestration depends on this catalog, not provider branches. */
export class AssistantDriverRegistry {
  private readonly drivers = new Map<string, AssistantDriver>()

  constructor(initialDrivers: readonly AssistantDriver[] = []) {
    for (const driver of initialDrivers) this.register(driver)
  }

  register(driver: AssistantDriver): () => void {
    if (!DRIVER_ID_PATTERN.test(driver.id) || this.drivers.has(driver.id)) {
      throw new Error(`Assistant driver id is invalid or already registered: ${driver.id}`)
    }
    this.drivers.set(driver.id, driver)
    return () => {
      if (this.drivers.get(driver.id) === driver) this.drivers.delete(driver.id)
    }
  }

  get(driverId: string): AssistantDriver | null {
    return this.drivers.get(driverId) ?? null
  }

  require(driverId: string): AssistantDriver {
    const driver = this.get(driverId)
    if (!driver) throw new Error(`Assistant driver is not registered: ${driverId}`)
    return driver
  }

  list(): AssistantDriver[] {
    return [...this.drivers.values()].sort((left, right) => left.id.localeCompare(right.id))
  }
}
