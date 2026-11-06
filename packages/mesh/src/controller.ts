// Send-side mesh controller. Builds Godox V2 payloads, wraps them in a
// proxy PDU via the access-frame encoder, writes it over a cached write-only
// Mesh Proxy connection, and persists the bumped sequence number.

import { randomUUID } from "node:crypto";
import { Domain, LightController, TransportError, TransportUnsupportedError } from "@godox-tl/core";
import { Duration, Effect, Exit, FiberSet, Match, Scope, type Context } from "effect";
import { connectProxyWriter } from "./ble/proxy.ts";
import { BleError } from "./ble/errors.ts";
import type { ProxyWriterConnection } from "./ble/types.ts";
import {
  encodeFx,
  encodeHsi,
  encodeOff,
  encodeOn,
  encodeRgbw,
  encodeSet,
  VENDOR_OPCODE,
} from "./godox/protocol.ts";
import { encodeGodoxFrame } from "./pdu/accessFrame.ts";
import { commandPhase } from "./diagnostics.ts";
import { loadMeshState } from "./state.ts";
import { withMeshSequenceReservation, type SequenceOptions } from "./sequences.ts";
import { makeCommandQueue } from "./commandQueue.ts";

type LightControllerService = LightController["Service"];

export interface MeshController extends LightControllerService {
  /** Stop accepting commands and wait for bounded BLE cleanup. Idempotent. */
  readonly close: () => Effect.Effect<void>;
}

export interface MeshControllerOptions extends SequenceOptions {
  /** BLE address (CoreBluetooth UUID on macOS, MAC on Linux). */
  readonly address: string;
  /** Path to the mesh state JSON. Read per command; counter hints are persisted before sending. */
  readonly statePath: string;
  /** When true, encode the frame but don't open a BLE connection. */
  readonly dryRun?: boolean;
  /** Keep the Mesh Proxy GATT connection open between sends. Defaults to true. */
  readonly persistentConnection?: boolean;
  /** Idle time before a cached proxy connection is closed. Defaults to 30s. */
  readonly connectionIdleMs?: number;
  /** Timeout for a single GATT write. Defaults to 5s. */
  readonly writeTimeoutMs?: number;
  /** Timeout for the BLE scan that finds the target peripheral. Defaults to 20s. */
  readonly findPeripheralTimeoutMs?: number;
  /** Same-mesh BLE proxy addresses that can be used when the target peripheral is not visible. */
  readonly proxyAddresses?: ReadonlyArray<string>;
  /** Deadline shared by send attempts, including connection and writes. Failure cleanup may take up to 6s more. */
  readonly sendTimeoutMs?: number;
  /** Collapse queued in-flight sends to the newest command. Defaults to true for persistent connections. */
  readonly coalesce?: boolean;
}

const buildPayload = (
  cmd: Domain.LightCommand,
): Effect.Effect<Uint8Array, TransportUnsupportedError> =>
  Match.value(cmd).pipe(
    Match.tagsExhaustive({
      Off: () => Effect.succeed(encodeOff()),
      Cct: (c) => Effect.succeed(encodeSet(Math.round(c.brightness), Math.round(c.temperature))),
      Hsi: (c) =>
        Effect.succeed(
          encodeHsi(Math.round(c.brightness), Math.round(c.hue), Math.round(c.saturation)),
        ),
      Rgbw: (c) =>
        Effect.succeed(
          encodeRgbw(
            Math.round(c.brightness),
            Math.round(c.red),
            Math.round(c.green),
            Math.round(c.blue),
            Math.round(c.white),
          ),
        ),
      Fx: (c) =>
        Effect.succeed(
          encodeFx(
            Math.round(c.brightness),
            Math.round(c.effect),
            Math.round(c.subtype),
            Math.round(c.filter),
          ),
        ),
    }),
  );

interface PendingWriterClose {
  readonly writer: ProxyWriterConnection;
  readonly result: Promise<Exit.Exit<void, BleError>>;
  settled: boolean;
}
const WRITER_CLOSE_ATTEMPT_TIMEOUT_MS = 3_000;
const transportError = (address: string, cause: unknown): TransportError =>
  new TransportError({
    cause,
    message: `mesh send to ${address} failed: ${
      (
        cause as {
          readonly message?: string;
        }
      )?.message ?? String(cause)
    }`,
  });

/** Direct controller — `.send(cmd)` writes through a warm write-only proxy
 * connection by default. Concurrent callers are serialized; while one command
 * is in-flight, later queued commands are collapsed to the newest value so
 * HomeKit slider drags don't force every intermediate value over BLE.
 */
export const makeMeshController = (options: MeshControllerOptions): MeshController => {
  const persistent = options.persistentConnection ?? true;
  const coalesce = !options.dryRun && (options.coalesce ?? persistent);
  const idleMs = Math.max(0, options.connectionIdleMs ?? 30_000);
  const writeTimeoutMs = Math.max(1, options.writeTimeoutMs ?? 5_000);
  const findPeripheralTimeoutMs = Math.max(1, options.findPeripheralTimeoutMs ?? 20_000);
  const sendTimeoutMs = Math.max(
    1,
    options.sendTimeoutMs ?? findPeripheralTimeoutMs + writeTimeoutMs + 45_000,
  );

  const sendScope = Scope.makeUnsafe();
  const cleanupScope = Scope.makeUnsafe();
  const sends = Effect.runSync(FiberSet.make<void, unknown>().pipe(Scope.provide(sendScope)));
  const cleanups = Effect.runSync(
    FiberSet.make<Exit.Exit<void, BleError>>().pipe(Scope.provide(cleanupScope)),
  );
  const runManaged = <A, E>(
    set: FiberSet.FiberSet<A, E>,
    services: Context.Context<never>,
    effect: Effect.Effect<A, E>,
  ): Promise<A> => Effect.runSyncWith(services)(FiberSet.runtimePromise(set)<never>())(effect);
  let closed = false;
  let closeResult: Promise<void> | undefined;
  const closedError = () => transportError(options.address, new Error("Mesh controller is closed"));

  let writer: ProxyWriterConnection | undefined;
  let idleTimer: NodeJS.Timeout | undefined;
  let powerState: "unknown" | "on" | "off" = "unknown";
  let powerConfidenceSource: string | undefined;
  let powerConfidenceNextSequence: number | undefined;
  let closing: PendingWriterClose | undefined;

  const clearIdleTimer = (): void => {
    if (!idleTimer) return;
    clearTimeout(idleTimer);
    idleTimer = undefined;
  };

  const awaitWriterClose = (): Effect.Effect<void, BleError> =>
    Effect.suspend(() => {
      const current = closing;
      if (!current) return Effect.void;
      return Effect.promise(() => current.result).pipe(
        Effect.flatMap((result) =>
          Exit.isSuccess(result)
            ? Effect.void
            : Effect.fail(
                new BleError({
                  message:
                    "Previous BLE writer could not be closed; replacement connection blocked",
                  cause: result.cause,
                }),
              ),
        ),
      );
    });

  const closeWriter = (retryFailed = false): Effect.Effect<void> =>
    Effect.gen(function* () {
      clearIdleTimer();
      // A failed cleanup stays fenced until a later cleanup succeeds. Starting
      // another connection while its native disconnect is pending can close the
      // new link, because Noble can reuse the same peripheral object.
      const current = writer ?? (retryFailed && closing?.settled ? closing.writer : undefined);
      writer = undefined;
      powerState = "unknown";
      powerConfidenceSource = undefined;
      powerConfidenceNextSequence = undefined;
      if (current) {
        const services = yield* Effect.context<never>();
        const attempt = Effect.suspend(() => current.close()).pipe(
          Effect.timeoutOrElse({
            duration: Duration.millis(WRITER_CLOSE_ATTEMPT_TIMEOUT_MS),
            orElse: () =>
              Effect.fail(new BleError({ message: "BLE writer cleanup timed out after 3000ms" })),
          }),
        );
        // Cleanup outlives an interrupted waiter, but the fence keeps every
        // replacement connection behind both bounded close attempts.
        const cleanup: PendingWriterClose = {
          writer: current,
          result: runManaged(
            cleanups,
            services,
            Effect.exit(
              commandPhase(
                "cleanup",
                attempt.pipe(
                  Effect.catchCause(() => attempt),
                  Effect.interruptible,
                ),
              ),
            ),
          ),
          settled: false,
        };
        closing = cleanup;
        void cleanup.result.then((result) => {
          cleanup.settled = true;
          if (Exit.isSuccess(result) && closing === cleanup) closing = undefined;
        });
      }
      yield* awaitWriterClose().pipe(Effect.catchCause(() => Effect.void));
    });
  const scheduleIdleClose = (services: Context.Context<never>): void => {
    clearIdleTimer();
    if (closed) return;
    const scheduledWriter = writer;
    const closeScheduledWriter = Effect.suspend(() =>
      !closed && writer === scheduledWriter ? closeWriter() : Effect.void,
    );
    if (!persistent || idleMs === 0) {
      void runManaged(sends, services, closeScheduledWriter).catch(() => {});
      return;
    }
    idleTimer = setTimeout(() => {
      void runManaged(sends, services, closeScheduledWriter).catch(() => {});
    }, idleMs);
    idleTimer.unref?.();
  };

  const writerForSend = (): Effect.Effect<ProxyWriterConnection, TransportError> => {
    if (closed) return Effect.fail(closedError());
    if (closing) {
      return awaitWriterClose().pipe(
        Effect.mapError((error) => transportError(options.address, error)),
        Effect.andThen(Effect.suspend(writerForSend)),
      );
    }
    if (writer && persistent) {
      if (writer.isConnected?.() === false) {
        return Effect.logDebug(`[mesh] discarding disconnected writer for ${options.address}`).pipe(
          Effect.andThen(closeWriter()),
          Effect.andThen(Effect.suspend(writerForSend)),
        );
      }
      return Effect.logDebug(`[mesh] reusing writer for ${options.address}`).pipe(
        Effect.as(writer),
      );
    }
    const startedAt = Date.now();
    const ownWriter = (conn: ProxyWriterConnection): void => {
      writer = conn;
      powerState = "unknown";
      powerConfidenceSource = undefined;
      powerConfidenceNextSequence = undefined;
    };
    return Effect.logDebug(`[mesh] opening writer for ${options.address}`).pipe(
      Effect.andThen(
        commandPhase(
          "connect",
          connectProxyWriter(
            options.address,
            {
              fallbackAddresses: options.proxyAddresses,
              findPeripheralTimeoutMs,
            },
            ownWriter,
          ),
        ),
      ),
      // Keep compatibility with injected connectors that only return a handle.
      Effect.tap((conn) =>
        Effect.sync(() => {
          if (writer !== conn) ownWriter(conn);
        }),
      ),
      Effect.tap(() =>
        Effect.logDebug(
          `[mesh] writer ready for ${options.address} in ${Date.now() - startedAt}ms`,
        ),
      ),
      Effect.mapError((e) => transportError(options.address, e)),
    );
  };

  const withSendTimeout = (
    cmd: Domain.LightCommand,
  ): Effect.Effect<void, TransportError | TransportUnsupportedError> =>
    Effect.suspend(() => {
      // Only a new queued command can retry a previously failed cleanup. Error
      // handlers for this command join it, keeping cleanup grace bounded to 6s.
      let attempt = 1;
      const recoverPreviousClose = closing?.settled ? closeWriter(true) : Effect.void;
      return recoverPreviousClose.pipe(
        Effect.andThen(
          commandPhase("send", sendNow(cmd), { "mesh.attempt": 1 }).pipe(
            Effect.catch((error) => {
              if (!(error instanceof TransportError) || !(error.cause instanceof BleError)) {
                return Effect.fail(error);
              }
              attempt = 2;
              return commandPhase(
                "retry",
                Effect.logDebug(
                  `[mesh] retrying ${cmd._tag} on a fresh writer for ${options.address}`,
                ).pipe(Effect.andThen(closeWriter()), Effect.andThen(sendNow(cmd))),
                { "mesh.attempt": attempt },
              );
            }),
          ),
        ),
        Effect.timeoutOrElse({
          duration: Duration.millis(sendTimeoutMs),
          orElse: () =>
            Effect.fail(
              transportError(
                options.address,
                new Error(`${cmd._tag} send timed out after ${sendTimeoutMs}ms`),
              ),
            ),
        }),
        Effect.tapError(() => closeWriter().pipe(Effect.annotateLogs("mesh.attempt", attempt))),
        // A cancelled active command may be waiting for the source lock after
        // opening a writer; no lease callback exists yet to close that writer.
        Effect.onInterrupt(() => closeWriter().pipe(Effect.annotateLogs("mesh.attempt", attempt))),
      );
    });

  const writePdus = (
    conn: ProxyWriterConnection,
    proxyPdus: ReadonlyArray<Uint8Array>,
  ): Effect.Effect<void, TransportError> =>
    commandPhase(
      "write",
      Effect.gen(function* () {
        const startedAt = Date.now();
        for (const proxyPdu of proxyPdus) {
          if (closed) return yield* Effect.fail(closedError());
          yield* Effect.logDebug(
            `[mesh] writing ${proxyPdu.byteLength} bytes to ${options.address}`,
          );
          yield* conn.write(proxyPdu).pipe(
            Effect.mapError((e) => transportError(options.address, e)),
            Effect.timeoutOrElse({
              duration: Duration.millis(writeTimeoutMs),
              orElse: () =>
                Effect.fail(
                  transportError(
                    options.address,
                    new BleError({ message: `write timed out after ${writeTimeoutMs}ms` }),
                  ),
                ),
            }),
          );
          yield* Effect.sleep("100 millis");
        }
        yield* Effect.logDebug(
          `[mesh] write complete for ${options.address} in ${Date.now() - startedAt}ms`,
        );
      }),
    );

  const sendNow = (
    cmd: Domain.LightCommand,
  ): Effect.Effect<void, TransportError | TransportUnsupportedError> =>
    Effect.gen(function* () {
      const payload = yield* buildPayload(cmd);
      clearIdleTimer();
      // A new connection has unknown power state, so acquire it before deciding
      // whether settings need an explicit wake.
      const conn = options.dryRun ? undefined : yield* writerForSend();
      const state = yield* loadMeshState(options.statePath).pipe(
        Effect.mapError((cause) => transportError(options.address, cause)),
      );
      const source = `${Buffer.from(state.networkKey).toString("hex")}:${state.provisionerAddress}:${state.ivIndex}:${state.nodeAddress}`;
      let payloads: ReadonlyArray<Uint8Array> = [];
      yield* withMeshSequenceReservation(
        state,
        (nextSequenceNumber) => {
          // The shared source lease serializes this check with every cooperating
          // controller. Any intervening reservation invalidates our warm-state
          // assumption, including an Off sent by another process or controller.
          const warm =
            powerState === "on" &&
            powerConfidenceSource === source &&
            powerConfidenceNextSequence === nextSequenceNumber;
          payloads =
            cmd._tag === "Off"
              ? [payload, payload]
              : warm
                ? [payload]
                : [encodeOn(), encodeOn(), payload];
          return payloads.length;
        },
        options,
        (reservation) =>
          Effect.gen(function* () {
            const proxyPdus = payloads.map((godoxV2Payload, index) =>
              encodeGodoxFrame({
                netKey: state.networkKey,
                appKey: state.appKey,
                src: state.provisionerAddress,
                dst: state.nodeAddress,
                seq: reservation.sequenceNumber + index,
                ivIndex: state.ivIndex,
                vendorOpcode: VENDOR_OPCODE,
                godoxV2Payload,
              }),
            );
            if (options.dryRun) {
              for (const [index, pdu] of proxyPdus.entries())
                yield* Effect.logInfo(
                  `[mesh dry-run] addr=${options.address} seq=${reservation.sequenceNumber + index} pdu=${Array.from(pdu, (b) => b.toString(16).padStart(2, "0")).join("")}`,
                );
            } else if (conn) {
              yield* Effect.logDebug(`[mesh] sending ${cmd._tag} to ${options.address}`);
              yield* writePdus(conn, proxyPdus);
              const services = yield* Effect.context<never>();
              yield* Effect.sync(() => {
                powerState = cmd._tag === "Off" ? "off" : "on";
                powerConfidenceSource = source;
                powerConfidenceNextSequence = reservation.nextSequenceNumber;
                // Closing an uncached writer resets power state, so update it first.
                scheduleIdleClose(services);
              });
              yield* Effect.logDebug(`[mesh] sent ${cmd._tag} to ${options.address}`);
            }
          }).pipe(
            // Keep the shared source lease until disconnect cleanup finishes,
            // including when the overall send deadline interrupts a write.
            Effect.onExit((exit) => (Exit.isFailure(exit) ? closeWriter() : Effect.void)),
          ),
      ).pipe(
        Effect.mapError((cause) =>
          cause instanceof TransportError || cause instanceof TransportUnsupportedError
            ? cause
            : transportError(options.address, cause),
        ),
      );
    });

  const mailbox = Effect.runSync(
    makeCommandQueue<Domain.LightCommand, TransportError | TransportUnsupportedError>({
      coalesce,
      closedError,
      execute: withSendTimeout,
    }).pipe(Scope.provide(sendScope)),
  );

  const send = Effect.fn("mesh.command")(function* (cmd: Domain.LightCommand) {
    const metadata = {
      "mesh.commandId": randomUUID(),
      "mesh.address": options.address,
      "mesh.mode": cmd._tag,
    };
    yield* Effect.annotateCurrentSpan(metadata);
    return yield* Effect.gen(function* () {
      if (closed) return yield* Effect.fail(closedError());
      yield* Effect.logDebug("[mesh] command queued").pipe(
        Effect.annotateLogs("mesh.phase", "queue"),
        Effect.withSpan("mesh.queue"),
      );
      // The mailbox captures these annotations along with the executing
      // caller's logger and tracing context for queued work and idle cleanup.
      return yield* mailbox.send(cmd);
    }).pipe(Effect.annotateLogs(metadata));
  });

  return {
    send,
    close: () =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const services = yield* Effect.context<never>();
          const result = yield* Effect.sync(() => {
            if (!closeResult) {
              closed = true;
              clearIdleTimer();
              // Publish once before starting cleanup, including synchronous
              // disconnect callbacks that re-enter close.
              closeResult = Promise.resolve().then(() =>
                Effect.runPromiseWith(services)(
                  Effect.gen(function* () {
                    yield* mailbox.close;
                    yield* Scope.close(sendScope, Exit.void);
                    yield* closeWriter();
                    yield* Scope.close(cleanupScope, Exit.void);
                  }),
                ),
              );
            }
            return closeResult;
          });
          yield* Effect.promise(() => result);
        }),
      ),
  };
};

/** Scoped variant; releasing the scope stops commands and closes the BLE writer. */
export const makeMeshControllerScoped = (
  options: MeshControllerOptions,
): Effect.Effect<MeshController, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => makeMeshController(options)),
    (controller) => controller.close(),
  );
