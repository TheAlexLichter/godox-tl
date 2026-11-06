import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { Deferred, Effect } from "effect";
import {
  GodoxLightAccessory,
  HOMEKIT_MIRED_MAX,
  HOMEKIT_MIRED_MIN,
  clampMireds,
  kelvinToMireds,
  MIRED_MAX,
  MIRED_MIN,
  miredsToKelvin,
  type HomeKitFeatureConfig,
} from "../src/accessory.ts";
import type { LightEntry } from "@godox-tl/core";
import type { HAP, Logger, PlatformAccessory } from "homebridge";

const { send, close } = vi.hoisted(() => ({ send: vi.fn(), close: vi.fn() }));

vi.mock("@godox-tl/mesh", () => ({ makeMeshController: () => ({ send, close }) }));

beforeEach(() => {
  vi.useFakeTimers();
  send.mockReset().mockReturnValue(Effect.void);
  close.mockReset().mockReturnValue(Effect.void);
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

test("mireds<->kelvin round-trips within the supported range", () => {
  expect(miredsToKelvin(MIRED_MIN)).toBe(6494);
  expect(miredsToKelvin(MIRED_MAX)).toBe(2703);
  expect(kelvinToMireds(2700)).toBe(MIRED_MAX);
  expect(kelvinToMireds(6500)).toBe(MIRED_MIN);
});

test("mireds<->kelvin clamps to the Godox supported range", () => {
  expect(miredsToKelvin(100)).toBe(6500);
  expect(miredsToKelvin(1000)).toBe(2700);
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
  private getHandler: (() => unknown) | undefined;

  setProps(): this {
    return this;
  }

  onSet(handler: (value: unknown) => unknown): this {
    this.setHandler = handler;
    return this;
  }

  onGet(handler: () => unknown): this {
    this.getHandler = handler;
    return this;
  }

  updateValue(value: unknown): this {
    this.value = value;
    return this;
  }

  set(value: unknown): unknown {
    this.value = value;
    return this.setHandler?.(value);
  }

  get(): unknown {
    return this.getHandler?.();
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

  addService(name: string, _serviceName?: string, subtype?: string): FakeService {
    const service = new FakeService();
    this.services.set(subtype ? `${name}:${subtype}` : name, service);
    return service;
  }

  getServiceById(name: string, subtype: string): FakeService | undefined {
    return this.services.get(`${name}:${subtype}`);
  }
}

class FakeHapStatusError extends Error {
  constructor(readonly hapStatus: number) {
    super(`HAP status ${hapStatus}`);
  }
}

const hap = {
  HapStatusError: FakeHapStatusError,
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

test("HomeKit preserves a 2700K request within its broader accepted mired range", () => {
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

  service.getCharacteristic("ColorTemperature").set(370);
  expect(light.currentState.mode).toBe("cct");
  expect(light.currentState.mireds).toBe(370);
  expect(miredsToKelvin(light.currentState.mireds)).toBe(2703);

  service.getCharacteristic("ColorTemperature").set(HOMEKIT_MIRED_MAX);
  expect(light.currentState.mireds).toBe(370);
});

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

const makeCommunicationHarness = (
  features: HomeKitFeatureConfig = { enableColor: true, fxPresets: [], rgbwPresets: [] },
) => {
  const accessory = new FakeAccessory();
  const light = new GodoxLightAccessory(
    lightEntry,
    accessory as unknown as PlatformAccessory,
    hap,
    logger,
    features,
    100,
  );
  const service = accessory.getService("Lightbulb") as FakeService;
  return { accessory, light, service };
};

const expectCommunicationFailure = (characteristic: FakeCharacteristic): void => {
  expect(() => characteristic.get()).toThrow(FakeHapStatusError);
  expect(() => characteristic.get()).toThrow("HAP status -70402");
};

test("transport failures report No Response on control reads and preserve desired settings", async () => {
  send.mockReturnValueOnce(Effect.fail(new Error("light unavailable")));
  const { light, service } = makeCommunicationHarness();

  expect(service.getCharacteristic("Hue").set(210)).toBeUndefined();
  service.getCharacteristic("Saturation").set(65);
  service.getCharacteristic("Brightness").set(35);
  expect(send).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(100);

  expect(send).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenCalledWith(
    expect.objectContaining({
      _tag: "Hsi",
      brightness: 35,
      hue: 210,
      saturation: 65,
    }),
  );
  for (const name of ["On", "Brightness", "ColorTemperature", "Hue", "Saturation"]) {
    expectCommunicationFailure(service.getCharacteristic(name));
  }
  expect(light.currentState).toMatchObject({
    on: true,
    brightness: 35,
    mode: "hsi",
    hue: 210,
    saturation: 65,
  });

  service.getCharacteristic("On").set(true);
  expectCommunicationFailure(service.getCharacteristic("On"));
  await vi.advanceTimersByTimeAsync(100);

  expect(service.getCharacteristic("On").get()).toBe(true);
  expect(service.getCharacteristic("Brightness").get()).toBe(35);
  expect(service.getCharacteristic("Hue").get()).toBe(210);
  expect(service.getCharacteristic("Saturation").get()).toBe(65);
  expect(service.getCharacteristic("ColorTemperature").get()).toBe(HOMEKIT_MIRED_MIN);
});

test("an older failed command cannot replace a newer successful result", async () => {
  const first = await Effect.runPromise(Deferred.make<void, Error>());
  send.mockReturnValueOnce(Deferred.await(first));
  const { service } = makeCommunicationHarness();
  service.getCharacteristic("Brightness").set(20);
  await vi.advanceTimersByTimeAsync(100);
  service.getCharacteristic("Brightness").set(40);
  await vi.advanceTimersByTimeAsync(100);

  await Effect.runPromise(Deferred.fail(first, new Error("old connection failed")));
  await vi.advanceTimersByTimeAsync(0);
  expect(service.getCharacteristic("Brightness").get()).toBe(40);
});

test("an older successful command cannot clear a newer transport failure", async () => {
  const first = await Effect.runPromise(Deferred.make<void, Error>());
  send.mockReturnValueOnce(Deferred.await(first));
  send.mockReturnValueOnce(Effect.fail(new Error("new connection failed")));
  const { service } = makeCommunicationHarness();
  service.getCharacteristic("Brightness").set(20);
  await vi.advanceTimersByTimeAsync(100);
  service.getCharacteristic("Brightness").set(40);
  await vi.advanceTimersByTimeAsync(100);

  await Effect.runPromise(Deferred.succeed(first, undefined));
  await vi.advanceTimersByTimeAsync(0);
  expectCommunicationFailure(service.getCharacteristic("Brightness"));
});

test("unexpected command failures also report No Response", async () => {
  send.mockReturnValueOnce(Effect.die(new Error("unexpected transport failure")));
  const { service } = makeCommunicationHarness();
  service.getCharacteristic("On").set(true);
  await vi.advanceTimersByTimeAsync(100);

  expectCommunicationFailure(service.getCharacteristic("On"));
});

test("preset failures affect both light and preset reads until a successful preset command", async () => {
  const { accessory, service } = makeCommunicationHarness({
    enableColor: true,
    fxPresets: [{ name: "Candle", brightness: 20, effect: 7, subtype: 0, filter: 0 }],
    rgbwPresets: [{ name: "Red", brightness: 25, red: 255, green: 0, blue: 0, white: 0 }],
  });
  const fx = accessory.getServiceById("Switch", "fx-0")!.getCharacteristic("On");
  const rgbw = accessory.getServiceById("Switch", "rgbw-0")!.getCharacteristic("On");
  send.mockReturnValueOnce(Effect.fail(new Error("preset unavailable")));
  expect(fx.set(true)).toBeUndefined();
  await vi.advanceTimersByTimeAsync(0);

  expect(fx.value).toBe(false);
  expectCommunicationFailure(fx);
  expectCommunicationFailure(rgbw);
  expectCommunicationFailure(service.getCharacteristic("On"));

  rgbw.set(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(fx.get()).toBe(false);
  expect(rgbw.get()).toBe(false);
  expect(service.getCharacteristic("On").get()).toBe(true);
  expect(service.getCharacteristic("Brightness").get()).toBe(25);
});

test("disposing cancels debounced HomeKit changes and closes the controller once", async () => {
  const { light, service } = makeCommunicationHarness();
  service.getCharacteristic("Brightness").set(45);
  await Promise.all([light.dispose(), light.dispose()]);
  await vi.advanceTimersByTimeAsync(500);
  expect(send).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledTimes(1);
  expect(() => service.getCharacteristic("Brightness").set(60)).toThrow(FakeHapStatusError);
});

test("disposing prevents preset commands and delayed reset callbacks", async () => {
  const { accessory, light } = makeCommunicationHarness({
    enableColor: true,
    fxPresets: [{ name: "test", brightness: 30, effect: 1, subtype: 0, filter: 0 }],
    rgbwPresets: [],
  });
  await light.dispose();
  const preset = accessory.getServiceById("Switch", "fx-0")!;
  preset.getCharacteristic("On").set(true);
  await vi.advanceTimersByTimeAsync(500);
  expect(send).not.toHaveBeenCalled();
});
