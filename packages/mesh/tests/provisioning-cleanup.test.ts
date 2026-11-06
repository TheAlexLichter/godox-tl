import { EventEmitter } from "node:events";
import { Effect, Exit, References, Scope } from "effect";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { connectProvisioning } from "../src/ble/provisioning.ts";
import { connectProxyWriter } from "../src/ble/proxy.ts";
import { BleError } from "../src/ble/errors.ts";
import { __setNobleForTesting, getNoble, type NobleLike } from "../src/ble/noble.ts";
import { scanDevices } from "../src/ble/scan.ts";

let releases: Array<() => void>;
let aborts: AbortController[];
let scopes: Scope.Closeable[];
const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  releases.push(release);
  return { promise, release };
};
beforeEach(() => {
  releases = [];
  aborts = [];
  scopes = [];
  vi.useFakeTimers();
});
afterEach(async () => {
  for (const abort of aborts) abort.abort();
  for (const release of releases) release();
  const closing = scopes.map((scope) => Effect.runPromise(Scope.close(scope, Exit.void)));
  await vi.runAllTimersAsync();
  await Promise.all(closing);
  __setNobleForTesting(undefined);
  vi.useRealTimers();
});

const harness = () => {
  const connected = gate();
  const discovering = gate();
  const characteristics = gate();
  const subscribing = gate();
  const unsubscribing = gate();
  const disconnecting = gate();
  const hooks: {
    connect?: Promise<void>;
    services?: Promise<void>;
    characteristics?: Promise<void>;
    subscribe?: Promise<void>;
    unsubscribe?: Promise<void>;
    disconnect?: Promise<void>;
    start?: Promise<void>;
    stop?: Promise<void>;
    afterConnect?: () => void;
  } = {};
  const dataOut = Object.assign(new EventEmitter(), {
    uuid: "2adc",
    subscribeAsync: vi.fn(async () => {
      subscribing.release();
      await hooks.subscribe;
    }),
    unsubscribeAsync: vi.fn(async () => {
      unsubscribing.release();
      await hooks.unsubscribe;
    }),
  });
  const service = {
    uuid: "1827",
    discoverCharacteristicsAsync: vi.fn(async () => {
      characteristics.release();
      await hooks.characteristics;
      return [
        { uuid: "2adb", properties: ["writeWithoutResponse"], writeAsync: vi.fn(async () => {}) },
        dataOut,
      ];
    }),
  };
  const peripheral = {
    address: "A4:C1:38:21:09:80",
    id: "83e72030ef94629921dd372408de38c2",
    state: "disconnected",
    advertisement: { localName: "GD_LED", serviceUuids: ["1827"] },
    cancelConnect: vi.fn(),
    connectAsync: vi.fn(async () => {
      peripheral.state = "connecting";
      connected.release();
      await hooks.connect;
      peripheral.state = "connected";
      hooks.afterConnect?.();
    }),
    disconnectAsync: vi.fn(async () => {
      disconnecting.release();
      await hooks.disconnect;
      peripheral.state = "disconnected";
    }),
    discoverServicesAsync: vi.fn(async () => {
      discovering.release();
      await hooks.services;
      return [
        service,
        {
          uuid: "1828",
          discoverCharacteristicsAsync: async () => [
            { uuid: "2add", properties: ["writeWithoutResponse"] },
          ],
        },
      ];
    }),
  };
  class Noble extends EventEmitter implements NobleLike {
    state = "poweredOn";
    scanning = false;
    autoDiscover = true;
    startScanningAsync = vi.fn(async () => {
      await hooks.start;
      this.scanning = true;
      if (this.autoDiscover) queueMicrotask(() => this.emit("discover", peripheral));
    });
    stopScanningAsync = vi.fn(async () => {
      await hooks.stop;
      this.scanning = false;
    });
    async connectAsync() {
      await peripheral.connectAsync();
      return peripheral;
    }
  }
  const noble = new Noble();
  __setNobleForTesting(noble);
  const abort = new AbortController();
  aborts.push(abort);
  const scopedOpen = () =>
    Effect.runPromiseExit(Effect.scoped(connectProvisioning(peripheral.address)), {
      signal: abort.signal,
    });
  const freshWriter = () =>
    connectProxyWriter(peripheral.address.toLowerCase(), { directAddressType: "public" });
  const openScope = async () => {
    const scope = Scope.makeUnsafe();
    scopes.push(scope);
    const opening = Effect.runPromise(
      connectProvisioning(peripheral.address).pipe(Scope.provide(scope)),
    );
    await vi.advanceTimersByTimeAsync(3000);
    const connection = await opening;
    return { scope, connection };
  };
  return {
    noble,
    peripheral,
    dataOut,
    service,
    hooks,
    abort,
    scopedOpen,
    freshWriter,
    openScope,
    connected,
    discovering,
    characteristics,
    subscribing,
    unsubscribing,
    disconnecting,
  };
};

const blocked = async (effect: Effect.Effect<unknown, BleError>) => {
  const result = Effect.runPromise(Effect.flip(effect));
  await vi.advanceTimersByTimeAsync(3000);
  const error = await result;
  expect(error).toBeInstanceOf(BleError);
  expect(error.message).toContain("replacement connection blocked");
};

test("provisioning abort removes a powered-off adapter listener without starting a scan", async () => {
  const h = harness();
  h.noble.state = "poweredOff";
  const opening = h.scopedOpen();
  await vi.advanceTimersByTimeAsync(0);
  expect(h.noble.listenerCount("stateChange")).toBe(1);
  h.abort.abort();
  expect(Exit.isFailure(await opening)).toBe(true);
  expect(h.noble.listenerCount("stateChange")).toBe(0);
  expect(h.noble.startScanningAsync).not.toHaveBeenCalled();
});

test("aborted provisioning scan bounds shutdown and fences delayed native start/stop", async () => {
  const h = harness();
  h.noble.autoDiscover = false;
  const start = gate(),
    stop = gate();
  h.hooks.start = start.promise;
  h.hooks.stop = stop.promise;
  const opening = h.scopedOpen();
  await vi.advanceTimersByTimeAsync(0);
  h.abort.abort();
  await vi.advanceTimersByTimeAsync(3000);
  expect(Exit.isFailure(await opening)).toBe(true);
  expect(h.noble.listenerCount("discover")).toBe(0);
  expect(h.noble.stopScanningAsync).not.toHaveBeenCalled();
  expect(Exit.isFailure(await Effect.runPromiseExit(getNoble))).toBe(true);
  start.release();
  await vi.advanceTimersByTimeAsync(0);
  expect(h.noble.stopScanningAsync).toHaveBeenCalledTimes(1);
  expect(Exit.isFailure(await Effect.runPromiseExit(getNoble))).toBe(true);
  stop.release();
  await vi.advanceTimersByTimeAsync(0);
  h.hooks.start = undefined;
  h.hooks.stop = undefined;
  const later = Effect.runPromise(scanDevices({ timeoutSeconds: 30 }, h.noble));
  await vi.advanceTimersByTimeAsync(26_000);
  expect(h.noble.scanning).toBe(true); // old provisioning timer was removed
  await vi.advanceTimersByTimeAsync(4000);
  await later;
  expect(h.noble.stopScanningAsync).toHaveBeenCalledTimes(2);
});

test.each(["abort", "timeout"] as const)(
  "%s of a native provisioning connect permits bounded shutdown and owns its late link",
  async (mode) => {
    const h = harness();
    const connect = gate(),
      disconnect = gate();
    h.hooks.connect = connect.promise;
    h.hooks.disconnect = disconnect.promise;
    const opening = h.scopedOpen();
    await h.connected.promise;
    if (mode === "abort") h.abort.abort();
    await vi.advanceTimersByTimeAsync(mode === "abort" ? 0 : 18_000);
    expect(Exit.isFailure(await opening)).toBe(true);
    expect(h.peripheral.cancelConnect).toHaveBeenCalledTimes(1);
    await blocked(h.freshWriter());
    expect(h.peripheral.connectAsync).toHaveBeenCalledTimes(1);
    connect.release();
    await h.disconnecting.promise;
    await blocked(h.freshWriter());
    disconnect.release();
    await vi.advanceTimersByTimeAsync(0);
    const replacement = await Effect.runPromise(h.freshWriter());
    expect(replacement.isConnected?.()).toBe(true);
    expect(h.peripheral.connectAsync).toHaveBeenCalledTimes(2);
    expect(h.peripheral.disconnectAsync).toHaveBeenCalledTimes(1);
    await Effect.runPromise(replacement.close());
  },
);

test.each(["services", "characteristics"] as const)(
  "interrupted provisioning %s discovery closes the link and fences its native task",
  async (stage) => {
    const h = harness();
    const discovery = gate();
    h.hooks[stage] = discovery.promise;
    const opening = h.scopedOpen();
    await vi.advanceTimersByTimeAsync(3000);
    await (stage === "services" ? h.discovering.promise : h.characteristics.promise);
    h.abort.abort();
    expect(Exit.isFailure(await opening)).toBe(true);
    expect(h.peripheral.disconnectAsync).toHaveBeenCalledTimes(1);
    expect(h.dataOut.listenerCount("data")).toBe(0);
    await blocked(h.freshWriter());
    discovery.release();
    await vi.advanceTimersByTimeAsync(0);
    const replacement = await Effect.runPromise(h.freshWriter());
    expect(replacement.isConnected?.()).toBe(true);
    expect(h.dataOut.subscribeAsync).not.toHaveBeenCalled();
    await Effect.runPromise(replacement.close());
  },
);

test.each(["abort", "timeout"] as const)(
  "%s during subscription removes listeners and fences late subscribe/unsubscribe",
  async (mode) => {
    const h = harness();
    const subscribe = gate(),
      unsubscribe = gate();
    h.hooks.subscribe = subscribe.promise;
    h.hooks.unsubscribe = unsubscribe.promise;
    const opening = h.scopedOpen();
    await vi.advanceTimersByTimeAsync(3000);
    await h.subscribing.promise;
    expect(h.dataOut.listenerCount("data")).toBe(1);
    if (mode === "abort") h.abort.abort();
    await vi.advanceTimersByTimeAsync(mode === "abort" ? 3000 : 18_000);
    expect(Exit.isFailure(await opening)).toBe(true);
    expect(h.dataOut.listenerCount("data")).toBe(0);
    expect(h.peripheral.disconnectAsync).toHaveBeenCalledTimes(1);
    await blocked(h.freshWriter());
    subscribe.release();
    await h.unsubscribing.promise;
    await blocked(h.freshWriter());
    unsubscribe.release();
    await vi.advanceTimersByTimeAsync(0);
    const replacement = await Effect.runPromise(h.freshWriter());
    expect(replacement.isConnected?.()).toBe(true);
    expect(h.dataOut.unsubscribeAsync).toHaveBeenCalledTimes(1);
    await Effect.runPromise(replacement.close());
  },
);

test("hung unsubscribe bounds scope release while guarding a replacement generation", async () => {
  const h = harness();
  const unsubscribe = gate();
  h.hooks.unsubscribe = unsubscribe.promise;
  const { scope } = await h.openScope();
  const closing = Effect.runPromise(Scope.close(scope, Exit.void));
  await h.unsubscribing.promise;
  await vi.advanceTimersByTimeAsync(3000);
  await closing;
  expect(h.dataOut.listenerCount("data")).toBe(0);
  expect(h.peripheral.disconnectAsync).toHaveBeenCalledTimes(1);
  await blocked(h.freshWriter());
  unsubscribe.release();
  await vi.advanceTimersByTimeAsync(0);
  const replacement = await Effect.runPromise(h.freshWriter());
  expect(replacement.isConnected?.()).toBe(true);
  await Effect.runPromise(Scope.close(scope, Exit.void));
  expect(h.peripheral.disconnectAsync).toHaveBeenCalledTimes(1);
  await Effect.runPromise(replacement.close());
});

test("subscription abort fences native cleanup before an external caller closes its scope", async () => {
  const h = harness();
  const subscribe = gate();
  h.hooks.subscribe = subscribe.promise;
  const scope = Scope.makeUnsafe();
  scopes.push(scope);
  const opening = Effect.runPromiseExit(
    connectProvisioning(h.peripheral.address).pipe(Scope.provide(scope)),
    { signal: h.abort.signal },
  );
  await vi.advanceTimersByTimeAsync(3000);
  await h.subscribing.promise;
  h.abort.abort();
  expect(Exit.isFailure(await opening)).toBe(true);
  expect(h.dataOut.listenerCount("data")).toBe(0);
  await blocked(h.freshWriter());
  subscribe.release();
  await vi.advanceTimersByTimeAsync(0);
  expect(h.dataOut.unsubscribeAsync).toHaveBeenCalledTimes(1);
  const replacement = await Effect.runPromise(h.freshWriter());
  await Effect.runPromise(Scope.close(scope, Exit.void));
  expect(h.peripheral.disconnectAsync).not.toHaveBeenCalled();
  expect(replacement.isConnected?.()).toBe(true);
  await Effect.runPromise(replacement.close());
});

test("an obsolete provisioning scope does not stop a replacement's notifications or link", async () => {
  const h = harness();
  const first = await h.openScope();
  const second = await h.openScope();
  expect(h.peripheral.discoverServicesAsync).toHaveBeenCalledWith(["1827"]);
  expect(h.service.discoverCharacteristicsAsync).toHaveBeenCalledWith(["2adb", "2adc"]);
  expect(h.dataOut.listenerCount("data")).toBe(2);
  await Effect.runPromise(Scope.close(first.scope, Exit.void));
  expect(h.dataOut.listenerCount("data")).toBe(1);
  expect(h.dataOut.unsubscribeAsync).not.toHaveBeenCalled();
  expect(h.peripheral.disconnectAsync).not.toHaveBeenCalled();
  await Effect.runPromise(Scope.close(second.scope, Exit.void));
  expect(h.dataOut.listenerCount("data")).toBe(0);
  expect(h.dataOut.unsubscribeAsync).toHaveBeenCalledTimes(1);
  expect(h.peripheral.disconnectAsync).toHaveBeenCalledTimes(1);
});

test.each([1, 2, 4, 8, 16, 32])(
  "native connection ownership survives cancellation after %i scheduler turns",
  async (turns) => {
    for (const route of ["provisioning", "writer"] as const) {
      const h = harness();
      h.hooks.afterConnect = () => {
        let remaining = turns;
        const tick = () => {
          if (--remaining > 0) setImmediate(tick);
          else h.abort.abort();
        };
        setImmediate(tick);
      };
      const effect =
        route === "provisioning"
          ? Effect.scoped(connectProvisioning(h.peripheral.address))
          : h
              .freshWriter()
              .pipe(
                Effect.flatMap((connection) =>
                  Effect.never.pipe(
                    Effect.ensuring(connection.close().pipe(Effect.catch(() => Effect.void))),
                  ),
                ),
              );
      const opening = Effect.runPromiseExit(
        effect.pipe(Effect.provideService(References.MaxOpsBeforeYield, 16)),
        { signal: h.abort.signal },
      );
      await vi.runAllTimersAsync();
      expect(Exit.isFailure(await opening)).toBe(true);
      expect(h.peripheral.disconnectAsync).toHaveBeenCalledTimes(1);
      expect(h.peripheral.state).toBe("disconnected");
    }
  },
);
