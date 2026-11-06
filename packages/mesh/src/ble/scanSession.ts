import { Effect } from "effect";
import { awaitScanCleanup, ensureScanIdle, type NobleLike, trackScanCleanup } from "./noble.ts";
import { BleError } from "./errors.ts";

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
    let shutdownError: BleError | undefined;
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
            .catch((cause: unknown) => {
              shutdownError = new BleError({
                cause,
                message: `Failed to stop BLE scan: ${cause instanceof Error ? cause.message : String(cause)}`,
              });
            });
          trackScanCleanup(noble, cleanup);
          await awaitScanCleanup(cleanup);
        }),
      ),
      // Do not proceed to connect if shutdown failed or still owns the adapter.
      // A rejected stop has settled, so a later operation may attempt recovery.
      Effect.tap(() =>
        Effect.suspend(() => (shutdownError ? Effect.fail(shutdownError) : ensureScanIdle(noble))),
      ),
    );
  });
