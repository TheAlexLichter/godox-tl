import { Context, Deferred, Effect, Exit, Fiber, Scope } from "effect";
import { expect, test } from "vite-plus/test";
import { makeCommandQueue, type CommandQueue } from "../src/commandQueue.ts";

const closedError = () => new Error("controller closed");
const fork = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.forkChild(effect, { startImmediately: true });

const bufferedTest = (coalesce: boolean, cancelLatest: boolean) =>
  Effect.scoped(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<void>();
      const calls: number[] = [];
      const queue = yield* makeCommandQueue({
        coalesce,
        closedError,
        execute: (value: number) =>
          Effect.gen(function* () {
            calls.push(value);
            if (value === 1) {
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(gate);
            }
          }),
      });
      const first = yield* fork(queue.send(1));
      yield* Deferred.await(started);
      const second = yield* fork(queue.send(2));
      const third = yield* fork(queue.send(3));
      yield* Fiber.interrupt(cancelLatest ? third : second);
      yield* Deferred.succeed(gate, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(cancelLatest ? second : third);
      expect(calls).toEqual([1, cancelLatest ? 2 : 3]);
    }),
  );

test("a cancelled FIFO request is removed without skipping its successor", () =>
  Effect.runPromise(bufferedTest(false, false)));
test("cancelling a superseded coalesced caller keeps the latest request", () =>
  Effect.runPromise(bufferedTest(true, false)));
test("cancelling the latest coalesced caller restores the latest surviving request", () =>
  Effect.runPromise(bufferedTest(true, true)));

test("cancelling the only active caller waits for cleanup before its successor runs", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const cleanupStarted = yield* Deferred.make<void>();
        const cleanupDone = yield* Deferred.make<void>();
        const calls: number[] = [];
        const queue = yield* makeCommandQueue({
          coalesce: false,
          closedError,
          execute: (value: number) =>
            Effect.gen(function* () {
              calls.push(value);
              if (value === 1) {
                yield* Deferred.succeed(started, undefined);
                yield* Effect.never.pipe(
                  Effect.ensuring(
                    Deferred.succeed(cleanupStarted, undefined).pipe(
                      Effect.andThen(Deferred.await(cleanupDone)),
                    ),
                  ),
                );
              }
            }),
        });
        const first = yield* fork(queue.send(1));
        yield* Deferred.await(started);
        const second = yield* fork(queue.send(2));
        const cancelling = yield* fork(Fiber.interrupt(first));
        yield* Deferred.await(cleanupStarted);
        expect(calls).toEqual([1]);
        yield* Deferred.succeed(cleanupDone, undefined);
        yield* Fiber.join(cancelling);
        yield* Fiber.join(second);
        expect(calls).toEqual([1, 2]);
      }),
    ),
  ));

test("closing rejects pending and future requests and joins the same active cleanup", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const cleanupStarted = yield* Deferred.make<void>();
        const cleanupDone = yield* Deferred.make<void>();
        let cleanups = 0;
        const calls: number[] = [];
        const queue = yield* makeCommandQueue({
          coalesce: false,
          closedError,
          execute: (value: number) =>
            Effect.gen(function* () {
              calls.push(value);
              yield* Deferred.succeed(started, undefined);
              yield* Effect.never.pipe(
                Effect.ensuring(
                  Effect.gen(function* () {
                    cleanups++;
                    yield* Deferred.succeed(cleanupStarted, undefined);
                    yield* Deferred.await(cleanupDone);
                  }),
                ),
              );
            }),
        });
        const first = yield* fork(queue.send(1));
        yield* Deferred.await(started);
        const second = yield* fork(queue.send(2));
        const closing = yield* fork(queue.close);
        yield* Deferred.await(cleanupStarted);
        const again = yield* fork(queue.close);
        expect(Exit.isFailure(yield* Effect.exit(queue.send(3)))).toBe(true);
        expect(Exit.isFailure(yield* Fiber.await(second))).toBe(true);
        expect(Exit.isFailure(yield* Fiber.await(first))).toBe(true);
        expect(closing.pollUnsafe()).toBeUndefined();
        expect(again.pollUnsafe()).toBeUndefined();
        yield* Deferred.succeed(cleanupDone, undefined);
        yield* Fiber.join(closing);
        yield* Fiber.join(again);
        expect(calls).toEqual([1]);
        expect(cleanups).toBe(1);
      }),
    ),
  ));

const Caller = Context.Reference<string>("command-queue-test-caller", {
  defaultValue: () => "default",
});
test("a surviving coalesced request retains its own caller context", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>();
        const started = yield* Deferred.make<void>();
        const seen: string[] = [];
        const queue = yield* makeCommandQueue({
          coalesce: true,
          closedError,
          execute: (value: number) =>
            Effect.gen(function* () {
              seen.push(yield* Caller);
              if (value === 1) {
                yield* Deferred.succeed(started, undefined);
                yield* Deferred.await(gate);
              }
            }),
        });
        const first = yield* fork(queue.send(1).pipe(Effect.provideService(Caller, "first")));
        yield* Deferred.await(started);
        const second = yield* fork(queue.send(2).pipe(Effect.provideService(Caller, "second")));
        const third = yield* fork(queue.send(3).pipe(Effect.provideService(Caller, "third")));
        yield* Fiber.interrupt(third);
        yield* Deferred.succeed(gate, undefined);
        yield* Fiber.join(first);
        yield* Fiber.join(second);
        expect(seen).toEqual(["first", "second"]);
      }),
    ),
  ));

test("a typed command failure settles its callers and the queue keeps working", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const calls: number[] = [];
        const queue = yield* makeCommandQueue({
          coalesce: false,
          closedError,
          execute: (value: number) =>
            Effect.gen(function* () {
              calls.push(value);
              if (value === 1) return yield* Effect.fail(new Error("failed"));
            }),
        });
        expect(Exit.isFailure(yield* Effect.exit(queue.send(1)))).toBe(true);
        yield* queue.send(2);
        expect(calls).toEqual([1, 2]);
      }),
    ),
  ));

test("synchronous completions and repeated worker restarts never lose a request", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const calls: number[] = [];
        const queue = yield* makeCommandQueue({
          coalesce: false,
          closedError,
          execute: (value: number) =>
            Effect.sync(() => {
              calls.push(value);
            }),
        });
        for (let value = 0; value < 100; value++) yield* queue.send(value);
        expect(calls).toEqual(Array.from({ length: 100 }, (_, index) => index));
      }),
    ),
  ));

test("a synchronous command-construction defect settles its caller and keeps the queue usable", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const calls: number[] = [];
        const queue = yield* makeCommandQueue({
          coalesce: false,
          closedError,
          execute: (value: number) => {
            if (value === 1) throw new Error("construction failed");
            return Effect.sync(() => {
              calls.push(value);
            });
          },
        });
        expect(Exit.isFailure(yield* Effect.exit(queue.send(1)))).toBe(true);
        yield* queue.send(2);
        expect(calls).toEqual([2]);
      }),
    ),
  ));

test("close during immediate worker startup still waits for active finalizers", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const cleanupStarted = yield* Deferred.make<void>();
        const releaseCleanup = yield* Deferred.make<void>();
        let closing: Fiber.Fiber<void> | undefined;
        let queue: CommandQueue<number, Error>;
        queue = yield* makeCommandQueue({
          coalesce: false,
          closedError,
          execute: (_value: number) => {
            // This executes before forkIn returns its worker handle to admission.
            closing = Effect.runFork(queue.close);
            return Effect.never.pipe(
              Effect.ensuring(
                Deferred.succeed(cleanupStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseCleanup)),
                ),
              ),
            );
          },
        });
        const sending = yield* fork(queue.send(1));
        yield* Deferred.await(cleanupStarted);
        expect(closing).toBeDefined();
        expect(closing?.pollUnsafe()).toBeUndefined();
        yield* Deferred.succeed(releaseCleanup, undefined);
        if (!closing) throw new Error("close was not launched");
        yield* Fiber.join(closing);
        expect(Exit.isFailure(yield* Fiber.await(sending))).toBe(true);
      }),
    ),
  ));

test("shutdown during coalesced settlement leaves no caller unresolved", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>();
        const started = yield* Deferred.make<void>();
        const queue = yield* makeCommandQueue({
          coalesce: true,
          closedError,
          execute: (value: number) =>
            value === 0
              ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(gate)))
              : Effect.void,
        });
        const first = yield* fork(queue.send(0));
        yield* Deferred.await(started);
        const waiting: Fiber.Fiber<void, Error>[] = [];
        for (let value = 1; value <= 250; value++) {
          waiting.push(
            yield* fork(
              queue.send(value).pipe(Effect.tap(() => (value === 1 ? queue.close : Effect.void))),
            ),
          );
        }
        yield* Deferred.succeed(gate, undefined);
        yield* Fiber.await(first);
        const results = yield* Effect.all(waiting.map(Fiber.await));
        expect(results).toHaveLength(250);
        yield* queue.close;
      }),
    ).pipe(Effect.timeout("2 seconds")),
  ));

test("closing the owning scope settles callers waiting outside that scope", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const owner = yield* Scope.make();
        const started = yield* Deferred.make<void>();
        const queue = yield* makeCommandQueue({
          coalesce: true,
          closedError,
          execute: (_value: number) =>
            Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
        }).pipe(Scope.provide(owner));
        const first = yield* fork(queue.send(1));
        yield* Deferred.await(started);
        const second = yield* fork(queue.send(2));
        yield* Scope.close(owner, Exit.void);
        expect(Exit.isFailure(yield* Fiber.await(first))).toBe(true);
        expect(Exit.isFailure(yield* Fiber.await(second))).toBe(true);
      }),
    ).pipe(Effect.timeout("2 seconds")),
  ));
