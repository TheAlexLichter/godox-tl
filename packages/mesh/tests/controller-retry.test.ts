import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Domain } from "@godox-tl/core";
import { Cause, Effect } from "effect";
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
  await Effect.runPromise(saveMeshState(statePath, state));
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

test("reopens a disconnected cached writer before another command", async () => {
  let connected = true;
  const firstWrites: number[] = [];
  const nextWrites: number[] = [];
  const first = makeWriter(
    (pdu) =>
      Effect.sync(() => {
        firstWrites.push(sequence(pdu));
      }),
    () => connected,
  );
  const next = makeWriter((pdu) =>
    Effect.sync(() => {
      nextWrites.push(sequence(pdu));
    }),
  );
  connect.mockReturnValueOnce(Effect.succeed(first)).mockReturnValueOnce(Effect.succeed(next));
  const controller = makeMeshController({ address: "test-light", statePath });

  await Effect.runPromise(controller.send(command));
  const firstCount = firstWrites.length;
  const nextSequence = (await Effect.runPromise(loadMeshState(statePath))).sequenceNumber;
  connected = false;
  await Effect.runPromise(controller.send(command));

  expect(connect).toHaveBeenCalledTimes(2);
  expect(first.close).toHaveBeenCalledTimes(1);
  expect(firstWrites).toHaveLength(firstCount);
  expect(nextWrites[0]).toBe(nextSequence);
});

test("retries a failed cached writer with fresh sequence numbers", async () => {
  let failWrites = false;
  const attempts: number[] = [];
  const recovered: number[] = [];
  const cached = makeWriter((pdu) =>
    Effect.sync(() => attempts.push(sequence(pdu))).pipe(
      Effect.zipRight(
        Effect.suspend(() =>
          failWrites ? Effect.fail(new BleError({ message: "link dropped" })) : Effect.void,
        ),
      ),
    ),
  );
  const fresh = makeWriter((pdu) =>
    Effect.sync(() => {
      recovered.push(sequence(pdu));
    }),
  );
  connect.mockReturnValueOnce(Effect.succeed(cached)).mockReturnValueOnce(Effect.succeed(fresh));
  const controller = makeMeshController({ address: "test-light", statePath });

  await Effect.runPromise(controller.send(command));
  const beforeFailure = (await Effect.runPromise(loadMeshState(statePath))).sequenceNumber;
  failWrites = true;
  await Effect.runPromise(controller.send(command));

  expect(connect).toHaveBeenCalledTimes(2);
  expect(cached.close).toHaveBeenCalledTimes(1);
  expect(attempts.at(-1)).toBe(beforeFailure);
  expect(recovered[0]).toBeGreaterThan(beforeFailure);
  const nextSequence = (await Effect.runPromise(loadMeshState(statePath))).sequenceNumber;
  expect(recovered.at(-1)).toBe(nextSequence - 1);
});

test("a second BLE failure stops after one retry", async () => {
  const attempts: number[] = [];
  const fail = (pdu: Uint8Array) =>
    Effect.sync(() => attempts.push(sequence(pdu))).pipe(
      Effect.zipRight(Effect.fail(new BleError({ message: "write refused" }))),
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
  vi.useFakeTimers();
  let firstStarted: (() => void) | undefined;
  let secondStarted: (() => void) | undefined;
  const firstSignal = new Promise<void>((resolve) => {
    firstStarted = resolve;
  });
  const secondSignal = new Promise<void>((resolve) => {
    secondStarted = resolve;
  });
  const first = makeWriter(() =>
    Effect.sync(() => firstStarted?.()).pipe(
      Effect.zipRight(Effect.sleep("35 millis")),
      Effect.zipRight(Effect.fail(new BleError({ message: "link dropped" }))),
    ),
  );
  const second = makeWriter(() =>
    Effect.sync(() => secondStarted?.()).pipe(Effect.zipRight(Effect.never)),
  );
  connect.mockReturnValueOnce(Effect.succeed(first)).mockReturnValueOnce(Effect.succeed(second));
  const controller = makeMeshController({
    address: "test-light",
    statePath,
    sendTimeoutMs: 60,
    writeTimeoutMs: 500,
  });
  let settled = false;
  const result = Effect.runPromiseExit(controller.send(command)).then((exit) => {
    settled = true;
    return exit;
  });

  await firstSignal;
  await vi.advanceTimersByTimeAsync(35);
  await secondSignal;
  await vi.advanceTimersByTimeAsync(24);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);

  expect((await result)._tag).toBe("Failure");
  expect(connect).toHaveBeenCalledTimes(2);
  expect(second.close).toHaveBeenCalledTimes(1);
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
      }).pipe(Effect.zipRight(Effect.promise(() => closeReleased.promise))),
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
  vi.useFakeTimers();
  const closeStarted = deferred();
  const secondCloseStarted = deferred();
  const secondCloseReleased = deferred();
  const replacementWrite = deferred();
  const events: string[] = [];
  let closeAttempts = 0;
  const first = {
    ...makeWriter(() => Effect.fail(new BleError({ message: "link dropped" }))),
    close: vi.fn<ProxyWriterConnection["close"]>(() =>
      Effect.suspend(() => {
        closeAttempts++;
        events.push(`old-close-${closeAttempts}`);
        closeStarted.resolve();
        if (closeAttempts === 1) return Effect.never;
        secondCloseStarted.resolve();
        return Effect.promise(() => secondCloseReleased.promise);
      }),
    ),
  };
  connect.mockReturnValueOnce(Effect.succeed(first)).mockReturnValueOnce(
    Effect.sync(() => {
      events.push("replacement-connect");
      return makeWriter(() => Effect.sync(() => replacementWrite.resolve()));
    }),
  );
  const controller = makeMeshController({ address: "test-light", statePath, sendTimeoutMs: 500 });
  let settled = false;
  const failing = Effect.runPromiseExit(controller.send(command)).then((result) => {
    settled = true;
    return result;
  });
  await closeStarted.promise;
  const queued = Effect.runPromise(controller.send(Domain.Off.make({})));
  await vi.advanceTimersByTimeAsync(500);
  expect(settled).toBe(false);
  expect(connect).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(2500);
  await secondCloseStarted.promise;
  expect(connect).toHaveBeenCalledTimes(1);
  secondCloseReleased.resolve();
  const failure = await failing;
  expect(failure._tag).toBe("Failure");
  if (failure._tag === "Failure")
    expect(Cause.pretty(failure.cause)).toContain("timed out after 500ms");
  await replacementWrite.promise;
  await vi.advanceTimersByTimeAsync(200);
  await queued;
  await vi.advanceTimersByTimeAsync(3000);

  expect(events).toEqual(["old-close-1", "old-close-2", "replacement-connect"]);
  expect(connect).toHaveBeenCalledTimes(2);
});

test("failed cleanup fences replacement until a later native disconnect completes", async () => {
  vi.useFakeTimers();
  const closeStarted = deferred();
  const writeStarted = deferred();
  const nativeDisconnect = deferred();
  const replacementWrite = deferred();
  let closeAttempts = 0;
  const first = {
    ...makeWriter(() =>
      Effect.sync(() => writeStarted.resolve()).pipe(Effect.zipRight(Effect.never)),
    ),
    close: vi.fn<ProxyWriterConnection["close"]>(() =>
      Effect.sync(() => {
        closeAttempts++;
        closeStarted.resolve();
      }).pipe(Effect.zipRight(Effect.promise(() => nativeDisconnect.promise))),
    ),
  };
  connect
    .mockReturnValueOnce(Effect.succeed(first))
    .mockReturnValueOnce(
      Effect.succeed(makeWriter(() => Effect.sync(() => replacementWrite.resolve()))),
    );
  const controller = makeMeshController({ address: "test-light", statePath, sendTimeoutMs: 500 });
  const failing = Effect.runPromiseExit(controller.send(command));
  await writeStarted.promise;
  const startedAt = Date.now();
  await vi.advanceTimersByTimeAsync(500);
  await closeStarted.promise;
  await vi.advanceTimersByTimeAsync(6000);
  const failure = await failing;
  expect(Date.now() - startedAt).toBe(6500);
  expect(failure._tag).toBe("Failure");
  if (failure._tag === "Failure")
    expect(Cause.pretty(failure.cause)).toContain("timed out after 500ms");
  expect(closeAttempts).toBe(2);
  expect(connect).toHaveBeenCalledTimes(1);

  const recovering = Effect.runPromise(controller.send(Domain.Off.make({})));
  await vi.advanceTimersByTimeAsync(100);
  expect(connect).toHaveBeenCalledTimes(1);
  nativeDisconnect.resolve();
  await replacementWrite.promise;
  await vi.advanceTimersByTimeAsync(200);
  await recovering;
  await vi.advanceTimersByTimeAsync(3000);

  expect(closeAttempts).toBe(3);
  expect(connect).toHaveBeenCalledTimes(2);
});
