import { Effect } from "effect";
import { awaitScanCleanup, ensureScanIdle, type NobleLike, trackScanCleanup } from "./noble.ts";
import type { BleError } from "./errors.ts";

/** Own scan shutdown until it completes, including after cancellation. If a
 * native start/stop hangs, release the operation lock after a bounded wait but
 * keep the adapter guarded so a late stop cannot cancel a newer operation.
 */
export const withScanCleanup = <A, E, R>(
  noble: NobleLike,
  scan: (start: (startScanning: () => Promise<void>) => Promise<void>) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | BleError, R> =>
  Effect.gen(function* () {
    yield* ensureScanIdle(noble);
    let started: Promise<void> | undefined;
    const start = (startScanning: () => Promise<void>): Promise<void> => {
      started = Promise.resolve().then(startScanning);
      return started;
    };

    return yield* scan(start).pipe(
      Effect.ensuring(
        Effect.promise(async () => {
          if (!started) return;
          // Await a delayed start before stopping it: stopping first could let
          // the eventual start revive scanning after another operation starts.
          const cleanup = started
            .catch(() => undefined)
            .then(() => noble.stopScanningAsync())
            .catch(() => undefined);
          trackScanCleanup(noble, cleanup);
          await awaitScanCleanup(cleanup);
        }),
      ),
      // Do not proceed to connect after a successful discovery if its scan
      // shutdown timed out. The adapter is still owned by that old cleanup.
      Effect.zipLeft(ensureScanIdle(noble)),
    );
  });
