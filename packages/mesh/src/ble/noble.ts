// Module-private wrapper around the noble default export.
//
// Two reasons not to import noble at the top level:
//   1. Loading `@stoprocent/noble` initialises a native HCI binding and
//      opens the local Bluetooth adapter. We want that to happen lazily
//      so importing the package in a context that never scans (CLI help,
//      tests) doesn't fail on machines without BLE.
//   2. Tests want to inject a stub noble without monkey-patching globals.
//
// `getNoble` is an Effect that lazy-loads the real module on first use and
// caches the resulting handle. `__setNobleForTesting` overrides it.

import { Effect } from "effect";
import { BleError } from "./errors.ts";

/** Subset of noble's Peripheral surface we actually use. Mirrors the upstream
 *  types but typed loosely so tests can pass in plain objects. */
export interface PeripheralAdvertisementLike {
  readonly localName?: string;
  readonly serviceUuids?: ReadonlyArray<string>;
}

export interface PeripheralLike {
  readonly id?: string;
  readonly uuid?: string;
  readonly address?: string;
  readonly rssi?: number;
  readonly advertisement?: PeripheralAdvertisementLike;
  // The real Peripheral exposes more; the BLE proxy module reaches in via
  // `as unknown as Peripheral` once it has the real handle from noble.
}

// `on` / `once` / `removeListener` are typed loose enough to be satisfied by
// `EventEmitter` (which uses `(...args: any[]) => void`). Callers cast event
// names + listener shapes per call site; the strict typing happens in the
// concrete handler functions inside scan.ts / proxy.ts.
// biome-ignore lint/suspicious/noExplicitAny: matches Node's EventEmitter signature
export type NobleListener = (...args: any[]) => void;

export interface NobleLike {
  readonly state: string;
  startScanningAsync(
    serviceUuids?: ReadonlyArray<string>,
    allowDuplicates?: boolean,
  ): Promise<void>;
  stopScanningAsync(): Promise<void>;
  on(event: string, listener: NobleListener): unknown;
  once(event: string, listener: NobleListener): unknown;
  removeListener(event: string, listener: NobleListener): unknown;
  reset?(): void;
  stop?(): void;
}

let cached: NobleLike | undefined;
let override: NobleLike | undefined;
const nobleOperationMutex = Effect.unsafeMakeSemaphore(1);

/** Test hook. Pass `undefined` to clear. */
export const __setNobleForTesting = (noble: NobleLike | undefined): void => {
  override = noble;
};

export const getNoble: Effect.Effect<NobleLike, BleError> = Effect.suspend(() => {
  if (override) return Effect.succeed(override);
  if (cached) return Effect.succeed(cached);
  return Effect.tryPromise({
    try: async () => {
      const mod = (await import("@stoprocent/noble")) as { default: NobleLike };
      cached = mod.default;
      return cached;
    },
    catch: (cause) =>
      new BleError({
        cause,
        message: `Failed to load '@stoprocent/noble'. The native HCI binding may not be installed for this platform.`,
      }),
  });
});

/** Noble's Linux HCI backend is process-global around one adapter. Serializing
 * scan/connect/provision operations avoids stop-scan and peripheral-cache races
 * when long-running consumers, such as Homebridge, receive overlapping commands.
 */
export const withNobleOperation = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => effect.pipe(nobleOperationMutex.withPermits(1));

/** Stop the lazily-created noble binding, if it was loaded.
 *
 * The native adapter binding keeps Node's event loop alive even after scans
 * and GATT connections are closed. Long-running consumers should leave it
 * running; one-shot CLI commands call this during process shutdown.
 */
export const shutdownNoble: Effect.Effect<void> = Effect.promise(async () => {
  const noble = override ?? cached;
  if (!noble) return;

  await noble.stopScanningAsync().catch(() => undefined);
  noble.stop?.();
  cached = undefined;
});
