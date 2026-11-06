import { Context, Deferred, Effect, Exit, Fiber, Queue, Scope } from "effect";

interface Request<Command, Error> {
  readonly command: Command;
  readonly services: Context.Context<never>;
  readonly completion: Deferred.Deferred<void, Error>;
}
interface Batch<Command, Error> {
  readonly requests: Set<Request<Command, Error>>;
}
interface Worker {
  readonly started: Deferred.Deferred<Fiber.Fiber<void>>;
}
interface Active<Command, Error> {
  readonly batch: Batch<Command, Error>;
  readonly selected: Request<Command, Error>;
  readonly started: Deferred.Deferred<Fiber.Fiber<void, Error>>;
}
export interface CommandQueue<Command, Error> {
  readonly send: (command: Command) => Effect.Effect<void, Error>;
  readonly close: Effect.Effect<void>;
}

/** Scoped serial mailbox. Queued requests coalesce to the latest surviving
 * caller; an active command keeps its selected value. Cancelling the last active
 * waiter interrupts that command and waits for finalizers before the next send.
 */
export const makeCommandQueue = <Command, Error>(options: {
  readonly coalesce: boolean;
  readonly closedError: () => Error;
  readonly execute: (command: Command) => Effect.Effect<void, Error>;
}): Effect.Effect<CommandQueue<Command, Error>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const mailbox = yield* Queue.unbounded<Batch<Command, Error>>();
    const closedDone = yield* Deferred.make<void>();
    const queued = new Set<Batch<Command, Error>>();
    let tail: Batch<Command, Error> | undefined;
    let active: Active<Command, Error> | undefined;
    let worker: Worker | undefined;
    let closed = false;

    const cancel = (batch: Batch<Command, Error>, request: Request<Command, Error>) =>
      Effect.gen(function* () {
        const current = yield* Effect.sync(() => {
          batch.requests.delete(request);
          if (batch.requests.size !== 0) return undefined;
          if (tail === batch) tail = undefined;
          return active?.batch === batch ? active : undefined;
        });
        if (current) yield* Fiber.interrupt(yield* Deferred.await(current.started));
      });

    const drain = (token: Worker): Effect.Effect<void> =>
      Effect.gen(function* () {
        while (true) {
          // Mask only ownership handoff, never native command execution. A
          // cancellation can join started even before forkChild returns.
          const step = yield* Effect.uninterruptible(
            Effect.gen(function* () {
              const entry = yield* Effect.sync(() => {
                while (!closed) {
                  const next = Queue.takeUnsafe(mailbox);
                  if (!next || Exit.isFailure(next)) break;
                  const batch = next.value;
                  queued.delete(batch);
                  if (tail === batch) tail = undefined;
                  const selected = [...batch.requests].at(-1);
                  if (!selected) continue;
                  const claimed: Active<Command, Error> = {
                    batch,
                    selected,
                    started: Deferred.makeUnsafe<Fiber.Fiber<void, Error>>(),
                  };
                  active = claimed;
                  return claimed;
                }
                // Poll and publish idleness atomically, preventing lost wakeups.
                if (worker === token) worker = undefined;
                return undefined;
              });
              if (!entry) return undefined;
              const command = Effect.suspend(() =>
                entry.batch.requests.size === 0
                  ? Effect.interrupt
                  : options.execute(entry.selected.command),
              ).pipe(Effect.provideContext(entry.selected.services), Effect.interruptible);
              const running = yield* Effect.forkChild(command, { startImmediately: true });
              yield* Deferred.succeed(entry.started, running);
              return { entry, running };
            }),
          );
          if (!step) return;
          const result = yield* Fiber.await(step.running);
          // Keep the active batch reachable until every completion has settled.
          for (const request of step.entry.batch.requests)
            yield* Deferred.done(request.completion, result);
          step.entry.batch.requests.clear();
          if (active === step.entry) active = undefined;
        }
      }).pipe(
        Effect.onExit((exit) =>
          Effect.gen(function* () {
            if (worker !== token) return;
            // Scope interruption can stop a worker during result settlement. Never
            // strand callers that live outside the scope being closed.
            if (active) {
              const result = Exit.isFailure(exit) ? exit : Exit.fail(options.closedError());
              for (const request of active.batch.requests)
                yield* Deferred.done(request.completion, result);
              active.batch.requests.clear();
              active = undefined;
            }
            worker = undefined;
          }),
        ),
      );

    const startWorker = Effect.gen(function* () {
      const started = yield* Deferred.make<Fiber.Fiber<void>>();
      const token: Worker = { started };
      const launch = yield* Effect.sync(() => {
        if (worker || closed) return false;
        worker = token;
        return true;
      });
      if (!launch) return;
      // Exit when idle rather than retaining a permanently suspended fiber
      // which would keep a command-line process alive under Effect 4.
      const running = yield* Effect.forkIn(drain(token), scope, { startImmediately: true });
      yield* Deferred.succeed(started, running);
    });

    const close = Effect.uninterruptible(
      Effect.gen(function* () {
        if (closed) return yield* Deferred.await(closedDone);
        closed = true;
        const current = worker;
        const failure = options.closedError();
        const batches = new Set(queued);
        if (active) batches.add(active.batch);
        queued.clear();
        tail = undefined;
        for (const batch of batches) {
          for (const request of batch.requests) yield* Deferred.fail(request.completion, failure);
          batch.requests.clear();
        }
        if (current) yield* Fiber.interrupt(yield* Deferred.await(current.started));
        yield* Queue.shutdown(mailbox);
      }).pipe(Effect.ensuring(Deferred.succeed(closedDone, undefined))),
    );
    yield* Effect.addFinalizer(() => close);

    return {
      close,
      send: (command) =>
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const request: Request<Command, Error> = {
              command,
              services: yield* Effect.context<never>(),
              completion: yield* Deferred.make<void, Error>(),
            };
            // Allocation can yield. Check closure and publish in one synchronous
            // section so shutdown cannot leave a request in a closed mailbox.
            const batch = yield* Effect.sync(() => {
              if (closed) return undefined;
              let selected = options.coalesce ? tail : undefined;
              if (!selected) {
                selected = { requests: new Set<Request<Command, Error>>() };
                if (!Queue.offerUnsafe(mailbox, selected)) return undefined;
                tail = selected;
                queued.add(selected);
              }
              selected.requests.add(request);
              return selected;
            });
            if (!batch) return yield* Effect.fail(options.closedError());
            yield* startWorker;
            return yield* restore(Deferred.await(request.completion)).pipe(
              Effect.onInterrupt(() => cancel(batch, request)),
            );
          }),
        ),
    };
  });
