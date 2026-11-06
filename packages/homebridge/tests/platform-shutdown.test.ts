import { Effect } from "effect";
import type { API, Logger, PlatformAccessory } from "homebridge";
import { beforeEach, expect, test, vi } from "vite-plus/test";
import { GodoxTLPlatform } from "../src/platform.ts";

const { discover, startup, cycle, dispose, materialized } = vi.hoisted(() => ({
  discover: vi.fn(),
  startup: vi.fn(),
  cycle: vi.fn(),
  dispose: vi.fn(),
  materialized: vi.fn(),
}));
vi.mock("../src/discovery.ts", () => ({
  discoverKnownLights: discover,
  runStartupScan: startup,
  runDiscoveryCycle: cycle,
}));
vi.mock("../src/accessory.ts", () => ({
  GodoxLightAccessory: class {
    constructor(...args: unknown[]) {
      materialized(...args);
    }
    dispose = dispose;
  },
}));
const signal = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
beforeEach(() => {
  vi.useRealTimers();
  discover.mockReset().mockReturnValue(Effect.succeed([]));
  startup.mockReset().mockReturnValue(Effect.succeed({ entries: [], provisioned: [] }));
  cycle.mockReset().mockReturnValue(Effect.succeed([]));
  dispose.mockReset().mockResolvedValue(undefined);
  materialized.mockReset();
});
const harness = (autoProvision = false) => {
  const handlers = new Map<string, () => void>();
  const register = vi.fn();
  const api = {
    user: { storagePath: () => "/tmp/homebridge-shutdown" },
    hap: { uuid: { generate: (id: string) => id } },
    on: (name: string, callback: () => void) => {
      handlers.set(name, callback);
    },
    registerPlatformAccessories: register,
  } as unknown as API;
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
  const platform = new GodoxTLPlatform(log, { platform: "GodoxTL", autoProvision }, api);
  return { platform, handlers, register };
};

test("shutdown cancels active startup discovery and waits for its finalizer", async () => {
  const started = signal();
  const cleaning = signal();
  const release = signal();
  discover.mockReturnValue(
    Effect.sync(started.resolve).pipe(
      Effect.andThen(Effect.never),
      Effect.ensuring(
        Effect.sync(cleaning.resolve).pipe(Effect.andThen(Effect.promise(() => release.promise))),
      ),
    ),
  );
  const { platform, handlers, register } = harness();
  handlers.get("didFinishLaunching")!();
  await started.promise;
  let finished = false;
  const stopping = platform.shutdown().then(() => {
    finished = true;
  });
  await cleaning.promise;
  expect(finished).toBe(false);
  release.resolve();
  await stopping;
  handlers.get("didFinishLaunching")!();
  expect(discover).toHaveBeenCalledTimes(1);
  expect(startup).not.toHaveBeenCalled();
  expect(register).not.toHaveBeenCalled();
});

test("shutdown cancels periodic discovery and disposes materialized accessories once", async () => {
  const started = signal();
  const interrupted = vi.fn();
  cycle.mockReturnValue(
    Effect.sync(started.resolve).pipe(
      Effect.andThen(Effect.never),
      Effect.onInterrupt(() => Effect.sync(interrupted)),
    ),
  );
  const { platform, handlers } = harness(true);
  const accessory = {} as PlatformAccessory;
  const light = { dispose };
  platform.accessoriesByUUID.set("light", { accessory, light } as never);
  // Startup reconciliation would discard the fixture, so start the periodic
  // cycle directly while exercising the same tracked discovery runner.
  const scanning = (platform as unknown as { scanCycle(): Promise<void> }).scanCycle();
  await started.promise;
  handlers.get("shutdown")!();
  await platform.shutdown();
  await scanning;
  await platform.shutdown();
  expect(interrupted).toHaveBeenCalledTimes(1);
  expect(dispose).toHaveBeenCalledTimes(1);
  expect(cycle).toHaveBeenCalledTimes(1);
});

test("startup results cannot materialize controllers after shutdown", async () => {
  const started = signal();
  let resolve!: (value: { entries: unknown[]; provisioned: unknown[] }) => void;
  const result = new Promise<{ entries: unknown[]; provisioned: unknown[] }>((r) => {
    resolve = r;
  });
  startup.mockReturnValue(
    Effect.sync(started.resolve).pipe(Effect.andThen(Effect.promise(() => result))),
  );
  const { platform, handlers, register } = harness();
  handlers.get("didFinishLaunching")!();
  await started.promise;
  await platform.shutdown();
  resolve({
    entries: [{ name: "late", address: "AA", statePath: "/tmp/missing.json" }],
    provisioned: [],
  });
  await Promise.resolve();
  expect(materialized).not.toHaveBeenCalled();
  expect(register).not.toHaveBeenCalled();
});

test("shutdown clears the periodic timer before another scan can start", async () => {
  vi.useFakeTimers();
  const scanned = signal();
  cycle.mockReturnValue(Effect.sync(scanned.resolve).pipe(Effect.as([])));
  const { platform, handlers } = harness(true);
  handlers.get("didFinishLaunching")!();
  await scanned.promise;
  await platform.shutdown();
  await vi.advanceTimersByTimeAsync(120_000);
  expect(cycle).toHaveBeenCalledTimes(1);
  vi.useRealTimers();
});
