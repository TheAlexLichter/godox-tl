import { expect, test } from "vite-plus/test";
import {
  GodoxLightAccessory,
  HOMEKIT_MIRED_MAX,
  HOMEKIT_MIRED_MIN,
  clampMireds,
  kelvinToMireds,
  MIRED_MAX,
  MIRED_MIN,
  miredsToKelvin,
} from "../src/accessory.ts";
import type { LightEntry } from "@godox-tl/core";
import type { HAP, Logger, PlatformAccessory } from "homebridge";

test("mireds<->kelvin round-trips within the supported range", () => {
  expect(miredsToKelvin(MIRED_MIN)).toBe(6494);
  expect(miredsToKelvin(MIRED_MAX)).toBe(2801);
  expect(kelvinToMireds(2800)).toBe(MIRED_MAX);
  expect(kelvinToMireds(6500)).toBe(MIRED_MIN);
});

test("mireds<->kelvin clamps to the Godox supported range", () => {
  expect(miredsToKelvin(100)).toBe(6500);
  expect(miredsToKelvin(1000)).toBe(2800);
  expect(kelvinToMireds(1500)).toBe(MIRED_MAX);
  expect(kelvinToMireds(9000)).toBe(MIRED_MIN);
  expect(clampMireds(140)).toBe(MIRED_MIN);
  expect(clampMireds(500)).toBe(MIRED_MAX);
});

test("HomeKit color temperature range accepts common HAP cached values", () => {
  expect(HOMEKIT_MIRED_MIN).toBeLessThanOrEqual(140);
  expect(HOMEKIT_MIRED_MIN).toBeLessThan(MIRED_MIN);
  expect(HOMEKIT_MIRED_MAX).toBeGreaterThan(MIRED_MAX);
});

class FakeCharacteristic {
  value: unknown;
  private setHandler: ((value: unknown) => unknown) | undefined;

  setProps(): this {
    return this;
  }

  onSet(handler: (value: unknown) => unknown): this {
    this.setHandler = handler;
    return this;
  }

  onGet(): this {
    return this;
  }

  updateValue(value: unknown): this {
    this.value = value;
    return this;
  }

  set(value: unknown): void {
    this.value = value;
    this.setHandler?.(value);
  }
}

class FakeService {
  readonly characteristics = new Map<string, FakeCharacteristic>();

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

  updateCharacteristic(name: string, value: unknown): this {
    this.getCharacteristic(name).updateValue(value);
    return this;
  }
}

class FakeAccessory {
  readonly services = new Map<string, FakeService>();

  constructor() {
    this.services.set("AccessoryInformation", new FakeService());
  }

  getService(name: string): FakeService | undefined {
    return this.services.get(name);
  }

  addService(name: string): FakeService {
    const service = new FakeService();
    this.services.set(name, service);
    return service;
  }

  getServiceById(): FakeService | undefined {
    return undefined;
  }
}

const hap = {
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
  ColorUtils: {
    colorTemperatureToHueAndSaturation: (mireds: number) => ({
      hue: Math.round(mireds / 10),
      saturation: Math.round(mireds / 12),
    }),
  },
} as unknown as HAP;

const logger = {
  error: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  debug: () => undefined,
} as unknown as Logger;

const lightEntry: LightEntry = {
  name: "test",
  address: "AA:BB:CC:DD:EE:FF",
  statePath: "/tmp/missing-godox-test-state.json",
  provisionedAt: new Date(0).toISOString(),
};

test("turning off and on restores the last HSI mode instead of falling back to CCT", () => {
  const accessory = new FakeAccessory();
  const light = new GodoxLightAccessory(
    lightEntry,
    accessory as unknown as PlatformAccessory,
    hap,
    logger,
    { enableColor: true, fxPresets: [], rgbwPresets: [] },
    0,
  );
  const service = accessory.getService("Lightbulb") as FakeService;

  service.getCharacteristic("Hue").set(210);
  service.getCharacteristic("Saturation").set(65);
  expect(light.currentState.mode).toBe("hsi");

  service.getCharacteristic("On").set(false);
  expect(light.currentState.on).toBe(false);

  service.getCharacteristic("On").set(true);
  expect(light.currentState.mode).toBe("hsi");
  expect(light.currentState.hue).toBe(210);
  expect(light.currentState.saturation).toBe(65);

  service.getCharacteristic("ColorTemperature").set(250);
  expect(light.currentState.mode).toBe("hsi");
  expect(light.currentState.hue).toBe(210);
  expect(light.currentState.saturation).toBe(65);
});

test("HomeKit color updates ignore trailing color temperature echoes", () => {
  const accessory = new FakeAccessory();
  const light = new GodoxLightAccessory(
    lightEntry,
    accessory as unknown as PlatformAccessory,
    hap,
    logger,
    { enableColor: true, fxPresets: [], rgbwPresets: [] },
    0,
  );
  const service = accessory.getService("Lightbulb") as FakeService;
  const originalMireds = light.currentState.mireds;

  service.getCharacteristic("Hue").set(300);
  service.getCharacteristic("Saturation").set(100);
  expect(service.getCharacteristic("ColorTemperature").value).toBe(HOMEKIT_MIRED_MIN);

  service.getCharacteristic("ColorTemperature").set(250);

  expect(light.currentState.mode).toBe("hsi");
  expect(light.currentState.hue).toBe(300);
  expect(light.currentState.saturation).toBe(100);
  expect(light.currentState.mireds).toBe(originalMireds);
  expect(service.getCharacteristic("ColorTemperature").value).toBe(HOMEKIT_MIRED_MIN);
});

test("HomeKit color temperature writes publish matching hue and saturation values", () => {
  const accessory = new FakeAccessory();
  const light = new GodoxLightAccessory(
    lightEntry,
    accessory as unknown as PlatformAccessory,
    hap,
    logger,
    { enableColor: true, fxPresets: [], rgbwPresets: [] },
    0,
  );
  const service = accessory.getService("Lightbulb") as FakeService;

  service.getCharacteristic("ColorTemperature").set(250);

  expect(light.currentState.mode).toBe("cct");
  expect(light.currentState.mireds).toBe(250);
  expect(light.currentState.hue).toBe(25);
  expect(light.currentState.saturation).toBe(21);
  expect(service.getCharacteristic("Hue").value).toBe(25);
  expect(service.getCharacteristic("Saturation").value).toBe(21);
});
