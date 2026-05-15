import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LightEntry } from "@godox-tl/core";
import { Effect, Exit } from "effect";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import {
  __setNobleForTesting,
  MESH_PROVISIONING_SERVICE_UUID,
  MESH_PROXY_SERVICE_UUID,
} from "@godox-tl/mesh";
import type { NobleLike, PeripheralLike } from "@godox-tl/mesh";
import { runDiscoveryCycle, runStartupScan } from "../src/discovery.ts";
import type { ResolvedConfig } from "../src/config.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "godox-homebridge-discovery-"));
});

afterEach(async () => {
  __setNobleForTesting(undefined);
  await rm(dir, { recursive: true, force: true });
});

class FailingProvisionNoble extends EventEmitter implements NobleLike {
  state = "poweredOn";
  startCount = 0;

  async startScanningAsync(): Promise<void> {
    this.startCount++;
    const peripheral: PeripheralLike & {
      connectAsync: () => Promise<void>;
      disconnectAsync: () => Promise<void>;
    } = {
      id: "aabbccddeeff",
      uuid: "aabbccddeeff",
      address: "AA:BB:CC:DD:EE:FF",
      rssi: -50,
      advertisement: {
        localName: "GD_LED",
        serviceUuids: [MESH_PROVISIONING_SERVICE_UUID],
      },
      connectAsync: async () => {
        throw new Error("synthetic provisioning failure");
      },
      disconnectAsync: async () => {},
    };
    queueMicrotask(() => this.emit("discover", peripheral));
  }

  async stopScanningAsync(): Promise<void> {}
}

class FailingScanNoble extends EventEmitter implements NobleLike {
  state = "poweredOn";

  async startScanningAsync(): Promise<void> {
    throw new Error("synthetic scan failure");
  }

  async stopScanningAsync(): Promise<void> {}
}

const config = (registryPath: string): ResolvedConfig => ({
  registryPath,
  discoveryMode: "merge",
  autoProvision: true,
  startupScan: true,
  startupPruneMissing: false,
  autoProvisionOnStartup: true,
  scanIntervalSeconds: 0.01,
  discoveryFilters: [/^GD_LED$/],
  nameTemplate: "godox-{shortAddr}",
  enableColor: true,
  fxPresets: [],
  rgbwPresets: [],
  manualLights: [],
});

const lightEntry = (name: string, address: string): LightEntry => ({
  name,
  address,
  statePath: join(dir, "states", `${name}.json`),
  provisionedAt: new Date(0).toISOString(),
});

class OneProvisionedScanNoble extends EventEmitter implements NobleLike {
  state = "poweredOn";

  async startScanningAsync(): Promise<void> {
    const peripheral: PeripheralLike = {
      id: "aabbccddeeff",
      uuid: "aabbccddeeff",
      address: "AA:BB:CC:DD:EE:FF",
      rssi: -50,
      advertisement: {
        localName: "GD_LED",
        serviceUuids: [MESH_PROXY_SERVICE_UUID],
      },
    };
    queueMicrotask(() => this.emit("discover", peripheral));
  }

  async stopScanningAsync(): Promise<void> {}
}

test("runDiscoveryCycle treats unexpected auto-provision failures as transient skips", async () => {
  const noble = new FailingProvisionNoble();
  __setNobleForTesting(noble);
  const exit = await Effect.runPromiseExit(
    runDiscoveryCycle(config(join(dir, "registry.json")), new Set()),
  );
  expect(Exit.isSuccess(exit)).toBe(true);
  if (Exit.isSuccess(exit)) {
    expect(exit.value).toEqual([]);
  }
  expect(noble.startCount).toBeGreaterThan(1);
});

test("runDiscoveryCycle reprovisions an unprovisioned device even when its address is known", async () => {
  const noble = new FailingProvisionNoble();
  __setNobleForTesting(noble);
  const exit = await Effect.runPromiseExit(
    runDiscoveryCycle(config(join(dir, "registry.json")), new Set(["AA:BB:CC:DD:EE:FF"])),
  );
  expect(Exit.isSuccess(exit)).toBe(true);
  if (Exit.isSuccess(exit)) {
    expect(exit.value).toEqual([]);
  }
  expect(noble.startCount).toBeGreaterThan(1);
});

test("runDiscoveryCycle treats scan failures as an empty discovery result", async () => {
  __setNobleForTesting(new FailingScanNoble());
  const exit = await Effect.runPromiseExit(
    runDiscoveryCycle(config(join(dir, "registry.json")), new Set()),
  );
  expect(Exit.isSuccess(exit)).toBe(true);
  if (Exit.isSuccess(exit)) {
    expect(exit.value).toEqual([]);
  }
});

test("runStartupScan keeps known lights missed by a short startup scan by default", async () => {
  __setNobleForTesting(new OneProvisionedScanNoble());
  const cfg = config(join(dir, "registry.json"));
  const entries = [
    lightEntry("seen", "AA:BB:CC:DD:EE:FF"),
    lightEntry("missed", "11:22:33:44:55:66"),
  ];

  const result = await Effect.runPromise(runStartupScan(cfg, entries));

  expect(result.entries.map((e) => e.name)).toEqual(["seen", "missed"]);
});

test("runStartupScan does not provision by default", async () => {
  const noble = new FailingProvisionNoble();
  __setNobleForTesting(noble);
  const cfg = {
    ...config(join(dir, "registry.json")),
    autoProvision: false,
    autoProvisionOnStartup: false,
  };

  const result = await Effect.runPromise(runStartupScan(cfg, []));

  expect(result.entries).toEqual([]);
  expect(result.provisioned).toEqual([]);
  expect(noble.startCount).toBe(1);
});

test("runStartupScan prunes missed known lights only when explicitly enabled", async () => {
  __setNobleForTesting(new OneProvisionedScanNoble());
  const cfg = { ...config(join(dir, "registry.json")), startupPruneMissing: true };
  const entries = [
    lightEntry("seen", "AA:BB:CC:DD:EE:FF"),
    lightEntry("missed", "11:22:33:44:55:66"),
  ];

  const result = await Effect.runPromise(runStartupScan(cfg, entries));

  expect(result.entries.map((e) => e.name)).toEqual(["seen"]);
});

test("runStartupScan recovers pruned lights from state files when the scan sees them", async () => {
  __setNobleForTesting(new OneProvisionedScanNoble());
  const cfg = config(join(dir, "registry.json"));
  const statesDir = join(dir, "states");
  await mkdir(statesDir, { recursive: true });
  await writeFile(
    join(statesDir, "seen.json"),
    JSON.stringify({
      device_address: "AA:BB:CC:DD:EE:FF",
      node_address: 3,
    }),
  );

  const result = await Effect.runPromise(runStartupScan(cfg, []));

  expect(result.entries.map((e) => `${e.name}@${e.address}`)).toEqual([
    "godox-ddeeff@AA:BB:CC:DD:EE:FF",
  ]);
});

test("runStartupScan does not recover old state files for devices missed by the scan", async () => {
  __setNobleForTesting(new OneProvisionedScanNoble());
  const cfg = config(join(dir, "registry.json"));
  const statesDir = join(dir, "states");
  await mkdir(statesDir, { recursive: true });
  await writeFile(
    join(statesDir, "old.json"),
    JSON.stringify({
      device_address: "11:22:33:44:55:66",
      node_address: 3,
    }),
  );

  const result = await Effect.runPromise(
    runStartupScan(cfg, [lightEntry("seen", "AA:BB:CC:DD:EE:FF")]),
  );

  expect(result.entries.map((e) => e.name)).toEqual(["seen"]);
});
