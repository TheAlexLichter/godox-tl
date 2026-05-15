import { expect, test } from "vite-plus/test";
import { expandName, resolveConfig, shortAddr, statesDirForRegistry } from "../src/config.ts";

test("resolveConfig applies sensible defaults", () => {
  const cfg = resolveConfig({});
  expect(cfg.discoveryMode).toBe("merge");
  expect(cfg.autoProvision).toBe(false);
  expect(cfg.startupScan).toBe(true);
  expect(cfg.startupPruneMissing).toBe(false);
  expect(cfg.autoProvisionOnStartup).toBe(true);
  expect(cfg.scanIntervalSeconds).toBe(60);
  expect(cfg.nameTemplate).toBe("godox-{shortAddr}");
  expect(cfg.enableColor).toBe(true);
  expect(cfg.fxPresets).toEqual([]);
  expect(cfg.rgbwPresets).toEqual([]);
  expect(cfg.discoveryFilters).toHaveLength(1);
  expect(cfg.discoveryFilters[0]!.test("GD_LED")).toBe(true);
  expect(cfg.discoveryFilters[0]!.test("Random Phone")).toBe(false);
  expect(cfg.manualLights).toEqual([]);
});

test("resolveConfig uses the provided Homebridge registry default", () => {
  const cfg = resolveConfig(
    {},
    { defaultRegistryPath: "/var/lib/homebridge/godox-tl/registry.json" },
  );
  expect(cfg.registryPath).toBe("/var/lib/homebridge/godox-tl/registry.json");
});

test("resolveConfig keeps explicit registryPath for shared CLI registries", () => {
  const cfg = resolveConfig(
    { registryPath: "/home/pi/.config/godox-tl/registry.json" },
    { defaultRegistryPath: "/var/lib/homebridge/godox-tl/registry.json" },
  );
  expect(cfg.registryPath).toBe("/home/pi/.config/godox-tl/registry.json");
});

test("statesDirForRegistry stores state files next to the registry", () => {
  expect(statesDirForRegistry("/var/lib/homebridge/godox-tl/registry.json")).toBe(
    "/var/lib/homebridge/godox-tl/states",
  );
});

test("resolveConfig normalizes effect and RGBW presets", () => {
  const cfg = resolveConfig({
    fxPresets: [
      { name: "party", brightness: 150, effect: 2, level: 3, filter: -1 },
      { name: "ignored" },
    ],
    rgbwPresets: [{ name: "red", brightness: 10, red: 255, green: -20, blue: 999, white: 1 }, {}],
  });

  expect(cfg.fxPresets).toEqual([
    {
      name: "party",
      brightness: 100,
      effect: 2,
      subtype: 3,
      filter: 0,
    },
  ]);
  expect(cfg.rgbwPresets).toEqual([
    {
      name: "red",
      brightness: 10,
      red: 255,
      green: 0,
      blue: 255,
      white: 1,
    },
  ]);
});

test("resolveConfig clamps scanIntervalSeconds to a sane minimum", () => {
  expect(resolveConfig({ scanIntervalSeconds: 1 }).scanIntervalSeconds).toBe(10);
  expect(resolveConfig({ scanIntervalSeconds: 120 }).scanIntervalSeconds).toBe(120);
});

test("resolveConfig keeps manual lights with required fields", () => {
  const cfg = resolveConfig({
    lights: [
      { name: "kitchen", address: "AA:BB", statePath: "/tmp/k.json" },
      { name: "bad-no-addr" } as never,
    ],
  });
  expect(cfg.manualLights).toHaveLength(1);
  expect(cfg.manualLights[0]?.name).toBe("kitchen");
});

test("resolveConfig compiles custom regex filters", () => {
  const cfg = resolveConfig({ discoveryFilters: ["^GD_", "Godox.+"] });
  expect(cfg.discoveryFilters[0]!.test("GD_LED")).toBe(true);
  expect(cfg.discoveryFilters[1]!.test("Godox Strip")).toBe(true);
  expect(cfg.discoveryFilters[0]!.test("Foo")).toBe(false);
});

test("shortAddr drops separators and lowercases", () => {
  expect(shortAddr("AA:BB:CC:11:22:33")).toBe("112233");
  expect(shortAddr("83E72030-EF94-6299-21DD-372408DE38C2")).toBe("de38c2");
});

test("expandName fills the shortAddr placeholder", () => {
  expect(expandName("godox-{shortAddr}", "AA:BB:CC:11:22:33")).toBe("godox-112233");
  expect(expandName("light", "AA:BB:CC:11:22:33")).toBe("light");
});
