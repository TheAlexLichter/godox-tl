import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Domain } from "@godox-tl/core";
import { Cause, Clock, Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { BleError } from "../src/ble/errors.ts";
import { connectProxyWriter } from "../src/ble/proxy.ts";
import type { ProxyWriterConnection } from "../src/ble/types.ts";
import { makeMeshController } from "../src/controller.ts";
import { k2 } from "../src/crypto/kdf.ts";
import { decodeNetworkPdu } from "../src/pdu/network.ts";
import { decodeProxyPdu } from "../src/pdu/proxy.ts";
import { loadMeshState, saveMeshState, type MeshState } from "../src/state.ts";

vi.mock("../src/ble/proxy.ts", () => ({ connectProxyWriter: vi.fn() }));

const connect = vi.mocked(connectProxyWriter);
const command = Domain.Cct.make({ brightness: Domain.pct(30), temperature: Domain.kelvin(4000) });
const state: MeshState = {
  networkKey: new Uint8Array(16).fill(1),
  appKey: new Uint8Array(16).fill(2),
  deviceKey: new Uint8Array(16).fill(3),
  nodeAddress: 2,
  provisionerAddress: 1,
  ivIndex: 0,
  sequenceNumber: 7,
};
const keys = k2(state.networkKey, Uint8Array.of(0));
const sequence = (pdu: Uint8Array): number =>
  decodeNetworkPdu({ pdu: decodeProxyPdu(pdu).payload, ivIndex: 0, ...keys }).seq;

let dir: string;
let statePath: string;

beforeEach(async () => {
  connect.mockReset();
  dir = await mkdtemp(join(tmpdir(), "godox-controller-retry-"));
  statePath = join(dir, "state.json");
  await Effect.runPromise(
    saveMeshState(statePath, { ...state, sequenceDirectory: join(dir, "sequences") }),
  );
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(dir, { recursive: true, force: true });
});

const makeWriter = (write: ProxyWriterConnection["write"], isConnected = () => true) =>
  ({
    address: "test-light",
    write,
    isConnected,
    close: vi.fn(() => Effect.void),
  }) satisfies ProxyWriterConnection;

// Install the tracking scheduler as well as the clock. The controller captures
// this context for queued sends and cleanup effects.
const runWithTestClock = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(Effect.provide(effect, TestClock.layer()));

test("reopens a disconnected cached writer before another command", async () => {
  await runWithTestClock(
    Effect.gen(function* () {
      let connected = true;
      const firstWrites: number[] = [];
      const nextWrites: number[] = [];
      const firstStarted = yield* Deferred.make<void>();
      const nextStarted = yield* Deferred.make<void>();
      const first = makeWriter(
        (pdu) =>
          Effect.sync(() => firstWrites.push(sequence(pdu))).pipe(
            Effect.andThen(Deferred.succeed(firstStarted, undefined)),
            Effect.asVoid,
          ),
        () => connected,
      );
      const next = makeWriter((pdu) =>
        Effect.sync(() => nextWrites.push(sequence(pdu))).pipe(
          Effect.andThen(Deferred.succeed(nextStarted, undefined)),
          Effect.asVoid,
        ),
      );
      connect.mockReturnValueOnce(Effect.succeed(first)).mockReturnValueOnce(Effect.succeed(next));
      const controller = makeMeshController({ address: "test-light", statePath });

      const initial = yield* Effect.forkChild(controller.send(command));
      yield* Deferred.await(firstStarted);
      yield* TestClock.adjust("300 millis");
      yield* Fiber.join(initial);
      const firstCount = firstWrites.length;
      const nextSequence = (yield* loadMeshState(statePath)).sequenceNumber;
      connected = false;
      const following = yield* Effect.forkChild(controller.send(command));
      yield* Deferred.await(nextStarted);
      yield* TestClock.adjust("300 millis");
      yield* Fiber.join(following);

      expect(connect).toHaveBeenCalledTimes(2);
      expect(first.close).toHaveBeenCalledTimes(1);
      expect(firstWrites).toHaveLength(firstCount);
      expect(nextWrites[0]).toBe(nextSequence);
    }),
  );
});

test("retries a failed cached writer with fresh sequence numbers", async () => {
  await runWithTestClock(
    Effect.gen(function* () {
      let failWrites = false;
      const attempts: number[] = [];
      const recovered: number[] = [];
      const cachedStarted = yield* Deferred.make<void>();
      const freshStarted = yield* Deferred.make<void>();
      const cached = makeWriter((pdu) =>
        Effect.sync(() => attempts.push(sequence(pdu))).pipe(
          Effect.andThen(Deferred.succeed(cachedStarted, undefined)),
          Effect.andThen(
            Effect.suspend(() =>
              failWrites ? Effect.fail(new BleError({ message: "link dropped" })) : Effect.void,
            ),
          ),
        ),
      );
      const fresh = makeWriter((pdu) =>
        Effect.sync(() => recovered.push(sequence(pdu))).pipe(
          Effect.andThen(Deferred.succeed(freshStarted, undefined)),
          Effect.asVoid,
        ),
      );
      connect
        .mockReturnValueOnce(Effect.succeed(cached))
        .mockReturnValueOnce(Effect.succeed(fresh));
      const controller = makeMeshController({ address: "test-light", statePath });

      const initial = yield* Effect.forkChild(controller.send(command));
      yield* Deferred.await(cachedStarted);
      yield* TestClock.adjust("300 millis");
      yield* Fiber.join(initial);
      const beforeFailure = (yield* loadMeshState(statePath)).sequenceNumber;
      failWrites = true;
      const retry = yield* Effect.forkChild(controller.send(command));
      yield* Deferred.await(freshStarted);
      yield* TestClock.adjust("300 millis");
      yield* Fiber.join(retry);

      expect(connect).toHaveBeenCalledTimes(2);
      expect(cached.close).toHaveBeenCalledTimes(1);
      expect(attempts.at(-1)).toBe(beforeFailure);
      expect(recovered[0]).toBeGreaterThan(beforeFailure);
      const nextSequence = (yield* loadMeshState(statePath)).sequenceNumber;
      expect(recovered.at(-1)).toBe(nextSequence - 1);
    }),
  );
});

test("a second BLE failure stops after one retry", async () => {
  const attempts: number[] = [];
  const fail = (pdu: Uint8Array) =>
    Effect.sync(() => attempts.push(sequence(pdu))).pipe(
      Effect.andThen(Effect.fail(new BleError({ message: "write refused" }))),
    );
  const first = makeWriter(fail);
  const second = makeWriter(fail);
  connect.mockReturnValueOnce(Effect.succeed(first)).mockReturnValueOnce(Effect.succeed(second));
  const controller = makeMeshController({ address: "test-light", statePath });

  const result = await Effect.runPromiseExit(controller.send(command));

  expect(result._tag).toBe("Failure");
  expect(connect).toHaveBeenCalledTimes(2);
  expect(first.close).toHaveBeenCalledTimes(1);
  expect(second.close).toHaveBeenCalledTimes(1);
  expect(attempts).toHaveLength(2);
  expect(attempts[1]).toBeGreaterThan(attempts[0]!);
});

test("the retry shares the original overall send deadline", async () => {
  await runWithTestClock(
    Effect.gen(function* () {
      const firstStarted = yield* Deferred.make<void>();
      const secondStarted = yield* Deferred.make<void>();
      const settled = yield* Deferred.make<void>();
      const first = makeWriter(() =>
        Deferred.succeed(firstStarted, undefined).pipe(
          Effect.andThen(Effect.sleep("35 millis")),
          Effect.andThen(Effect.fail(new BleError({ message: "link dropped" }))),
        ),
      );
      const second = makeWriter(() =>
        Deferred.succeed(secondStarted, undefined).pipe(Effect.andThen(Effect.never)),
      );
      connect
        .mockReturnValueOnce(Effect.succeed(first))
        .mockReturnValueOnce(Effect.succeed(second));
      const controller = makeMeshController({
        address: "test-light",
        statePath,
        sendTimeoutMs: 60,
        writeTimeoutMs: 500,
      });
      const result = yield* controller.send(command).pipe(
        Effect.exit,
        Effect.tap(() => Deferred.succeed(settled, undefined)),
        Effect.forkChild,
      );

      yield* Deferred.await(firstStarted);
      yield* TestClock.adjust("35 millis");
      // Allow real filesystem allocation/release to finish before advancing the
      // Effect clock again; the retry must already be writing at the old deadline.
      yield* Deferred.await(secondStarted);
      yield* TestClock.adjust("24 millis");
      expect(yield* Deferred.isDone(settled)).toBe(false);
      yield* TestClock.adjust("1 millis");
      const failure = yield* Fiber.join(result);

      expect(failure._tag).toBe("Failure");
      if (failure._tag === "Failure")
        expect(Cause.pretty(failure.cause)).toContain("timed out after 60ms");
      expect(yield* Clock.currentTimeMillis).toBe(60);
      expect(connect).toHaveBeenCalledTimes(2);
      expect(second.close).toHaveBeenCalledTimes(1);
    }),
  );
});

test("write timeouts retry once with fresh sequences and stop at the second timeout", async () => {
  await runWithTestClock(
    Effect.gen(function* () {
      const firstStarted = yield* Deferred.make<void>();
      const secondStarted = yield* Deferred.make<void>();
      const settled = yield* Deferred.make<void>();
      const attempts: number[] = [];
      const blockedWriter = (started: Deferred.Deferred<void>) =>
        makeWriter((pdu) =>
          Effect.sync(() => attempts.push(sequence(pdu))).pipe(
            Effect.andThen(Deferred.succeed(started, undefined)),
            Effect.andThen(Effect.never),
          ),
        );
      const first = blockedWriter(firstStarted);
      const second = blockedWriter(secondStarted);
      connect
        .mockReturnValueOnce(Effect.succeed(first))
        .mockReturnValueOnce(Effect.succeed(second));
      const controller = makeMeshController({
        address: "test-light",
        statePath,
        writeTimeoutMs: 50,
        sendTimeoutMs: 1000,
      });
      const result = yield* controller.send(command).pipe(
        Effect.exit,
        Effect.tap(() => Deferred.succeed(settled, undefined)),
        Effect.forkChild,
      );
      yield* Deferred.await(firstStarted);
      yield* TestClock.adjust("49 millis");
      expect(first.close).not.toHaveBeenCalled();
      expect(connect).toHaveBeenCalledTimes(1);
      expect(yield* Deferred.isDone(settled)).toBe(false);
      yield* TestClock.adjust("1 millis");
      yield* Deferred.await(secondStarted);
      expect(first.close).toHaveBeenCalledTimes(1);
      yield* TestClock.adjust("49 millis");
      expect(second.close).not.toHaveBeenCalled();
      expect(yield* Deferred.isDone(settled)).toBe(false);
      yield* TestClock.adjust("1 millis");
      const failure = yield* Fiber.join(result);

      expect(failure._tag).toBe("Failure");
      if (failure._tag === "Failure")
        expect(Cause.pretty(failure.cause)).toContain("write timed out after 50ms");
      expect(yield* Clock.currentTimeMillis).toBe(100);
      expect(connect).toHaveBeenCalledTimes(2);
      expect(second.close).toHaveBeenCalledTimes(1);
      expect(attempts).toHaveLength(2);
      expect(attempts[1]).toBeGreaterThan(attempts[0]!);
    }),
  );
});

test("state-file failures do not trigger a BLE reconnect retry", async () => {
  await rm(statePath);
  let writeCount = 0;
  connect.mockReturnValue(
    Effect.succeed(
      makeWriter(() =>
        Effect.sync(() => {
          writeCount++;
        }),
      ),
    ),
  );
  const controller = makeMeshController({ address: "test-light", statePath });

  const result = await Effect.runPromiseExit(controller.send(command));

  expect(result._tag).toBe("Failure");
  expect(connect.mock.calls.length).toBeLessThanOrEqual(1);
  expect(writeCount).toBe(0);
});

const deferred = () => {
  let complete: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    complete = resolve;
  });
  return { promise, resolve: () => complete?.() };
};

test("a new send joins idle cleanup before replacing the same peripheral", async () => {
  // Idle close uses Node's setTimeout, so this test needs native timer control.
  vi.useFakeTimers();
  const firstWrite = deferred();
  const closeStarted = deferred();
  const closeReleased = deferred();
  const replacementWrite = deferred();
  const events: string[] = [];
  const first = {
    ...makeWriter(() => Effect.sync(() => firstWrite.resolve())),
    close: vi.fn<ProxyWriterConnection["close"]>(() =>
      Effect.sync(() => {
        events.push("old-close");
        closeStarted.resolve();
      }).pipe(Effect.andThen(Effect.promise(() => closeReleased.promise))),
    ),
  };
  const replacement = makeWriter(() => Effect.sync(() => replacementWrite.resolve()));
  connect.mockReturnValueOnce(Effect.succeed(first)).mockReturnValueOnce(
    Effect.sync(() => {
      events.push("replacement-connect");
      return replacement;
    }),
  );
  const controller = makeMeshController({ address: "test-light", statePath, connectionIdleMs: 10 });
  const initial = Effect.runPromise(controller.send(Domain.Off.make({})));
  await firstWrite.promise;
  await vi.advanceTimersByTimeAsync(200);
  await initial;
  await vi.advanceTimersByTimeAsync(10);
  await closeStarted.promise;

  const next = Effect.runPromise(controller.send(command));
  await vi.advanceTimersByTimeAsync(20);
  expect(connect).toHaveBeenCalledTimes(1);
  closeReleased.resolve();
  await replacementWrite.promise;
  await vi.advanceTimersByTimeAsync(300);
  await next;

  expect(events).toEqual(["old-close", "replacement-connect"]);
  expect(first.close).toHaveBeenCalledTimes(1);
});

test("timeout cleanup cannot retry an old close after a queued replacement connects", async () => {
  await runWithTestClock(
    Effect.gen(function* () {
      const closeStarted = yield* Deferred.make<void>();
      const secondCloseStarted = yield* Deferred.make<void>();
      const secondCloseReleased = yield* Deferred.make<void>();
      const replacementWrite = yield* Deferred.make<void>();
      const settled = yield* Deferred.make<void>();
      const events: string[] = [];
      let closeAttempts = 0;
      const first = {
        ...makeWriter(() => Effect.fail(new BleError({ message: "link dropped" }))),
        close: vi.fn<ProxyWriterConnection["close"]>(() =>
          Effect.gen(function* () {
            closeAttempts++;
            events.push(`old-close-${closeAttempts}`);
            yield* Deferred.succeed(closeStarted, undefined);
            if (closeAttempts === 1) return yield* Effect.never;
            yield* Deferred.succeed(secondCloseStarted, undefined);
            yield* Deferred.await(secondCloseReleased);
          }),
        ),
      };
      connect.mockReturnValueOnce(Effect.succeed(first)).mockReturnValueOnce(
        Effect.sync(() => {
          events.push("replacement-connect");
          return makeWriter(() =>
            Deferred.succeed(replacementWrite, undefined).pipe(Effect.asVoid),
          );
        }),
      );
      const controller = makeMeshController({
        address: "test-light",
        statePath,
        sendTimeoutMs: 500,
      });
      const failing = yield* controller.send(command).pipe(
        Effect.exit,
        Effect.tap(() => Deferred.succeed(settled, undefined)),
        Effect.forkChild,
      );
      yield* Deferred.await(closeStarted);
      const queued = yield* Effect.forkChild(controller.send(Domain.Off.make({})));
      yield* TestClock.adjust("500 millis");
      expect(yield* Deferred.isDone(settled)).toBe(false);
      expect(connect).toHaveBeenCalledTimes(1);
      yield* TestClock.adjust("2499 millis");
      expect(closeAttempts).toBe(1);
      yield* TestClock.adjust("1 millis");
      yield* Deferred.await(secondCloseStarted);
      expect(connect).toHaveBeenCalledTimes(1);
      yield* Deferred.succeed(secondCloseReleased, undefined);
      const failure = yield* Fiber.join(failing);
      expect(failure._tag).toBe("Failure");
      if (failure._tag === "Failure")
        expect(Cause.pretty(failure.cause)).toContain("timed out after 500ms");
      yield* Deferred.await(replacementWrite);
      yield* TestClock.adjust("200 millis");
      yield* Fiber.join(queued);
      yield* TestClock.adjust("3000 millis");

      expect(events).toEqual(["old-close-1", "old-close-2", "replacement-connect"]);
      expect(connect).toHaveBeenCalledTimes(2);
    }),
  );
});

test("failed cleanup fences replacement until a later close completes", async () => {
  await runWithTestClock(
    Effect.gen(function* () {
      const closeStarted = yield* Deferred.make<void>();
      const secondCloseStarted = yield* Deferred.make<void>();
      const writeStarted = yield* Deferred.make<void>();
      const closeReleased = yield* Deferred.make<void>();
      const replacementWrite = yield* Deferred.make<void>();
      const settled = yield* Deferred.make<void>();
      let closeAttempts = 0;
      const first = {
        ...makeWriter(() =>
          Deferred.succeed(writeStarted, undefined).pipe(Effect.andThen(Effect.never)),
        ),
        close: vi.fn<ProxyWriterConnection["close"]>(() =>
          Effect.gen(function* () {
            closeAttempts++;
            yield* Deferred.succeed(closeStarted, undefined);
            if (closeAttempts === 2) yield* Deferred.succeed(secondCloseStarted, undefined);
            yield* Deferred.await(closeReleased);
          }),
        ),
      };
      connect
        .mockReturnValueOnce(Effect.succeed(first))
        .mockReturnValueOnce(
          Effect.succeed(
            makeWriter(() => Deferred.succeed(replacementWrite, undefined).pipe(Effect.asVoid)),
          ),
        );
      const controller = makeMeshController({
        address: "test-light",
        statePath,
        sendTimeoutMs: 500,
      });
      const failing = yield* controller.send(command).pipe(
        Effect.exit,
        Effect.tap(() => Deferred.succeed(settled, undefined)),
        Effect.forkChild,
      );
      yield* Deferred.await(writeStarted);
      yield* TestClock.adjust("499 millis");
      expect(closeAttempts).toBe(0);
      yield* TestClock.adjust("1 millis");
      yield* Deferred.await(closeStarted);
      yield* TestClock.adjust("2999 millis");
      expect(closeAttempts).toBe(1);
      expect(yield* Deferred.isDone(settled)).toBe(false);
      yield* TestClock.adjust("1 millis");
      yield* Deferred.await(secondCloseStarted);
      yield* TestClock.adjust("2999 millis");
      expect(closeAttempts).toBe(2);
      expect(yield* Deferred.isDone(settled)).toBe(false);
      yield* TestClock.adjust("1 millis");
      const failure = yield* Fiber.join(failing);
      expect(yield* Clock.currentTimeMillis).toBe(6500);
      expect(failure._tag).toBe("Failure");
      if (failure._tag === "Failure")
        expect(Cause.pretty(failure.cause)).toContain("timed out after 500ms");
      expect(closeAttempts).toBe(2);
      expect(connect).toHaveBeenCalledTimes(1);

      const recovering = yield* Effect.forkChild(controller.send(Domain.Off.make({})));
      yield* TestClock.adjust("100 millis");
      expect(connect).toHaveBeenCalledTimes(1);
      yield* Deferred.succeed(closeReleased, undefined);
      yield* Deferred.await(replacementWrite);
      yield* TestClock.adjust("200 millis");
      yield* Fiber.join(recovering);
      yield* TestClock.adjust("3000 millis");

      expect(closeAttempts).toBe(3);
      expect(connect).toHaveBeenCalledTimes(2);
    }),
  );
});

test("a timed-out write holds the source lease until disconnect cleanup finishes", async () => {
  // The shared filesystem lease polls using native timers; keep this test live.
  const firstWrite = deferred();
  const closeStarted = deferred();
  const closeReleased = deferred();
  const secondConnected = deferred();
  const secondWrite = vi.fn(() => Effect.void);
  const first = {
    ...makeWriter(() => Effect.sync(() => firstWrite.resolve()).pipe(Effect.andThen(Effect.never))),
    close: vi.fn<ProxyWriterConnection["close"]>(() =>
      Effect.sync(() => closeStarted.resolve()).pipe(
        Effect.andThen(Effect.promise(() => closeReleased.promise)),
      ),
    ),
  };
  connect.mockReturnValueOnce(Effect.succeed(first)).mockReturnValueOnce(
    Effect.sync(() => {
      secondConnected.resolve();
      return makeWriter(secondWrite);
    }),
  );
  const interrupted = makeMeshController({ address: "test-light", statePath, sendTimeoutMs: 500 });
  const next = makeMeshController({ address: "test-light", statePath, sendTimeoutMs: 5000 });
  const interruptedSend = Effect.runPromiseExit(interrupted.send(command));
  await firstWrite.promise;
  await closeStarted.promise;

  const nextSend = Effect.runPromiseExit(next.send(command));
  await secondConnected.promise;
  await Effect.runPromise(Effect.sleep("25 millis"));
  expect(secondWrite).not.toHaveBeenCalled();
  closeReleased.resolve();

  const [failure, success] = await Promise.all([interruptedSend, nextSend]);
  expect(failure._tag).toBe("Failure");
  expect(success._tag).toBe("Success");
  expect(secondWrite).toHaveBeenCalledTimes(3);
  expect(first.close).toHaveBeenCalledTimes(1);
});
