// Open a Mesh Provisioning GATT connection to an unprovisioned peripheral.
//
// Mirrors `connectProxy` byte-for-byte (find peripheral → connect with
// `Scope`-managed disconnect → discover service + characteristics →
// subscribe with `Scope`-managed unsubscribe) but targets the
// **Provisioning** service `0x1827` and its `0x2adb` / `0x2adc`
// characteristics instead of the proxy ones. Splitting the two is simpler
// than parameterising `connectProxy` because the two paths have nothing
// else in common with each other once we're past discovery.

import type { Characteristic, Peripheral } from "@stoprocent/noble";
import { Effect, type Scope, Stream } from "effect";
import { matchAddress } from "./address.ts";
import { BleError } from "./errors.ts";
import { getNoble, type NobleLike, type PeripheralLike, withNobleOperation } from "./noble.ts";
import { MESH_PROVISIONING_SERVICE_UUID, MESH_PROXY_SERVICE_UUID } from "./scan.ts";
import type { ProxyConnection } from "./types.ts";

const MESH_PROVISIONING_DATA_IN_UUID = "2adb"; // provisioner → device (writes)
const MESH_PROVISIONING_DATA_OUT_UUID = "2adc"; // device → provisioner (notifications)

const FIND_PERIPHERAL_TIMEOUT_MS = 25_000;
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
            message: `BLE peripheral '${address}' not found within ${FIND_PERIPHERAL_TIMEOUT_MS / 1000}s. Is the light powered on, factory-reset, and advertising the Provisioning service?`,
          }),
        ),
      );
    }, FIND_PERIPHERAL_TIMEOUT_MS);

    noble.on("discover", onDiscover);
    // Scan for both UUIDs to be tolerant of devices that briefly switch
    // between provisioning + proxy advertisements during reset.
    noble
      .startScanningAsync([MESH_PROVISIONING_SERVICE_UUID, MESH_PROXY_SERVICE_UUID], true)
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

// Telink-aware GATT discovery: the Telink chips in Godox Mesh lights need a
// short settle window after the GATT connect before their server is
// queryable, and they don't respond to the broad
// `discoverAllServicesAndCharacteristicsAsync` traversal. A targeted
// `discoverServicesAsync([UUID])` (which sends `Find By Type Value` rather
// than `Read By Group Type`) followed by per-service
// `discoverCharacteristicsAsync` works reliably.
const discoverProvisioningCharacteristics = (
  peripheral: Peripheral,
): Effect.Effect<{ readonly dataIn: Characteristic; readonly dataOut: Characteristic }, BleError> =>
  Effect.gen(function* () {
    yield* Effect.sleep(`${POST_CONNECT_SETTLE_MS} millis`);
    const services = yield* Effect.tryPromise({
      try: () => peripheral.discoverServicesAsync([MESH_PROVISIONING_SERVICE_UUID]),
      catch: (cause) =>
        new BleError({
          cause,
          message: `discoverServicesAsync(['${MESH_PROVISIONING_SERVICE_UUID}']) failed`,
        }),
    }).pipe(
      Effect.timeoutFail({
        duration: `${DISCOVER_TIMEOUT_MS} millis`,
        onTimeout: () =>
          new BleError({
            message: `Mesh Provisioning service discovery hung past ${DISCOVER_TIMEOUT_MS / 1000}s`,
          }),
      }),
    );
    const service = services.find((s) => s.uuid.toLowerCase() === MESH_PROVISIONING_SERVICE_UUID);
    if (!service) {
      return yield* Effect.fail(
        new BleError({
          message: `Mesh Provisioning service ${MESH_PROVISIONING_SERVICE_UUID} not exposed by the peripheral (saw: [${services.map((s) => s.uuid).join(",") || "(none)"}]).`,
        }),
      );
    }
    const characteristics = yield* Effect.tryPromise({
      try: () =>
        service.discoverCharacteristicsAsync([
          MESH_PROVISIONING_DATA_IN_UUID,
          MESH_PROVISIONING_DATA_OUT_UUID,
        ]),
      catch: (cause) => new BleError({ cause, message: "discoverCharacteristicsAsync failed" }),
    }).pipe(
      Effect.timeoutFail({
        duration: `${DISCOVER_TIMEOUT_MS} millis`,
        onTimeout: () => new BleError({ message: "Characteristic discovery hung" }),
      }),
    );
    const dataIn = characteristics.find(
      (c) => c.uuid.toLowerCase() === MESH_PROVISIONING_DATA_IN_UUID,
    );
    const dataOut = characteristics.find(
      (c) => c.uuid.toLowerCase() === MESH_PROVISIONING_DATA_OUT_UUID,
    );
    if (!dataIn || !dataOut) {
      return yield* Effect.fail(
        new BleError({
          message: `Mesh Provisioning characteristics not found (in=${dataIn ? "ok" : "missing"}, out=${dataOut ? "ok" : "missing"}).`,
        }),
      );
    }
    return { dataIn, dataOut };
  });

/**
 * Connect to a peripheral by address and open the Mesh Provisioning GATT
 * profile. Returns a `ProxyConnection`-shaped handle so it composes with the
 * PB-GATT framing layer the same way the post-provisioning proxy connection
 * composes with the network/proxy framing. Lifetime is bound to the caller's
 * Scope.
 */
export const connectProvisioning = (
  address: string,
): Effect.Effect<ProxyConnection, BleError, Scope.Scope> =>
  withNobleOperation(
    Effect.gen(function* () {
      const noble = yield* getNoble;
      yield* Effect.logDebug(`[prov] waitPoweredOn (state=${noble.state})`);
      yield* waitPoweredOn(noble);
      yield* Effect.logDebug(`[prov] scanning for ${address}`);

      const peripheral = yield* findPeripheral(noble, address);
      yield* Effect.logDebug(`[prov] found peripheral; connecting`);

      yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () => peripheral.connectAsync(),
          catch: (cause) =>
            new BleError({
              cause,
              message: `Failed to connect to peripheral '${address}'`,
            }),
        }),
        () =>
          Effect.promise(() =>
            peripheral.disconnectAsync().catch(() => {
              /* swallow: peripheral may already be gone */
            }),
          ),
      );

      yield* Effect.logDebug(`[prov] connected; discovering`);
      const { dataIn, dataOut } = yield* discoverProvisioningCharacteristics(peripheral);
      yield* Effect.logDebug(`[prov] discovered; subscribing to 2adc`);

      const listeners = new Set<(buf: Uint8Array) => void>();
      const onData = (data: Buffer, _isNotification: boolean): void => {
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
        Effect.tryPromise({
          try: async () => {
            dataOut.on("data", onData);
            await dataOut.subscribeAsync();
          },
          catch: (cause) =>
            new BleError({
              cause,
              message: `Failed to subscribe to notifications on Mesh Provisioning Data Out (${MESH_PROVISIONING_DATA_OUT_UUID})`,
            }),
        }),
        () =>
          Effect.promise(async () => {
            dataOut.removeListener("data", onData);
            await dataOut.unsubscribeAsync().catch(() => {
              /* swallow */
            });
          }),
      );
      yield* Effect.logDebug(`[prov] subscribed; ready`);

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
              message: `Failed to write ${pdu.byteLength} bytes to Mesh Provisioning Data In (${MESH_PROVISIONING_DATA_IN_UUID})`,
            }),
        });

      return {
        address,
        write,
        notifications,
      } satisfies ProxyConnection;
    }),
  );
