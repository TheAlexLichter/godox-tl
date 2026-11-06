import { EventEmitter } from "node:events";
import { Cause, Effect, Exit, Fiber, Option } from "effect";
import { afterEach, expect, test } from "vite-plus/test";
import {
  connectProxyWriter,
  scanDevices,
  shutdownNoble,
  __setNobleForTesting,
} from "../src/ble/index.ts";
import { BleError } from "../src/ble/errors.ts";
import { getNoble, type NobleLike } from "../src/ble/noble.ts";

const gate = () => {
  let release = (): void => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

class GatedNoble extends EventEmitter implements NobleLike {
  state = "poweredOn";
  starts = 0;
  stops = 0;
  connects = 0;
  scanning = false;
  bindingStops = 0;
  readonly firstStarted = gate();
  readonly releaseFirstStart = gate();
  readonly firstStopping = gate();
  readonly releaseFirstStop = gate();
  readonly secondStarted = gate();

  async startScanningAsync(): Promise<void> {
    this.starts++;
    if (this.starts === 1) {
      this.firstStarted.release();
      await this.releaseFirstStart.promise;
    } else {
      this.secondStarted.release();
    }
    this.scanning = true;
    queueMicrotask(() =>
      this.emit("discover", {
        address: "AA:BB:CC:DD:EE:FF",
        advertisement: { localName: "GD_LED", serviceUuids: ["1828"] },
        connectAsync: async () => {
          this.connects++;
        },
        disconnectAsync: async () => {},
        discoverServicesAsync: async () => [],
      }),
    );
  }

  async stopScanningAsync(): Promise<void> {
    this.stops++;
    if (this.stops === 1) {
      this.firstStopping.release();
      await this.releaseFirstStop.promise;
    }
    this.scanning = false;
  }

  stop(): void {
    this.bindingStops++;
  }
}

const firstScan = (
  kind: "discovery" | "peripheral",
  noble: GatedNoble,
): Effect.Effect<unknown, BleError> =>
  kind === "discovery"
    ? scanDevices({ timeoutSeconds: 0.1 }, noble)
    : connectProxyWriter("11:22:33:44:55:66", { findPeripheralTimeoutMs: 100 });

afterEach(() => {
  __setNobleForTesting(undefined);
});

test.each(["discovery", "peripheral"] as const)(
  "%s cancellation awaits scan start and shutdown before the next scan",
  async (kind) => {
    const noble = new GatedNoble();
    __setNobleForTesting(noble);
    const first = Effect.runFork(firstScan(kind, noble));
    await noble.firstStarted.promise;
    const interrupted = Effect.runPromise(
      Fiber.interrupt(first).pipe(Effect.andThen(Fiber.await(first))),
    );
    await tick();
    expect(noble.listenerCount("discover")).toBe(0);

    const second = Effect.runPromise(scanDevices({ timeoutSeconds: 0.25 }, noble));
    expect(noble.starts).toBe(1);
    expect(noble.stops).toBe(0);
    noble.releaseFirstStart.release();
    await noble.firstStopping.promise;
    expect(noble.starts).toBe(1);
    noble.releaseFirstStop.release();
    expect(Exit.hasInterrupts(await interrupted)).toBe(true);
    await noble.secondStarted.promise;
    // The first scan's original timer must not stop this newer scan.
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(noble.scanning).toBe(true);
    expect(noble.stops).toBe(1);
    expect(await second).toHaveLength(1);
    expect(noble.stops).toBe(2);
    expect(noble.listenerCount("discover")).toBe(0);
  },
);

test.each(["discovery", "peripheral"] as const)(
  "%s cancellation stays bounded and guards against a late native shutdown",
  async (kind) => {
    const noble = new GatedNoble();
    __setNobleForTesting(noble);
    const first = Effect.runFork(firstScan(kind, noble));
    await noble.firstStarted.promise;
    const startedAt = Date.now();
    const interrupted = await Effect.runPromise(
      Fiber.interrupt(first).pipe(Effect.andThen(Fiber.await(first))),
    );
    expect(Exit.hasInterrupts(interrupted)).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(4_500);
    expect(noble.listenerCount("discover")).toBe(0);
    expect(noble.stops).toBe(0);

    expect(Exit.isFailure(await Effect.runPromiseExit(getNoble))).toBe(true);
    expect(Exit.isFailure(await Effect.runPromiseExit(scanDevices({}, noble)))).toBe(true);
    expect(noble.starts).toBe(1);

    noble.releaseFirstStart.release();
    await noble.firstStopping.promise;
    expect(Exit.isFailure(await Effect.runPromiseExit(scanDevices({}, noble)))).toBe(true);
    expect(noble.starts).toBe(1);
    noble.releaseFirstStop.release();
    await tick();

    expect(await Effect.runPromise(scanDevices({ timeoutSeconds: 0.01 }, noble))).toHaveLength(1);
    expect(noble.starts).toBe(2);
    expect(noble.stops).toBe(2);
    expect(noble.scanning).toBe(false);
  },
  6_000,
);

test.each(["discovery", "peripheral"] as const)(
  "%s cancellation removes the power-state listener without starting a scan",
  async (kind) => {
    const noble = new GatedNoble();
    noble.state = "poweredOff";
    __setNobleForTesting(noble);
    const first = Effect.runFork(firstScan(kind, noble));
    await tick();
    expect(noble.listenerCount("stateChange")).toBe(1);
    expect(
      Exit.hasInterrupts(
        await Effect.runPromise(Fiber.interrupt(first).pipe(Effect.andThen(Fiber.await(first)))),
      ),
    ).toBe(true);
    expect(noble.listenerCount("stateChange")).toBe(0);
    noble.emit("stateChange", "poweredOn");
    await tick();
    expect(noble.starts).toBe(0);
    expect(noble.stops).toBe(0);
  },
);

test("successful discovery awaits native scan shutdown before resolving", async () => {
  const noble = new GatedNoble();
  noble.releaseFirstStart.release();
  let resolved = false;
  const scan = Effect.runPromise(scanDevices({ timeoutSeconds: 0.01 }, noble)).then((devices) => {
    resolved = true;
    return devices;
  });
  await noble.firstStopping.promise;
  expect(resolved).toBe(false);
  expect(noble.listenerCount("discover")).toBe(0);
  noble.releaseFirstStop.release();
  expect(await scan).toHaveLength(1);
  expect(resolved).toBe(true);
});

test.each(["discovery", "peripheral"] as const)(
  "%s returns a typed failure after scan shutdown rejects and allows a fresh attempt",
  async (kind) => {
    const stopFailure = new Error("adapter rejected scan shutdown");
    class RejectingStopNoble extends GatedNoble {
      override async stopScanningAsync(): Promise<void> {
        this.stops++;
        if (this.stops === 1) throw stopFailure;
        this.scanning = false;
      }
    }
    const noble = new RejectingStopNoble();
    noble.releaseFirstStart.release();
    __setNobleForTesting(noble);
    const scan: Effect.Effect<unknown, BleError> =
      kind === "discovery"
        ? scanDevices({ timeoutSeconds: 0.01 }, noble)
        : connectProxyWriter("AA:BB:CC:DD:EE:FF", { findPeripheralTimeoutMs: 100 });
    const exit = await Effect.runPromiseExit(scan);
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(
        exit.cause.reasons.filter(Cause.isDieReason).map((reason) => reason.defect),
      ).toHaveLength(0);
      const failure = Cause.findErrorOption(exit.cause);
      expect(Option.isSome(failure)).toBe(true);
      if (Option.isSome(failure)) {
        expect(failure.value).toBeInstanceOf(BleError);
        expect(failure.value.cause).toBe(stopFailure);
        expect(failure.value.message).toContain("Failed to stop BLE scan");
      }
    }
    expect(noble.connects).toBe(0);
    expect(noble.listenerCount("discover")).toBe(0);
    expect(await Effect.runPromise(getNoble)).toBe(noble);
    expect(await Effect.runPromise(scanDevices({ timeoutSeconds: 0.01 }, noble))).toHaveLength(1);
    expect(noble.starts).toBe(2);
    expect(noble.stops).toBe(2);
    expect(noble.scanning).toBe(false);
  },
);

test("successful discovery fails promptly when native shutdown stays pending", async () => {
  const noble = new GatedNoble();
  noble.releaseFirstStart.release();
  const scan = Effect.runPromiseExit(scanDevices({ timeoutSeconds: 0.01 }, noble));
  await noble.firstStopping.promise;
  const exit = await scan;
  expect(Exit.isFailure(exit)).toBe(true);
  expect(noble.listenerCount("discover")).toBe(0);
  expect(noble.starts).toBe(1);
  expect(Exit.isFailure(await Effect.runPromiseExit(scanDevices({}, noble)))).toBe(true);
  expect(noble.starts).toBe(1);
  noble.releaseFirstStop.release();
  await tick();

  expect(await Effect.runPromise(scanDevices({ timeoutSeconds: 0.01 }, noble))).toHaveLength(1);
}, 6_000);

test("shutdownNoble bounds a stuck stop without stopping a replacement adapter", async () => {
  const oldNoble = new GatedNoble();
  __setNobleForTesting(oldNoble);
  const startedAt = Date.now();
  const shutdown = Effect.runPromise(shutdownNoble);
  await oldNoble.firstStopping.promise;

  const replacement = new GatedNoble();
  replacement.releaseFirstStart.release();
  replacement.releaseFirstStop.release();
  __setNobleForTesting(replacement);
  await shutdown;
  expect(Date.now() - startedAt).toBeLessThan(4_500);
  expect(oldNoble.bindingStops).toBe(1);
  expect(replacement.bindingStops).toBe(0);
  expect(await Effect.runPromise(getNoble)).toBe(replacement);

  const scan = Effect.runPromise(scanDevices({ timeoutSeconds: 0.1 }, replacement));
  await replacement.firstStarted.promise;
  await tick();
  expect(replacement.scanning).toBe(true);
  oldNoble.releaseFirstStop.release();
  await tick();
  expect(replacement.scanning).toBe(true);
  expect(replacement.stops).toBe(0);
  expect(await scan).toHaveLength(1);
}, 6_000);
