// Open a Mesh Proxy GATT connection to a previously discovered peripheral.
//
// Port of upstream `client.ProxyClient`: connect directly when the address
// type is known, otherwise scan → match address → connect →
// discover (0x1828, [0x2add, 0x2ade]) → subscribe(0x2ade). All cleanup is
// attached to the caller-provided Scope so a single `Effect.scoped` at the
// top of the controller wraps the entire lifetime.

import type { Characteristic, Peripheral } from "@stoprocent/noble";
import { Duration, Effect, type Scope, Stream } from "effect";
import { matchAddress } from "./address.ts";
import { BleError } from "./errors.ts";
import { getNoble, type NobleLike, type PeripheralLike, withNobleOperation } from "./noble.ts";
import { MESH_PROVISIONING_SERVICE_UUID, MESH_PROXY_SERVICE_UUID } from "./scan.ts";
import type { ProxyConnection, ProxyWriterConnection } from "./types.ts";

const MESH_PROXY_DATA_IN_UUID = "2add"; // proxy client → server (writes)
const MESH_PROXY_DATA_OUT_UUID = "2ade"; // server → proxy client (notifications)

const FIND_PERIPHERAL_TIMEOUT_MS = 20_000;
const POWERED_ON_TIMEOUT_MS = 5_000;
const DIRECT_CONNECT_TIMEOUT_MS = 4_000;

export interface ProxyConnectOptions {
  /** Override address-type inference for a direct connection attempt. */
  readonly directAddressType?: "public" | "random";
}

// A random BLE address cannot start with bit pattern 10 (reserved by the
// Bluetooth spec), so a Linux MAC in this range is unambiguously public.
// All other addresses keep the scan path unless their type is supplied.
export const inferredDirectAddressType = (
  address: string,
  platform: NodeJS.Platform = process.platform,
): "public" | undefined => {
  if (platform !== "linux") return undefined;
  const firstOctet = /^([0-9a-f]{2})(?::[0-9a-f]{2}){5}$/i.exec(address)?.[1];
  if (!firstOctet) return undefined;
  return (Number.parseInt(firstOctet, 16) & 0xc0) === 0x80 ? "public" : undefined;
};

const waitPoweredOn = (noble: NobleLike): Effect.Effect<void, BleError> =>
  Effect.async<void, BleError>((resume) => {
    if (noble.state === "poweredOn") {
      resume(Effect.void);
      return;
    }
    let settled = false;
    const onChange = (state: string): void => {
      if (settled) return;
      if (state === "poweredOn") {
        settled = true;
        clearTimeout(timer);
        noble.removeListener("stateChange", onChange);
        resume(Effect.void);
      }
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      noble.removeListener("stateChange", onChange);
      resume(
        Effect.fail(
          new BleError({
            message: `BLE adapter never reached 'poweredOn' (last state: '${noble.state}')`,
          }),
        ),
      );
    }, POWERED_ON_TIMEOUT_MS);
    noble.on("stateChange", onChange);
  });

const findPeripheral = (noble: NobleLike, address: string): Effect.Effect<Peripheral, BleError> =>
  Effect.async<Peripheral, BleError>((resume) => {
    let settled = false;

    const finish = (next: Effect.Effect<Peripheral, BleError>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      noble.removeListener("discover", onDiscover);
      noble.stopScanningAsync().catch(() => undefined);
      resume(next);
    };

    const onDiscover = (peripheral: PeripheralLike): void => {
      if (matchAddress(peripheral, address)) {
        finish(Effect.succeed(peripheral as unknown as Peripheral));
      }
    };

    const timer = setTimeout(() => {
      finish(
        Effect.fail(
          new BleError({
            message: `BLE peripheral '${address}' not found within ${FIND_PERIPHERAL_TIMEOUT_MS / 1000}s. Is the light powered on and in range?`,
          }),
        ),
      );
    }, FIND_PERIPHERAL_TIMEOUT_MS);

    noble.on("discover", onDiscover);
    noble
      .startScanningAsync([MESH_PROXY_SERVICE_UUID, MESH_PROVISIONING_SERVICE_UUID], true)
      .catch((cause: unknown) => {
        finish(
          Effect.fail(
            new BleError({
              cause,
              message: `Failed to start scan while looking for '${address}'`,
            }),
          ),
        );
      });
  });

const POST_CONNECT_SETTLE_MS = 3_000;
const DISCOVER_TIMEOUT_MS = 15_000;

// Telink-aware: keep the settle window on scanned connections. Direct
// connections worked with immediate discovery on both Godox lights. Targeted
// `discoverServicesAsync([UUID])` uses Find By Type Value; broad discoverAll
// hangs on these chips.
const discoverProxyCharacteristics = (
  peripheral: Peripheral,
  settleMs: number,
): Effect.Effect<{ readonly dataIn: Characteristic; readonly dataOut: Characteristic }, BleError> =>
  Effect.gen(function* () {
    if (settleMs > 0) yield* Effect.sleep(`${settleMs} millis`);
    const services = yield* Effect.tryPromise({
      try: () => peripheral.discoverServicesAsync([MESH_PROXY_SERVICE_UUID]),
      catch: (cause) =>
        new BleError({
          cause,
          message: `discoverServicesAsync(['${MESH_PROXY_SERVICE_UUID}']) failed`,
        }),
    }).pipe(
      Effect.timeoutFail({
        duration: Duration.millis(DISCOVER_TIMEOUT_MS),
        onTimeout: () =>
          new BleError({
            message: `Mesh Proxy service discovery hung past ${DISCOVER_TIMEOUT_MS / 1000}s`,
          }),
      }),
    );
    const service = services.find((s) => s.uuid.toLowerCase() === MESH_PROXY_SERVICE_UUID);
    if (!service) {
      return yield* Effect.fail(
        new BleError({
          message: `Mesh Proxy service ${MESH_PROXY_SERVICE_UUID} not exposed by the peripheral (saw: [${services.map((s) => s.uuid).join(",") || "(none)"}]).`,
        }),
      );
    }
    const characteristics = yield* Effect.tryPromise({
      try: () =>
        service.discoverCharacteristicsAsync([MESH_PROXY_DATA_IN_UUID, MESH_PROXY_DATA_OUT_UUID]),
      catch: (cause) => new BleError({ cause, message: "discoverCharacteristicsAsync failed" }),
    }).pipe(
      Effect.timeoutFail({
        duration: Duration.millis(DISCOVER_TIMEOUT_MS),
        onTimeout: () => new BleError({ message: "Characteristic discovery hung" }),
      }),
    );
    const dataIn = characteristics.find((c) => c.uuid.toLowerCase() === MESH_PROXY_DATA_IN_UUID);
    const dataOut = characteristics.find((c) => c.uuid.toLowerCase() === MESH_PROXY_DATA_OUT_UUID);
    if (!dataIn || !dataOut) {
      return yield* Effect.fail(
        new BleError({
          message: `Mesh Proxy characteristics not found (in=${dataIn ? "ok" : "missing"}, out=${dataOut ? "ok" : "missing"}).`,
        }),
      );
    }
    return { dataIn, dataOut };
  });

const discoverProxyDataIn = (
  peripheral: Peripheral,
  settleMs: number,
): Effect.Effect<Characteristic, BleError> =>
  Effect.gen(function* () {
    if (settleMs > 0) yield* Effect.sleep(`${settleMs} millis`);
    const services = yield* Effect.tryPromise({
      try: () => peripheral.discoverServicesAsync([MESH_PROXY_SERVICE_UUID]),
      catch: (cause) =>
        new BleError({
          cause,
          message: `discoverServicesAsync(['${MESH_PROXY_SERVICE_UUID}']) failed`,
        }),
    }).pipe(
      Effect.timeoutFail({
        duration: Duration.millis(DISCOVER_TIMEOUT_MS),
        onTimeout: () =>
          new BleError({
            message: `Mesh Proxy service discovery hung past ${DISCOVER_TIMEOUT_MS / 1000}s`,
          }),
      }),
    );
    const service = services.find((s) => s.uuid.toLowerCase() === MESH_PROXY_SERVICE_UUID);
    if (!service) {
      return yield* Effect.fail(
        new BleError({
          message: `Mesh Proxy service ${MESH_PROXY_SERVICE_UUID} not exposed by the peripheral (saw: [${services.map((s) => s.uuid).join(",") || "(none)"}]).`,
        }),
      );
    }
    const characteristics = yield* Effect.tryPromise({
      try: () => service.discoverCharacteristicsAsync([MESH_PROXY_DATA_IN_UUID]),
      catch: (cause) => new BleError({ cause, message: "discoverCharacteristicsAsync failed" }),
    }).pipe(
      Effect.timeoutFail({
        duration: Duration.millis(DISCOVER_TIMEOUT_MS),
        onTimeout: () => new BleError({ message: "Characteristic discovery hung" }),
      }),
    );
    const dataIn = characteristics.find((c) => c.uuid.toLowerCase() === MESH_PROXY_DATA_IN_UUID);
    if (!dataIn) {
      return yield* Effect.fail(
        new BleError({
          message: "Mesh Proxy Data In characteristic not found.",
        }),
      );
    }
    return dataIn;
  });

/**
 * Connect to a peripheral by address and open the Mesh Proxy GATT profile.
 * The returned `ProxyConnection` is owned by the surrounding Scope: when the
 * Scope closes, notifications are stopped and the peripheral is disconnected.
 */
const STEP_TIMEOUT_MS = 15_000;
const DISCONNECT_TIMEOUT_MS = 3_000;

const withBleTimeout = <A>(
  effect: Effect.Effect<A, BleError>,
  label: string,
): Effect.Effect<A, BleError> =>
  effect.pipe(
    Effect.timeoutFail({
      duration: Duration.millis(STEP_TIMEOUT_MS),
      onTimeout: () => new BleError({ message: `${label} timed out after ${STEP_TIMEOUT_MS}ms` }),
    }),
  );

const disconnectPeripheral = (peripheral: Peripheral): Effect.Effect<void, BleError> =>
  Effect.tryPromise({
    try: async () => {
      if (peripheral.state === "connecting") {
        peripheral.cancelConnect();
        return;
      }
      if (peripheral.state === "disconnected" || peripheral.state === "error") return;

      let timer: NodeJS.Timeout | undefined;
      try {
        const disconnected = await Promise.race([
          peripheral.disconnectAsync().then(() => true),
          new Promise<boolean>((resolve) => {
            timer = setTimeout(() => resolve(false), DISCONNECT_TIMEOUT_MS);
          }),
        ]);
        if (!disconnected) throw new Error(`disconnect timed out after ${DISCONNECT_TIMEOUT_MS}ms`);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
    catch: (cause) =>
      new BleError({ cause, message: `Failed to close BLE connection: ${String(cause)}` }),
  }).pipe(Effect.tapError((error) => Effect.logWarning(`[ble] ${error.message}`)));

const connectPeripheral = (
  peripheral: Peripheral,
  address: string,
): Effect.Effect<void, BleError> =>
  withBleTimeout(
    Effect.tryPromise({
      try: () => peripheral.connectAsync(),
      catch: (cause) =>
        new BleError({
          cause,
          message: `Failed to connect to peripheral '${address}'`,
        }),
    }),
    "connectAsync",
  ).pipe(
    Effect.tapError((error) =>
      Effect.logDebug(
        `[ble] connect failed for ${address}; cleaning up peripheral: ${error.message}`,
      ).pipe(Effect.zipRight(disconnectPeripheral(peripheral))),
    ),
  );

const openProxyPeripheral = (
  noble: NobleLike,
  address: string,
  options: ProxyConnectOptions,
): Effect.Effect<{ readonly peripheral: Peripheral; readonly direct: boolean }, BleError> =>
  Effect.gen(function* () {
    yield* Effect.logDebug(`[ble] waitPoweredOn`);
    yield* waitPoweredOn(noble);

    const addressType = options.directAddressType ?? inferredDirectAddressType(address);
    const directConnect = noble.connectAsync?.bind(noble);
    if (addressType && directConnect) {
      yield* Effect.logDebug(`[ble] connecting directly to ${address} (${addressType})`);
      let abandoned = false;
      const cancelDirect = (): void => {
        abandoned = true;
        try {
          noble.cancelConnect?.(address);
        } catch {
          // Continue with discovery even if Noble has already cleared the attempt.
        }
      };
      const pending = Promise.resolve().then(() => directConnect(address, { addressType }));
      void pending.then(
        (peripheral) => {
          if (abandoned && peripheral) {
            void Effect.runPromise(disconnectPeripheral(peripheral as Peripheral)).catch(
              () => undefined,
            );
          }
        },
        () => undefined,
      );
      const direct = yield* Effect.tryPromise({
        try: async () => {
          const peripheral = await pending;
          if (!peripheral) throw new Error("Noble returned no peripheral");
          return peripheral as Peripheral;
        },
        catch: (cause) =>
          new BleError({ cause, message: `Direct BLE connection to ${address} failed` }),
      }).pipe(
        Effect.timeoutFail({
          duration: Duration.millis(DIRECT_CONNECT_TIMEOUT_MS),
          onTimeout: () => {
            abandoned = true;
            return new BleError({
              message: `Direct BLE connection to ${address} timed out after ${DIRECT_CONNECT_TIMEOUT_MS}ms`,
            });
          },
        }),
        Effect.tapError((error) =>
          Effect.logDebug(`[ble] ${error.message}; falling back to scan`).pipe(
            Effect.zipRight(Effect.sync(cancelDirect)),
          ),
        ),
        Effect.onInterrupt(() => Effect.sync(cancelDirect)),
        Effect.orElseSucceed(() => undefined),
      );
      if (direct) return { peripheral: direct, direct: true };
    }

    yield* Effect.logDebug(`[ble] scanning for ${address}`);
    const peripheral = yield* findPeripheral(noble, address);
    yield* Effect.logDebug(`[ble] found peripheral; connecting ${address}`);
    yield* connectPeripheral(peripheral, address);
    return { peripheral, direct: false };
  });

export const connectProxy = (
  address: string,
  options: ProxyConnectOptions = {},
): Effect.Effect<ProxyConnection, BleError, Scope.Scope> =>
  withNobleOperation(
    Effect.gen(function* () {
      const noble = yield* getNoble;

      // Connect with disconnect-on-Scope-close. We acquire the connection
      // here so any subsequent failure (discovery, subscribe) still
      // disconnects on cleanup.
      const opened = yield* Effect.acquireRelease(
        openProxyPeripheral(noble, address, options),
        ({ peripheral }) =>
          disconnectPeripheral(peripheral).pipe(Effect.catchAll(() => Effect.void)),
      );
      const { peripheral } = opened;
      yield* Effect.logDebug(`[ble] connected; discovering`);

      const { dataIn, dataOut } = yield* withBleTimeout(
        discoverProxyCharacteristics(peripheral, opened.direct ? 0 : POST_CONNECT_SETTLE_MS),
        "discoverServicesAndCharacteristics",
      );
      yield* Effect.logDebug(`[ble] discovered; subscribing to 2ade`);

      // Build the notifications stream first — we want every subscriber to
      // share a single GATT subscription, so the Stream is async-iterator
      // backed via `notificationsAsync`. We start the subscription eagerly
      // inside the Scope so cleanup is symmetric (subscribe on acquire,
      // unsubscribe on release).
      const listeners = new Set<(buf: Uint8Array) => void>();
      const onData = (data: Buffer, _isNotification: boolean): void => {
        // Copy the buffer: noble re-uses its read buffer across notifications.
        const copy = new Uint8Array(data.byteLength);
        copy.set(data);
        for (const listener of listeners) {
          try {
            listener(copy);
          } catch {
            /* listener errors are out of scope here */
          }
        }
      };

      yield* Effect.acquireRelease(
        withBleTimeout(
          Effect.tryPromise({
            try: async () => {
              dataOut.on("data", onData);
              await dataOut.subscribeAsync();
            },
            catch: (cause) =>
              new BleError({
                cause,
                message: `Failed to subscribe to notifications on Mesh Proxy Data Out (${MESH_PROXY_DATA_OUT_UUID})`,
              }),
          }),
          "subscribeAsync(2ade)",
        ),
        () =>
          Effect.promise(async () => {
            dataOut.removeListener("data", onData);
            await dataOut.unsubscribeAsync().catch(() => {
              /* swallow */
            });
          }),
      );
      yield* Effect.logDebug(`[ble] subscribed; ready`);

      const notifications: Stream.Stream<Uint8Array, BleError> = Stream.async<Uint8Array, BleError>(
        (emit) => {
          const handler = (buf: Uint8Array): void => {
            void emit.single(buf);
          };
          listeners.add(handler);
          return Effect.sync(() => {
            listeners.delete(handler);
          });
        },
      );

      // Match the upstream Python (`response=False`) — Mesh Proxy Data In is
      // a Write-Without-Response characteristic on every Godox light we've
      // seen, and noble will reject writeAsync(..., false) if the
      // characteristic doesn't declare WRITE_WITHOUT_RESPONSE. If the
      // peripheral only declares WRITE we transparently fall back to the
      // with-response path.
      const supportsWithoutResponse = dataIn.properties.includes("writeWithoutResponse");

      const write = (pdu: Uint8Array): Effect.Effect<void, BleError> =>
        Effect.tryPromise({
          try: () =>
            dataIn.writeAsync(
              Buffer.from(pdu.buffer, pdu.byteOffset, pdu.byteLength),
              supportsWithoutResponse,
            ),
          catch: (cause) =>
            new BleError({
              cause,
              message: `Failed to write ${pdu.byteLength} bytes to Mesh Proxy Data In (${MESH_PROXY_DATA_IN_UUID})`,
            }),
        });

      return {
        address,
        write,
        notifications,
      } satisfies ProxyConnection;
    }),
  );

/** Open a write-only Mesh Proxy connection. This is the fast path for normal
 * control commands: it discovers only Data In (2add), skips subscription to
 * Data Out (2ade), and returns an explicit `close` handle so callers can keep
 * the GATT connection warm between writes.
 */
export const connectProxyWriter = (
  address: string,
  options: ProxyConnectOptions = {},
): Effect.Effect<ProxyWriterConnection, BleError> =>
  withNobleOperation(
    Effect.gen(function* () {
      const noble = yield* getNoble;
      const opened = yield* openProxyPeripheral(noble, address, options);
      const { peripheral } = opened;

      let closed = false;
      const close = (): Effect.Effect<void, BleError> =>
        Effect.gen(function* () {
          if (closed) return;
          yield* disconnectPeripheral(peripheral);
          closed = true;
        });

      yield* Effect.logDebug(`[ble] connected; discovering Data In`);
      const dataIn = yield* withBleTimeout(
        discoverProxyDataIn(peripheral, opened.direct ? 0 : POST_CONNECT_SETTLE_MS),
        "discoverDataIn",
      ).pipe(Effect.tapError(() => close()));
      yield* Effect.logDebug(`[ble] Data In ready`);

      const supportsWithoutResponse = dataIn.properties.includes("writeWithoutResponse");

      const write = (pdu: Uint8Array): Effect.Effect<void, BleError> =>
        Effect.tryPromise({
          try: () =>
            dataIn.writeAsync(
              Buffer.from(pdu.buffer, pdu.byteOffset, pdu.byteLength),
              supportsWithoutResponse,
            ),
          catch: (cause) =>
            new BleError({
              cause,
              message: `Failed to write ${pdu.byteLength} bytes to Mesh Proxy Data In (${MESH_PROXY_DATA_IN_UUID})`,
            }),
        });

      return {
        address,
        write,
        close,
      } satisfies ProxyWriterConnection;
    }),
  );
