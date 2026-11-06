// Send-side mesh controller. Builds Godox V2 payloads, wraps them in a
// proxy PDU via the access-frame encoder, writes it over a cached write-only
// Mesh Proxy connection, and persists the bumped sequence number.

import { Domain, LightController, TransportError, TransportUnsupportedError } from "@godox-tl/core";
import { Duration, Effect, Exit, Match, Runtime } from "effect";
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
import { loadMeshState, type MeshState, saveMeshState } from "./state.ts";

export interface MeshControllerOptions {
  /** BLE address (CoreBluetooth UUID on macOS, MAC on Linux). */
  readonly address: string;
  /** Path to the mesh state JSON. Read on construction; written after every successful send. */
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

const stateMutexes = new Map<string, ReturnType<typeof Effect.unsafeMakeSemaphore>>();

const mutexForStatePath = (statePath: string): ReturnType<typeof Effect.unsafeMakeSemaphore> => {
  let mutex = stateMutexes.get(statePath);
  if (!mutex) {
    mutex = Effect.unsafeMakeSemaphore(1);
    stateMutexes.set(statePath, mutex);
  }
  return mutex;
};

interface SendWaiter {
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

interface PendingSend {
  readonly cmd: Domain.LightCommand;
  readonly waiters: ReadonlyArray<SendWaiter>;
  readonly runtime: Runtime.Runtime<never>;
}

interface PendingWriterClose {
  readonly writer: ProxyWriterConnection;
  readonly result: Promise<Exit.Exit<void, BleError>>;
  settled: boolean;
}

const WRITER_CLOSE_ATTEMPT_TIMEOUT_MS = 3_000;

const transportError = (address: string, cause: unknown): TransportError =>
  new TransportError({
    cause,
    message: `mesh send to ${address} failed: ${(cause as { readonly message?: string })?.message ?? String(cause)}`,
  });

/** Direct controller — `.send(cmd)` writes through a warm write-only proxy
 * connection by default. Concurrent callers are serialized; while one command
 * is in-flight, later queued commands are collapsed to the newest value so
 * HomeKit slider drags don't force every intermediate value over BLE.
 */
export const makeMeshController = (options: MeshControllerOptions): LightController["Type"] => {
  const persistent = options.persistentConnection ?? true;
  const coalesce = options.coalesce ?? persistent;
  const idleMs = Math.max(0, options.connectionIdleMs ?? 30_000);
  const writeTimeoutMs = Math.max(1, options.writeTimeoutMs ?? 5_000);
  const findPeripheralTimeoutMs = Math.max(1, options.findPeripheralTimeoutMs ?? 20_000);
  const sendTimeoutMs = Math.max(
    1,
    options.sendTimeoutMs ?? findPeripheralTimeoutMs + writeTimeoutMs + 45_000,
  );
  const stateMutex = mutexForStatePath(options.statePath);

  let writer: ProxyWriterConnection | undefined;
  let idleTimer: NodeJS.Timeout | undefined;
  let inFlight: Promise<void> | undefined;
  let pending: ReadonlyArray<PendingSend> = [];
  let powerState: "unknown" | "on" | "off" = "unknown";
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

  const closeWriter = (): Effect.Effect<void> =>
    Effect.gen(function* () {
      clearIdleTimer();
      // A failed cleanup stays fenced until a later cleanup succeeds. Starting
      // another connection while its native disconnect is pending can close the
      // new link, because Noble can reuse the same peripheral object.
      const current = writer ?? (closing?.settled ? closing.writer : undefined);
      writer = undefined;
      powerState = "unknown";
      if (current) {
        const runtime = yield* Effect.runtime<never>();
        const attempt = Effect.suspend(() => current.close()).pipe(
          Effect.timeoutFail({
            duration: Duration.millis(WRITER_CLOSE_ATTEMPT_TIMEOUT_MS),
            onTimeout: () => new BleError({ message: "BLE writer cleanup timed out after 3000ms" }),
          }),
        );
        // Cleanup outlives an interrupted waiter, but the fence keeps every
        // replacement connection behind both bounded close attempts.
        const cleanup: PendingWriterClose = {
          writer: current,
          result: Runtime.runPromiseExit(runtime)(
            attempt.pipe(Effect.catchAllCause(() => attempt)),
          ),
          settled: false,
        };
        closing = cleanup;
        void cleanup.result.then((result) => {
          cleanup.settled = true;
          if (Exit.isSuccess(result) && closing === cleanup) closing = undefined;
        });
      }
      yield* awaitWriterClose().pipe(Effect.catchAllCause(() => Effect.void));
    });

  const scheduleIdleClose = (runtime: Runtime.Runtime<never>): void => {
    clearIdleTimer();
    const scheduledWriter = writer;
    const closeScheduledWriter = Effect.suspend(() =>
      writer === scheduledWriter ? closeWriter() : Effect.void,
    );
    if (!persistent || idleMs === 0) {
      void Runtime.runPromise(runtime)(closeScheduledWriter);
      return;
    }
    idleTimer = setTimeout(() => {
      void Runtime.runPromise(runtime)(closeScheduledWriter);
    }, idleMs);
    idleTimer.unref?.();
  };

  const writerForSend = (): Effect.Effect<ProxyWriterConnection, TransportError> => {
    if (closing) {
      return awaitWriterClose().pipe(
        Effect.mapError((error) => transportError(options.address, error)),
        Effect.zipRight(Effect.suspend(writerForSend)),
      );
    }
    if (writer && persistent) {
      if (writer.isConnected?.() === false) {
        return Effect.logDebug(`[mesh] discarding disconnected writer for ${options.address}`).pipe(
          Effect.zipRight(closeWriter()),
          Effect.zipRight(Effect.suspend(writerForSend)),
        );
      }
      return Effect.logDebug(`[mesh] reusing writer for ${options.address}`).pipe(
        Effect.as(writer),
      );
    }
    const startedAt = Date.now();
    return Effect.logDebug(`[mesh] opening writer for ${options.address}`).pipe(
      Effect.zipRight(
        connectProxyWriter(options.address, {
          fallbackAddresses: options.proxyAddresses,
          findPeripheralTimeoutMs,
        }),
      ),
      Effect.tap((conn) =>
        Effect.sync(() => {
          writer = conn;
          powerState = "unknown";
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
    sendNow(cmd).pipe(
      Effect.catchAll((error) => {
        if (!(error instanceof TransportError) || !(error.cause instanceof BleError)) {
          return Effect.fail(error);
        }
        return Effect.logDebug(
          `[mesh] retrying ${cmd._tag} on a fresh writer for ${options.address}`,
        ).pipe(Effect.zipRight(closeWriter()), Effect.zipRight(sendNow(cmd)));
      }),
      Effect.timeoutFail({
        duration: Duration.millis(sendTimeoutMs),
        onTimeout: () =>
          transportError(
            options.address,
            new Error(`${cmd._tag} send timed out after ${sendTimeoutMs}ms`),
          ),
      }),
      Effect.tapError(() => closeWriter()),
    );

  const writePdus = (
    conn: ProxyWriterConnection,
    proxyPdus: ReadonlyArray<Uint8Array>,
  ): Effect.Effect<void, TransportError> =>
    Effect.gen(function* () {
      const startedAt = Date.now();
      for (const proxyPdu of proxyPdus) {
        yield* Effect.logDebug(`[mesh] writing ${proxyPdu.byteLength} bytes to ${options.address}`);
        yield* conn.write(proxyPdu).pipe(
          Effect.mapError((e) => transportError(options.address, e)),
          Effect.timeoutFail({
            duration: Duration.millis(writeTimeoutMs),
            onTimeout: () =>
              transportError(
                options.address,
                new BleError({ message: `write timed out after ${writeTimeoutMs}ms` }),
              ),
          }),
        );
        yield* Effect.sleep("100 millis");
      }
      yield* Effect.logDebug(
        `[mesh] write complete for ${options.address} in ${Date.now() - startedAt}ms`,
      );
    }).pipe(Effect.catchAll((e) => closeWriter().pipe(Effect.flatMap(() => Effect.fail(e)))));

  const sendNow = (
    cmd: Domain.LightCommand,
  ): Effect.Effect<void, TransportError | TransportUnsupportedError> =>
    Effect.gen(function* () {
      const payload = yield* buildPayload(cmd);
      clearIdleTimer();
      // A new connection has unknown power state, so acquire it before deciding
      // whether settings need an explicit wake. Warm slider updates need no wake.
      const conn = options.dryRun ? undefined : yield* writerForSend();
      const payloads =
        cmd._tag === "Off"
          ? [payload, payload]
          : powerState === "on"
            ? [payload]
            : [encodeOn(), encodeOn(), payload];

      const proxyPdus = yield* Effect.gen(function* () {
        const state: MeshState = yield* loadMeshState(options.statePath).pipe(
          Effect.mapError(
            (e) =>
              new TransportError({
                cause: e,
                message: `loadMeshState(${options.statePath}) failed: ${e.message}`,
              }),
          ),
        );

        const pdus = payloads.map((godoxV2Payload, index) =>
          encodeGodoxFrame({
            netKey: state.networkKey,
            appKey: state.appKey,
            src: state.provisionerAddress,
            dst: state.nodeAddress,
            seq: state.sequenceNumber + index,
            ivIndex: state.ivIndex,
            vendorOpcode: VENDOR_OPCODE,
            godoxV2Payload,
          }),
        );

        const nextState: MeshState = {
          ...state,
          sequenceNumber: state.sequenceNumber + pdus.length,
        };
        yield* saveMeshState(options.statePath, nextState).pipe(
          Effect.mapError(
            (e) =>
              new TransportError({
                cause: e,
                message: `saveMeshState(${options.statePath}) failed: ${e.message}`,
              }),
          ),
        );

        if (options.dryRun) {
          for (const [index, pdu] of pdus.entries()) {
            yield* Effect.logInfo(
              `[mesh dry-run] addr=${options.address} seq=${state.sequenceNumber + index} pdu=${Array.from(
                pdu,
                (b) => b.toString(16).padStart(2, "0"),
              ).join("")}`,
            );
          }
        }
        return pdus;
      }).pipe(stateMutex.withPermits(1));

      if (conn) {
        yield* Effect.logDebug(`[mesh] sending ${cmd._tag} to ${options.address}`);
        yield* writePdus(conn, proxyPdus);
        const runtime = yield* Effect.runtime<never>();
        yield* Effect.sync(() => {
          powerState = cmd._tag === "Off" ? "off" : "on";
          // Closing an uncached writer resets power state, so update it first.
          scheduleIdleClose(runtime);
        });
        yield* Effect.logDebug(`[mesh] sent ${cmd._tag} to ${options.address}`);
      }
    });

  const settle = (waiters: ReadonlyArray<SendWaiter>, error?: unknown): void => {
    for (const waiter of waiters) {
      if (error) {
        waiter.reject(error);
      } else {
        waiter.resolve();
      }
    }
  };

  const runQueued = (
    cmd: Domain.LightCommand,
    waiters: ReadonlyArray<SendWaiter>,
    runtime: Runtime.Runtime<never>,
  ): void => {
    inFlight = Runtime.runPromise(runtime)(withSendTimeout(cmd))
      .then(() => settle(waiters))
      .catch((error: unknown) => settle(waiters, error))
      .then(() => {
        const [next, ...rest] = pending;
        pending = rest;
        if (next) {
          runQueued(next.cmd, next.waiters, next.runtime);
        } else {
          inFlight = undefined;
        }
      });
  };

  const enqueue = (cmd: Domain.LightCommand, runtime: Runtime.Runtime<never>): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const waiter = { resolve, reject };
      if (!inFlight) {
        runQueued(cmd, [waiter], runtime);
        return;
      }
      if (!coalesce) {
        pending = [...pending, { cmd, waiters: [waiter], runtime }];
        return;
      }
      const waiters = pending.flatMap((send) => send.waiters);
      // The newest command replaces the pending work, so its runtime owns the
      // actual send; callers whose commands were superseded still settle with it.
      pending = [{ cmd, waiters: [...waiters, waiter], runtime }];
    });

  return {
    send: (cmd) =>
      options.dryRun
        ? sendNow(cmd)
        : Effect.flatMap(Effect.runtime<never>(), (runtime) =>
            Effect.tryPromise({
              try: () => enqueue(cmd, runtime),
              catch: (cause) => cause as TransportError | TransportUnsupportedError,
            }),
          ),
  };
};
