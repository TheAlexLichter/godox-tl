import type { LightEntry } from "@godox-tl/core";
import { expect, test } from "vite-plus/test";
import type { API, Logger, PlatformAccessory } from "homebridge";
import { GodoxTLPlatform, PLATFORM_NAME, PLUGIN_NAME } from "../src/platform.ts";

class FakeCharacteristic {
  setProps(): this {
    return this;
  }
  onSet(): this {
    return this;
  }
  onGet(): this {
    return this;
  }
  updateValue(): this {
    return this;
  }
}

class FakeService {
  private readonly characteristics = new Map<string, FakeCharacteristic>();

  constructor(readonly name: string) {}

  setCharacteristic(): this {
    return this;
  }

  getCharacteristic(name: string): FakeCharacteristic {
    let characteristic = this.characteristics.get(name);
    if (!characteristic) {
      characteristic = new FakeCharacteristic();
      this.characteristics.set(name, characteristic);
    }
    return characteristic;
  }
}

class FakeAccessory {
  readonly services = new Map<string, FakeService>();

  constructor(
    readonly displayName: string,
    readonly UUID: string,
  ) {
    this.services.set("AccessoryInformation", new FakeService("AccessoryInformation"));
  }

  getService(name: string): FakeService | undefined {
    return this.services.get(name);
  }

  addService(name: string, serviceName?: string, subtype?: string): FakeService {
    const service = new FakeService(name);
    this.services.set(subtype ? `${name}:${subtype}` : name, service);
    return service;
  }

  getServiceById(name: string, subtype: string): FakeService | undefined {
    return this.services.get(`${name}:${subtype}`);
  }
}

const entry = (name: string, address = "AA:BB:CC:DD:EE:FF"): LightEntry => ({
  name,
  address,
  statePath: "/tmp/state.json",
  provisionedAt: new Date(0).toISOString(),
});

const makeHarness = () => {
  const registered: PlatformAccessory[] = [];
  const unregistered: PlatformAccessory[] = [];
  const handlers = new Map<string, () => void>();
  const api = {
    hap: {
      uuid: {
        generate: (input: string) => `uuid:${input}`,
      },
      Service: {
        AccessoryInformation: "AccessoryInformation",
        Lightbulb: "Lightbulb",
        Switch: "Switch",
      },
      Characteristic: {
        Manufacturer: "Manufacturer",
        Model: "Model",
        SerialNumber: "SerialNumber",
        On: "On",
        Brightness: "Brightness",
        ColorTemperature: "ColorTemperature",
        Hue: "Hue",
        Saturation: "Saturation",
      },
    },
    platformAccessory: FakeAccessory,
    registerPlatformAccessories: (
      pluginName: string,
      platformName: string,
      accessories: PlatformAccessory[],
    ) => {
      expect(pluginName).toBe(PLUGIN_NAME);
      expect(platformName).toBe(PLATFORM_NAME);
      registered.push(...accessories);
    },
    unregisterPlatformAccessories: (
      pluginName: string,
      platformName: string,
      accessories: PlatformAccessory[],
    ) => {
      expect(pluginName).toBe(PLUGIN_NAME);
      expect(platformName).toBe(PLATFORM_NAME);
      unregistered.push(...accessories);
    },
    on: (event: string, handler: () => void) => {
      handlers.set(event, handler);
    },
  } as unknown as API;
  const log = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  } as unknown as Logger;
  const platform = new GodoxTLPlatform(log, { platform: PLATFORM_NAME, autoProvision: false }, api);
  const materialize = (
    platform as unknown as {
      materializeAccessories(entries: ReadonlyArray<LightEntry>, reconcile?: boolean): void;
    }
  ).materializeAccessories.bind(platform);
  return { platform, materialize, registered, unregistered };
};

test("materializeAccessories uses address-stable UUIDs across renames", () => {
  const { platform, materialize, registered } = makeHarness();

  materialize([entry("kitchen")], true);
  materialize([entry("office")], true);

  expect(registered).toHaveLength(1);
  expect(platform.accessoriesByUUID).toHaveLength(1);
  expect(platform.accessoriesByUUID.has("uuid:godox-tl:AA:BB:CC:DD:EE:FF")).toBe(true);
});

test("startup reconciliation unregisters cached accessories no longer present", () => {
  const { platform, materialize, unregistered } = makeHarness();
  const stale = new FakeAccessory("old", "uuid:godox-tl:old") as unknown as PlatformAccessory;

  platform.configureAccessory(stale);
  materialize([], true);

  expect(unregistered).toEqual([stale]);
  expect(platform.accessoriesByUUID.has(stale.UUID)).toBe(false);
});
