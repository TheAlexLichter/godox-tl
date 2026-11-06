import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Domain, LightController } from "@godox-tl/core";
import { Effect, Exit, Scope } from "effect";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { connectProxyWriter } from "../src/ble/proxy.ts";
import {
  makeMeshController,
  makeMeshControllerScoped,
  type MeshController,
} from "../src/controller.ts";
import { makeNodeMeshLayer } from "../src/index.ts";
import { saveMeshState } from "../src/state.ts";

vi.mock("../src/ble/proxy.ts", () => ({ connectProxyWriter: vi.fn() }));
const connect = vi.mocked(connectProxyWriter);
const command = Domain.Cct.make({ brightness: Domain.pct(30), temperature: Domain.kelvin(4000) });
const signal = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
let dir: string;
let statePath: string;
let controllers: MeshController[];
beforeEach(async () => {
  connect.mockReset();
  controllers = [];
  dir = await mkdtemp(join(tmpdir(), "godox-shutdown-"));
  statePath = join(dir, "state.json");
  await Effect.runPromise(
    saveMeshState(statePath, {
      networkKey: new Uint8Array(16),
      appKey: new Uint8Array(16),
      deviceKey: new Uint8Array(16),
      ivIndex: 0,
      provisionerAddress: 1,
      nodeAddress: 2,
      sequenceNumber: 0,
      sequenceDirectory: join(dir, "sequences"),
    }),
  );
});
afterEach(async () => {
  await Promise.all(controllers.map((c) => Effect.runPromise(c.close())));
  vi.useRealTimers();
  await rm(dir, { recursive: true, force: true });
});
const controller = (options: { coalesce?: boolean; connectionIdleMs?: number } = {}) => {
  const c = makeMeshController({ address: "test-light", statePath, ...options });
  controllers.push(c);
  return c;
};

test.each([true, false])(
  "shutdown interrupts busy work and rejects every queued caller (coalesce=%s)",
  async (coalesce) => {
    const started = signal();
    const closing = signal();
    const release = signal();
    const write = vi.fn(() => Effect.sync(started.resolve).pipe(Effect.andThen(Effect.never)));
    const close = vi.fn(() =>
      Effect.sync(closing.resolve).pipe(Effect.andThen(Effect.promise(() => release.promise))),
    );
    connect.mockReturnValue(Effect.succeed({ address: "test-light", write, close }));
    const c = controller({ coalesce });
    const busy = Effect.runPromiseExit(c.send(command));
    await started.promise;
    const queued = [Effect.runPromiseExit(c.send(command)), Effect.runPromiseExit(c.send(command))];
    let finished = false;
    const shutdown = Effect.runPromise(c.close()).then(() => {
      finished = true;
    });
    await closing.promise;
    expect((await Promise.all(queued)).every(Exit.isFailure)).toBe(true);
    expect(Exit.isFailure(await Effect.runPromiseExit(c.send(command)))).toBe(true);
    expect(finished).toBe(false);
    expect(write).toHaveBeenCalledTimes(1);
    release.resolve();
    await shutdown;
    expect(Exit.isFailure(await busy)).toBe(true);
    await Effect.runPromise(c.close());
    expect(close).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledTimes(1);
  },
);

test("idle shutdown closes once and cancels its scheduled cleanup", async () => {
  const close = vi.fn(() => Effect.void);
  connect.mockReturnValue(
    Effect.succeed({ address: "test-light", write: () => Effect.void, close }),
  );
  const c = controller({ connectionIdleMs: 500 });
  await Effect.runPromise(c.send(command));
  vi.useFakeTimers();
  await Promise.all([Effect.runPromise(c.close()), Effect.runPromise(c.close())]);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(close).toHaveBeenCalledTimes(1);
  expect(Exit.isFailure(await Effect.runPromiseExit(c.send(command)))).toBe(true);
});

test("shutdown cancels an active connection attempt", async () => {
  const connecting = signal();
  const interrupted = vi.fn();
  connect.mockReturnValue(
    Effect.sync(connecting.resolve).pipe(
      Effect.andThen(Effect.never),
      Effect.onInterrupt(() => Effect.sync(interrupted)),
    ),
  );
  const c = controller();
  const sending = Effect.runPromiseExit(c.send(command));
  await connecting.promise;
  await Effect.runPromise(c.close());
  expect(interrupted).toHaveBeenCalledTimes(1);
  expect(Exit.isFailure(await sending)).toBe(true);
  expect(connect).toHaveBeenCalledTimes(1);
});

test("shutdown joins existing bounded cleanup without another retry cycle", async () => {
  const started = signal();
  const closing = signal();
  const close = vi.fn(() => Effect.sync(closing.resolve).pipe(Effect.andThen(Effect.never)));
  connect.mockReturnValue(
    Effect.succeed({
      address: "test-light",
      write: () => Effect.sync(started.resolve).pipe(Effect.andThen(Effect.never)),
      close,
    }),
  );
  const c = controller();
  const sending = Effect.runPromiseExit(c.send(command));
  await started.promise;
  vi.useFakeTimers();
  const shutdown = Effect.runPromise(c.close());
  await closing.promise;
  await vi.advanceTimersByTimeAsync(6_000);
  await shutdown;
  await sending;
  await Effect.runPromise(c.close());
  expect(close).toHaveBeenCalledTimes(2);
});

test("scoped constructor closes the controller when released", async () => {
  const scope = Scope.makeUnsafe();
  const c = await Effect.runPromise(
    makeMeshControllerScoped({ address: "test-light", statePath }).pipe(Scope.provide(scope)),
  );
  await Effect.runPromise(Scope.close(scope, Exit.void));
  expect(Exit.isFailure(await Effect.runPromiseExit(c.send(command)))).toBe(true);
  expect(connect).not.toHaveBeenCalled();
});

test("shutdown waits for idle cleanup already in progress", async () => {
  const cleaning = signal();
  const release = signal();
  const close = vi.fn(() =>
    Effect.sync(cleaning.resolve).pipe(Effect.andThen(Effect.promise(() => release.promise))),
  );
  connect.mockReturnValue(
    Effect.succeed({ address: "test-light", write: () => Effect.void, close }),
  );
  const c = controller({ connectionIdleMs: 1 });
  await Effect.runPromise(c.send(command));
  await cleaning.promise;
  let finished = false;
  const shutdown = Effect.runPromise(c.close()).then(() => {
    finished = true;
  });
  await Promise.resolve();
  expect(finished).toBe(false);
  release.resolve();
  await shutdown;
  expect(close).toHaveBeenCalledTimes(1);
});

test("mesh layer releases its persistent writer when the provided program exits", async () => {
  const close = vi.fn(() => Effect.void);
  connect.mockReturnValue(
    Effect.succeed({ address: "test-light", write: () => Effect.void, close }),
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      const c = yield* LightController;
      yield* c.send(command);
    }).pipe(Effect.provide(makeNodeMeshLayer({ address: "test-light", statePath }))),
  );
  expect(close).toHaveBeenCalledTimes(1);
});

test("shutdown owns a connection returned at the cancellation boundary", async () => {
  const write = vi.fn(() => Effect.void);
  const close = vi.fn(() => Effect.void);
  const c = controller();
  let stopping: Promise<void> | undefined;
  connect.mockImplementation((_address, _options, onReady) =>
    Effect.sync(() => {
      const connection = { address: "test-light", write, close };
      onReady?.(connection);
      stopping = Effect.runPromise(c.close());
      return connection;
    }),
  );
  expect(Exit.isFailure(await Effect.runPromiseExit(c.send(command)))).toBe(true);
  await stopping;
  expect(write).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledTimes(1);
});
