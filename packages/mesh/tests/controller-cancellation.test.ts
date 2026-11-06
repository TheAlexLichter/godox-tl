import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Domain } from "@godox-tl/core";
import { Deferred, Effect, Exit, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { connectProxyWriter } from "../src/ble/proxy.ts";
import type { ProxyWriterConnection } from "../src/ble/types.ts";
import { makeMeshController, type MeshController } from "../src/controller.ts";
import { withMeshSequenceReservation } from "../src/sequences.ts";
import { loadMeshState, saveMeshState } from "../src/state.ts";

vi.mock("../src/ble/proxy.ts", () => ({ connectProxyWriter: vi.fn() }));
const connect = vi.mocked(connectProxyWriter);
const command = Domain.Cct.make({ brightness: Domain.pct(30), temperature: Domain.kelvin(4000) });
let directory: string;
let statePath: string;
let controller: MeshController | undefined;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "godox-cancellation-"));
  statePath = join(directory, "state.json");
  connect.mockReset();
  await Effect.runPromise(
    saveMeshState(statePath, {
      networkKey: new Uint8Array(16).fill(1),
      appKey: new Uint8Array(16).fill(2),
      deviceKey: new Uint8Array(16).fill(3),
      ivIndex: 0,
      provisionerAddress: 1,
      nodeAddress: 2,
      sequenceNumber: 7,
      sequenceDirectory: join(directory, "sequences"),
    }),
  );
});
afterEach(async () => {
  if (controller) await Effect.runPromise(controller.close());
  controller = undefined;
  await rm(directory, { recursive: true, force: true });
});
const writer = (write: ProxyWriterConnection["write"]): ProxyWriterConnection => ({
  address: "fake",
  write,
  close: vi.fn(() => Effect.void),
  isConnected: () => true,
});
const run = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(effect.pipe(Effect.provide(TestClock.layer())));

test("cancelling a queued controller send consumes no sequence range or BLE writes", () =>
  run(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let writes = 0;
      connect.mockReturnValue(
        Effect.succeed(
          writer(() =>
            Effect.gen(function* () {
              writes++;
              if (writes === 1) {
                yield* Deferred.succeed(started, undefined);
                yield* Deferred.await(release);
              }
            }),
          ),
        ),
      );
      controller = makeMeshController({ address: "fake", statePath, coalesce: false });
      const first = yield* Effect.forkChild(controller.send(command), { startImmediately: true });
      yield* Deferred.await(started);
      const cancelled = yield* Effect.forkChild(controller.send(command), {
        startImmediately: true,
      });
      yield* Fiber.interrupt(cancelled);
      yield* Deferred.succeed(release, undefined);
      yield* TestClock.adjust("300 millis");
      yield* Fiber.join(first);
      expect(writes).toBe(3);
      expect((yield* loadMeshState(statePath)).sequenceNumber).toBe(10);
      expect(Exit.hasInterrupts(yield* Fiber.await(cancelled))).toBe(true);
    }),
  ));

test("cancelling an active send closes its writer before a fresh send", () =>
  run(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const freshStarted = yield* Deferred.make<void>();
      let writes = 0;
      const initial = writer(() =>
        Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
      );
      const fresh = writer(() =>
        Effect.sync(() => {
          writes++;
        }).pipe(Effect.andThen(Deferred.succeed(freshStarted, undefined))),
      );
      connect
        .mockReturnValueOnce(Effect.succeed(initial))
        .mockReturnValueOnce(Effect.succeed(fresh));
      controller = makeMeshController({ address: "fake", statePath });
      const first = yield* Effect.forkChild(controller.send(command), { startImmediately: true });
      yield* Deferred.await(started);
      yield* Fiber.interrupt(first);
      expect(initial.close).toHaveBeenCalledTimes(1);
      const following = yield* Effect.forkChild(controller.send(command), {
        startImmediately: true,
      });
      yield* Deferred.await(freshStarted);
      yield* TestClock.adjust("300 millis");
      yield* Fiber.join(following);
      expect(connect).toHaveBeenCalledTimes(2);
      expect(writes).toBe(3);
      expect((yield* loadMeshState(statePath)).sequenceNumber).toBe(13);
    }),
  ));

test("cancellation while waiting for the source lease closes the already-open writer", () =>
  run(
    Effect.gen(function* () {
      const lockHeld = yield* Deferred.make<void>();
      const releaseLock = yield* Deferred.make<void>();
      const opened = yield* Deferred.make<void>();
      const state = yield* loadMeshState(statePath);
      const holder = yield* Effect.forkChild(
        withMeshSequenceReservation(
          state,
          1,
          { statePath, sequenceDirectory: state.sequenceDirectory },
          () =>
            Deferred.succeed(lockHeld, undefined).pipe(Effect.andThen(Deferred.await(releaseLock))),
        ),
        { startImmediately: true },
      );
      yield* Deferred.await(lockHeld);
      const connection = writer(vi.fn(() => Effect.void));
      connect.mockReturnValue(
        Effect.succeed(connection).pipe(Effect.tap(() => Deferred.succeed(opened, undefined))),
      );
      controller = makeMeshController({ address: "fake", statePath });
      const waiting = yield* Effect.forkChild(controller.send(command), { startImmediately: true });
      yield* Deferred.await(opened);
      yield* Fiber.interrupt(waiting);
      expect(connection.close).toHaveBeenCalledTimes(1);
      expect(connection.write).not.toHaveBeenCalled();
      yield* Deferred.succeed(releaseLock, undefined);
      yield* Fiber.join(holder);
      expect((yield* loadMeshState(statePath)).sequenceNumber).toBe(8);
    }),
  ));

test("an idle mailbox does not keep a standalone process alive", async () => {
  const fixture = fileURLToPath(new URL("./fixtures/queue-idle-worker.mjs", import.meta.url));
  const { stdout } = await promisify(execFile)(process.execPath, [fixture, statePath], {
    timeout: 5_000,
  });
  expect(stdout).toContain("worker-finished");
});
