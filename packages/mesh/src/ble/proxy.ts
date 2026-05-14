// Open a Mesh Proxy GATT connection to a previously discovered peripheral.
//
// Port of upstream `client.ProxyClient`: scan → match address → connect →
// discover (0x1828, [0x2add, 0x2ade]) → subscribe(0x2ade). All cleanup is
// attached to the caller-provided Scope so a single `Effect.scoped` at the
// top of the controller wraps the entire lifetime.

import type { Characteristic, Peripheral } from "@stoprocent/noble";
import { Effect, type Scope, Stream } from "effect";
import { matchAddress } from "./address.ts";
import { BleError } from "./errors.ts";
import { getNoble, type NobleLike, type PeripheralLike, withNobleOperation } from "./noble.ts";
import { MESH_PROVISIONING_SERVICE_UUID, MESH_PROXY_SERVICE_UUID } from "./scan.ts";
import type { ProxyConnection, ProxyWriterConnection } from "./types.ts";

const MESH_PROXY_DATA_IN_UUID = "2add"; // proxy client → server (writes)
const MESH_PROXY_DATA_OUT_UUID = "2ade"; // server → proxy client (notifications)

const FIND_PERIPHERAL_TIMEOUT_MS = 20_000;
const POWERED_ON_TIMEOUT_MS = 5_000;

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

// Telink-aware: same quirk as `ble/provisioning.ts` — short settle window
// after connect, then a targeted `discoverServicesAsync([UUID])` (Find By
// Type Value, not Read By Group Type) followed by per-service
// `discoverCharacteristicsAsync`. The broad discoverAll path hangs forever
// on these chips.
const discoverProxyCharacteristics = (
  peripheral: Peripheral,
): Effect.Effect<{ readonly dataIn: Characteristic; readonly dataOut: Characteristic }, BleError> =>
  Effect.gen(function* () {
    yield* Effect.sleep(`${POST_CONNECT_SETTLE_MS} millis`);
    const services = yield* Effect.tryPromise({
      try: () => peripheral.discoverServicesAsync([MESH_PROXY_SERVICE_UUID]),
      catch: (cause) =>
        new BleError({
          cause,
          message: `discoverServicesAsync(['${MESH_PROXY_SERVICE_UUID}']) failed`,
        }),
    }).pipe(
      Effect.timeoutFail({
        duration: `${DISCOVER_TIMEOUT_MS} millis`,
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
        duration: `${DISCOVER_TIMEOUT_MS} millis`,
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

const discoverProxyDataIn = (peripheral: Peripheral): Effect.Effect<Characteristic, BleError> =>
  Effect.gen(function* () {
    yield* Effect.sleep(`${POST_CONNECT_SETTLE_MS} millis`);
    const services = yield* Effect.tryPromise({
      try: () => peripheral.discoverServicesAsync([MESH_PROXY_SERVICE_UUID]),
      catch: (cause) =>
        new BleError({
          cause,
          message: `discoverServicesAsync(['${MESH_PROXY_SERVICE_UUID}']) failed`,
        }),
    }).pipe(
      Effect.timeoutFail({
        duration: `${DISCOVER_TIMEOUT_MS} millis`,
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
        duration: `${DISCOVER_TIMEOUT_MS} millis`,
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

const withBleTimeout = <A>(
  effect: Effect.Effect<A, BleError>,
  label: string,
): Effect.Effect<A, BleError> =>
  effect.pipe(
    Effect.timeoutFail({
      duration: `${STEP_TIMEOUT_MS} millis`,
      onTimeout: () => new BleError({ message: `${label} timed out after ${STEP_TIMEOUT_MS}ms` }),
    }),
  );

export const connectProxy = (
  address: string,
): Effect.Effect<ProxyConnection, BleError, Scope.Scope> =>
  withNobleOperation(
    Effect.gen(function* () {
      const noble = yield* getNoble;
      yield* Effect.logDebug(`[ble] waitPoweredOn`);
      yield* waitPoweredOn(noble);
      yield* Effect.logDebug(`[ble] scanning for ${address}`);

      const peripheral = yield* findPeripheral(noble, address);
      yield* Effect.logDebug(`[ble] found peripheral; connecting`);

      // Connect with disconnect-on-Scope-close. We acquire the connection
      // here so any subsequent failure (discovery, subscribe) still
      // disconnects on cleanup.
      yield* Effect.acquireRelease(
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
        ),
        () =>
          Effect.promise(() =>
            peripheral.disconnectAsync().catch(() => {
              /* swallow: the peripheral may already be gone */
            }),
          ),
      );
      yield* Effect.logDebug(`[ble] connected; discovering`);

      const { dataIn, dataOut } = yield* withBleTimeout(
        discoverProxyCharacteristics(peripheral),
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
): Effect.Effect<ProxyWriterConnection, BleError> =>
  withNobleOperation(
    Effect.gen(function* () {
      const noble = yield* getNoble;
      yield* Effect.logDebug(`[ble] waitPoweredOn`);
      yield* waitPoweredOn(noble);
      yield* Effect.logDebug(`[ble] scanning for ${address}`);

      const peripheral = yield* findPeripheral(noble, address);
      yield* Effect.logDebug(`[ble] found peripheral; connecting`);

      yield* withBleTimeout(
        Effect.tryPromise({
          try: () => peripheral.connectAsync(),
          catch: (cause) =>
            new BleError({
              cause,
              message: `Failed to connect to peripheral '${address}'`,
            }),
        }),
        "connectAsync",
      );

      let closed = false;
      const close = (): Effect.Effect<void> =>
        Effect.promise(async () => {
          if (closed) return;
          closed = true;
          await peripheral.disconnectAsync().catch(() => undefined);
        });

      yield* Effect.logDebug(`[ble] connected; discovering Data In`);
      const dataIn = yield* withBleTimeout(discoverProxyDataIn(peripheral), "discoverDataIn").pipe(
        Effect.tapError(() => close()),
      );
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
