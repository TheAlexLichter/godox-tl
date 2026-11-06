// Open a Mesh Proxy GATT connection to a previously discovered peripheral.
//
// Port of upstream `client.ProxyClient`: connect directly when the address
// type is known, otherwise scan → match address → connect →
// discover (0x1828, [0x2add, 0x2ade]) → subscribe(0x2ade). All cleanup is
// attached to the caller-provided Scope so a single `Effect.scoped` at the
// top of the controller wraps the entire lifetime.

import type { Characteristic, Peripheral } from "@stoprocent/noble";
import { Queue, Duration, Effect, Exit, type Scope, Stream } from "effect";
import { matchAddress, normalizeAddress } from "./address.ts";
import { BleError } from "./errors.ts";
import { getNoble, type NobleLike, type PeripheralLike, withNobleOperation } from "./noble.ts";
import { MESH_PROVISIONING_SERVICE_UUID, MESH_PROXY_SERVICE_UUID } from "./scan.ts";
import { withScanCleanup } from "./scanSession.ts";
import type { ProxyConnection, ProxyWriterConnection } from "./types.ts";

const MESH_PROXY_DATA_IN_UUID = "2add"; // proxy client → server (writes)
const MESH_PROXY_DATA_OUT_UUID = "2ade"; // server → proxy client (notifications)
const DEFAULT_FIND_PERIPHERAL_TIMEOUT_MS = 20_000;
const POWERED_ON_TIMEOUT_MS = 5_000;
const DIRECT_CONNECT_TIMEOUT_MS = 4_000;
export interface ProxyConnectOptions {
  /** Override address-type inference for a direct connection attempt. */
  readonly directAddressType?: "public" | "random";
  readonly findPeripheralTimeoutMs?: number;
  readonly fallbackAddresses?: ReadonlyArray<string>;
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
  Effect.callback<void, BleError>((resume) => {
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

    return Effect.sync(() => {
      settled = true;
      clearTimeout(timer);
      noble.removeListener("stateChange", onChange);
    });
  });

const formatTimeout = (timeoutMs: number): string =>
  timeoutMs % 1_000 === 0 ? `${timeoutMs / 1_000}s` : `${timeoutMs}ms`;
const candidateAddresses = (
  address: string,
  fallbacks: ReadonlyArray<string> = [],
): ReadonlyArray<string> => {
  const seen = new Set<string>();
  const addresses: string[] = [];
  for (const candidate of [address, ...fallbacks]) {
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    addresses.push(candidate);
  }
  return addresses;
};

const findPeripheral = (
  noble: NobleLike,
  addresses: ReadonlyArray<string>,
  timeoutMs: number,
): Effect.Effect<Peripheral, BleError> =>
  withScanCleanup(noble, (start) =>
    Effect.callback<Peripheral, BleError>((resume) => {
      let settled = false;

      const cleanup = (): void => {
        clearTimeout(timer);
        noble.removeListener("discover", onDiscover);
      };

      const finish = (next: Effect.Effect<Peripheral, BleError>): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resume(next);
      };

      const onDiscover = (peripheral: PeripheralLike): void => {
        if (addresses.some((address) => matchAddress(peripheral, address))) {
          finish(Effect.succeed(peripheral as unknown as Peripheral));
        }
      };

      const targetSummary =
        addresses.length === 1 ? `'${addresses[0]}'` : `[${addresses.join(", ")}]`;
      const timer = setTimeout(() => {
        finish(
          Effect.fail(
            new BleError({
              message: `BLE peripheral ${targetSummary} not found within ${formatTimeout(timeoutMs)}. Is a same-mesh light powered on and in range?`,
            }),
          ),
        );
      }, timeoutMs);

      noble.on("discover", onDiscover);
      const startScanning = start(() =>
        noble.startScanningAsync([MESH_PROXY_SERVICE_UUID, MESH_PROVISIONING_SERVICE_UUID], true),
      );
      startScanning.catch((cause: unknown) => {
        finish(
          Effect.fail(
            new BleError({
              cause,
              message: `Failed to start scan while looking for ${targetSummary}`,
            }),
          ),
        );
      });

      return Effect.sync(() => {
        settled = true;
        cleanup();
      });
    }),
  );
const POST_CONNECT_SETTLE_MS = 3_000;
const DISCOVER_TIMEOUT_MS = 15_000;
// Telink-aware: keep the settle window on scanned connections. Direct
// connections worked with immediate discovery on both Godox lights. Targeted
// `discoverServicesAsync([UUID])` uses Find By Type Value; broad discoverAll
// hangs on these chips.
const discoverProxyCharacteristics = (
  peripheral: Peripheral,
  settleMs: number,
): Effect.Effect<
  {
    readonly dataIn: Characteristic;
    readonly dataOut: Characteristic;
  },
  BleError
> =>
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
      Effect.timeoutOrElse({
        duration: Duration.millis(DISCOVER_TIMEOUT_MS),
        orElse: () =>
          Effect.fail(
            new BleError({
              message: `Mesh Proxy service discovery hung past ${DISCOVER_TIMEOUT_MS / 1_000}s`,
            }),
          ),
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
      Effect.timeoutOrElse({
        duration: Duration.millis(DISCOVER_TIMEOUT_MS),
        orElse: () => Effect.fail(new BleError({ message: "Characteristic discovery hung" })),
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
      Effect.timeoutOrElse({
        duration: Duration.millis(DISCOVER_TIMEOUT_MS),
        orElse: () =>
          Effect.fail(
            new BleError({
              message: `Mesh Proxy service discovery hung past ${DISCOVER_TIMEOUT_MS / 1_000}s`,
            }),
          ),
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
      Effect.timeoutOrElse({
        duration: Duration.millis(DISCOVER_TIMEOUT_MS),
        orElse: () => Effect.fail(new BleError({ message: "Characteristic discovery hung" })),
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
const pendingDisconnects = new WeakMap<Peripheral, Promise<void>>();
const peripheralOwners = new WeakMap<
  Peripheral,
  {
    readonly noble: NobleLike;
    readonly addresses: Set<string>;
  }
>();
const pendingAddressCleanups = new WeakMap<NobleLike, Map<string, Set<Promise<void>>>>();
const connectionGenerations = new WeakMap<NobleLike, Map<string, object>>();
const peripheralGenerations = new WeakMap<Peripheral, object>();

const rememberPeripheral = (noble: NobleLike, peripheral: Peripheral, address?: string): void => {
  const owner = peripheralOwners.get(peripheral) ?? { noble, addresses: new Set<string>() };
  for (const identifier of [peripheral.address, peripheral.id, peripheral.uuid, address]) {
    const normalized = normalizeAddress(identifier);
    if (normalized) owner.addresses.add(normalized);
  }
  peripheralOwners.set(peripheral, owner);
};

const claimConnection = (
  noble: NobleLike,
  identifiers: ReadonlyArray<string>,
  generation: object,
  peripheral?: Peripheral,
): void => {
  let generations = connectionGenerations.get(noble);
  if (!generations) {
    generations = new Map();
    connectionGenerations.set(noble, generations);
  }
  for (const identifier of identifiers) {
    const address = normalizeAddress(identifier);
    if (address) generations.set(address, generation);
  }
  if (peripheral) peripheralGenerations.set(peripheral, generation);
};

const ownsConnection = (peripheral: Peripheral, generation: object): boolean => {
  const owner = peripheralOwners.get(peripheral);
  return (
    peripheralGenerations.get(peripheral) === generation &&
    (!owner ||
      [...owner.addresses].every(
        (address) => connectionGenerations.get(owner.noble)?.get(address) === generation,
      ))
  );
};

const trackAddressCleanup = (
  noble: NobleLike,
  identifiers: ReadonlyArray<string>,
  pending: Promise<void>,
): void => {
  let addresses = pendingAddressCleanups.get(noble);
  if (!addresses) {
    addresses = new Map();
    pendingAddressCleanups.set(noble, addresses);
  }
  for (const address of identifiers) {
    let operations = addresses.get(address);
    if (!operations) {
      operations = new Set();
      addresses.set(address, operations);
    }
    operations.add(pending);
    const current = operations;
    const clear = (): void => {
      current.delete(pending);
      if (current.size === 0 && addresses.get(address) === current) addresses.delete(address);
    };
    void pending.then(clear, clear);
  }
};

const pendingAddressCleanup = (
  noble: NobleLike,
  identifiers: ReadonlyArray<string | undefined>,
): Promise<unknown> | undefined => {
  const operations = new Set<Promise<void>>();
  for (const identifier of identifiers) {
    for (const pending of pendingAddressCleanups.get(noble)?.get(normalizeAddress(identifier)) ??
      [])
      operations.add(pending);
  }
  return operations.size ? Promise.all(operations) : undefined;
};

const beginConnection = (
  noble: NobleLike,
  identifiers: ReadonlyArray<string>,
  generation: object,
  peripheral?: Peripheral,
): Effect.Effect<void, BleError> =>
  Effect.suspend(() => {
    // Recheck and claim together: an old handle may start closing after the
    // asynchronous cleanup wait. Once claimed, its generation cannot close us.
    if (
      identifiers.some(
        (address) => pendingAddressCleanups.get(noble)?.get(normalizeAddress(address))?.size,
      ) ||
      (peripheral && pendingDisconnects.has(peripheral))
    )
      return Effect.fail(
        new BleError({
          message: "Previous BLE cleanup is still pending; replacement connection blocked",
        }),
      );
    claimConnection(noble, identifiers, generation, peripheral);
    return Effect.void;
  });

const awaitDisconnect = async (pending: Promise<unknown>): Promise<void> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    const disconnected = await Promise.race([
      pending.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), DISCONNECT_TIMEOUT_MS);
      }),
    ]);
    if (!disconnected) throw new Error(`disconnect timed out after ${DISCONNECT_TIMEOUT_MS}ms`);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const awaitPendingDisconnect = (
  getPending: () => Promise<unknown> | undefined,
): Effect.Effect<void, BleError> =>
  Effect.tryPromise({
    try: async () => {
      const pending = getPending();
      if (pending) await awaitDisconnect(pending);
    },
    catch: (cause) =>
      new BleError({
        cause,
        message: `Previous BLE cleanup has not completed; replacement connection blocked: ${String(cause)}`,
      }),
  });

const withBleTimeout = <A>(
  effect: Effect.Effect<A, BleError>,
  label: string,
): Effect.Effect<A, BleError> =>
  effect.pipe(
    Effect.timeoutOrElse({
      duration: Duration.millis(STEP_TIMEOUT_MS),
      orElse: () =>
        Effect.fail(new BleError({ message: `${label} timed out after ${STEP_TIMEOUT_MS}ms` })),
    }),
  );

const disconnectPeripheral = (
  peripheral: Peripheral,
  generation?: object,
): Effect.Effect<void, BleError> =>
  Effect.tryPromise({
    try: async () => {
      if (generation && !ownsConnection(peripheral, generation)) return;
      let pending = pendingDisconnects.get(peripheral);
      if (!pending) {
        if (peripheral.state === "connecting") {
          peripheral.cancelConnect();
          return;
        }
        if (peripheral.state === "disconnected" || peripheral.state === "error") return;

        // A bounded wait must not abandon the native disconnect. Later close
        // attempts join it rather than starting another disconnect that could
        // finish after the same peripheral has been reconnected.
        pending = Promise.resolve().then(() => peripheral.disconnectAsync());
        pendingDisconnects.set(peripheral, pending);
        const owner = peripheralOwners.get(peripheral);
        if (owner) trackAddressCleanup(owner.noble, [...owner.addresses], pending);
        const current = pending;
        const clear = (): void => {
          if (pendingDisconnects.get(peripheral) === current) pendingDisconnects.delete(peripheral);
        };
        void pending.then(clear, clear);
      }

      await awaitDisconnect(pending);
    },
    catch: (cause) =>
      new BleError({ cause, message: `Failed to close BLE connection: ${String(cause)}` }),
  }).pipe(Effect.tapError((error) => Effect.logWarning(`[ble] ${error.message}`)));

const cleanupConnectedPeripheral = async (peripheral: Peripheral): Promise<void> => {
  await Effect.runPromise(disconnectPeripheral(peripheral)).catch(() => undefined);
  await pendingDisconnects.get(peripheral)?.catch(() => undefined);
};

const connectPeripheral = (
  noble: NobleLike,
  peripheral: Peripheral,
  address: string,
  generation: object,
): Effect.Effect<void, BleError> =>
  Effect.suspend(() => {
    let pending: Promise<void> | undefined;
    let abandonedCleanup: Promise<void> | undefined;
    let cancelledConnecting = false;
    const cancel = (): void => {
      if (!pending || abandonedCleanup) return;
      abandonedCleanup = pending
        .catch(() => undefined)
        .then(() =>
          cancelledConnecting && peripheral.state === "connecting"
            ? undefined
            : cleanupConnectedPeripheral(peripheral),
        );
      trackAddressCleanup(
        noble,
        [...(peripheralOwners.get(peripheral)?.addresses ?? [])],
        abandonedCleanup,
      );
      if (peripheral.state === "connecting") {
        try {
          peripheral.cancelConnect();
          cancelledConnecting = true;
        } catch {
          // The pending native task remains fenced even if cancellation fails.
        }
      }
    };
    return awaitPendingDisconnect(
      () =>
        pendingAddressCleanup(noble, [peripheral.address, peripheral.id, peripheral.uuid]) ??
        pendingDisconnects.get(peripheral),
    ).pipe(
      Effect.andThen(
        beginConnection(
          noble,
          [...(peripheralOwners.get(peripheral)?.addresses ?? [])],
          generation,
          peripheral,
        ),
      ),
      Effect.andThen(
        withBleTimeout(
          Effect.tryPromise({
            try: () => {
              pending = Promise.resolve().then(() => peripheral.connectAsync());
              return pending;
            },
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
            ).pipe(
              Effect.andThen(Effect.sync(cancel)),
              Effect.andThen(
                awaitPendingDisconnect(() => abandonedCleanup).pipe(
                  Effect.catch(() => Effect.void),
                ),
              ),
            ),
          ),
          Effect.onInterrupt(() => Effect.sync(cancel)),
        ),
      ),
    );
  });

const openProxyPeripheral = (
  noble: NobleLike,
  address: string,
  options: ProxyConnectOptions,
): Effect.Effect<
  {
    readonly peripheral: Peripheral;
    readonly direct: boolean;
    readonly generation: object;
  },
  BleError
> =>
  Effect.gen(function* () {
    const addresses = candidateAddresses(address, options.fallbackAddresses);
    const findPeripheralTimeoutMs = Math.max(
      1,
      options.findPeripheralTimeoutMs ?? DEFAULT_FIND_PERIPHERAL_TIMEOUT_MS,
    );
    yield* Effect.logDebug(`[ble] waitPoweredOn`);
    yield* waitPoweredOn(noble);

    const addressType = options.directAddressType ?? inferredDirectAddressType(address);
    const directConnect = noble.connectAsync?.bind(noble);
    if (addressType && directConnect) {
      yield* awaitPendingDisconnect(() => pendingAddressCleanup(noble, [address]));
      yield* Effect.logDebug(`[ble] connecting directly to ${address} (${addressType})`);
      const generation = {};
      yield* beginConnection(noble, [address], generation);
      let abandonedCleanup: Promise<void> | undefined;
      const cancelDirect = (): void => {
        if (!abandonedCleanup) {
          // Cancellation does not guarantee that the native connect is done.
          // Keep this address fenced through a late result and its disconnect.
          abandonedCleanup = pending.then(
            (peripheral) => (peripheral ? cleanupConnectedPeripheral(peripheral) : undefined),
            () => undefined,
          );
          trackAddressCleanup(noble, [normalizeAddress(address)], abandonedCleanup);
        }
        try {
          noble.cancelConnect?.(address);
        } catch {
          // Continue with discovery even if Noble has already cleared the attempt.
        }
      };
      const pending = Promise.resolve()
        .then(() => directConnect(address, { addressType }))
        .then((peripheral) => {
          if (peripheral) {
            rememberPeripheral(noble, peripheral as Peripheral, address);
            claimConnection(
              noble,
              [...(peripheralOwners.get(peripheral as Peripheral)?.addresses ?? [])],
              generation,
              peripheral as Peripheral,
            );
          }
          return peripheral as Peripheral;
        });
      void pending.catch(() => undefined);
      const direct = yield* Effect.tryPromise({
        try: async () => {
          const peripheral = await pending;
          if (!peripheral) throw new Error("Noble returned no peripheral");
          return peripheral as Peripheral;
        },
        catch: (cause) =>
          new BleError({ cause, message: `Direct BLE connection to ${address} failed` }),
      }).pipe(
        Effect.timeoutOrElse({
          duration: Duration.millis(DIRECT_CONNECT_TIMEOUT_MS),
          orElse: () => {
            return Effect.fail(
              new BleError({
                message: `Direct BLE connection to ${address} timed out after ${DIRECT_CONNECT_TIMEOUT_MS}ms`,
              }),
            );
          },
        }),
        Effect.tapError((error) =>
          Effect.logDebug(`[ble] ${error.message}; falling back to scan`).pipe(
            Effect.andThen(Effect.sync(cancelDirect)),
          ),
        ),
        Effect.onInterrupt(() => Effect.sync(cancelDirect)),
        Effect.orElseSucceed(() => undefined),
      );
      if (direct) return { peripheral: direct, direct: true, generation };
    }

    yield* Effect.logDebug(`[ble] scanning for ${address}`);
    const peripheral = yield* findPeripheral(noble, addresses, findPeripheralTimeoutMs);
    rememberPeripheral(noble, peripheral);
    yield* Effect.logDebug(`[ble] found peripheral; connecting ${address}`);
    const generation = {};
    yield* connectPeripheral(noble, peripheral, address, generation);
    return { peripheral, direct: false, generation };
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
        ({ peripheral, generation }) =>
          Effect.suspend(() =>
            ownsConnection(peripheral, generation)
              ? disconnectPeripheral(peripheral, generation).pipe(Effect.catch(() => Effect.void))
              : Effect.void,
          ),
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
            if (!ownsConnection(peripheral, opened.generation)) return;
            await dataOut.unsubscribeAsync().catch(() => {
              /* swallow */
            });
          }),
      );
      yield* Effect.logDebug(`[ble] subscribed; ready`);
      const notifications: Stream.Stream<Uint8Array, BleError> = Stream.callback<
        Uint8Array,
        BleError
      >((emit) => {
        const handler = (buf: Uint8Array): void => {
          Queue.offerUnsafe(emit, buf);
        };
        return Effect.acquireRelease(
          Effect.sync(() => {
            listeners.add(handler);
          }),
          () =>
            Effect.sync(() => {
              listeners.delete(handler);
            }),
        );
      });
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
  onReady?: (connection: ProxyWriterConnection) => void,
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
          if (!ownsConnection(peripheral, opened.generation)) {
            closed = true;
            return;
          }
          yield* disconnectPeripheral(peripheral, opened.generation);
          closed = true;
        });

      return yield* Effect.gen(function* () {
        yield* Effect.logDebug(`[ble] connected; discovering Data In`);
        const dataIn = yield* withBleTimeout(
          discoverProxyDataIn(peripheral, opened.direct ? 0 : POST_CONNECT_SETTLE_MS),
          "discoverDataIn",
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

        const connection = {
          address,
          write,
          close,
          isConnected: () =>
            !closed &&
            ownsConnection(peripheral, opened.generation) &&
            peripheral.state === "connected",
        } satisfies ProxyWriterConnection;
        // Publish ownership before returning across an interruptible boundary.
        onReady?.(connection);
        return connection;
      }).pipe(Effect.onExit((exit) => (Exit.isFailure(exit) ? close() : Effect.void)));
    }),
  );
