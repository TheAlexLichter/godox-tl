// Send-side mesh controller. Builds Godox V2 payloads, wraps them in a
// proxy PDU via the access-frame encoder, writes it over a cached write-only
// Mesh Proxy connection, and persists the bumped sequence number.

import { Domain, LightController, TransportError, TransportUnsupportedError } from "@godox-tl/core";
import { Effect, Match } from "effect";
import { connectProxyWriter } from "./ble/proxy.ts";
import type { ProxyWriterConnection } from "./ble/types.ts";
import {
  encodeFx,
  encodeHsi,
  encodeOff,
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
}

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
  const stateMutex = mutexForStatePath(options.statePath);

  let writer: ProxyWriterConnection | undefined;
  let idleTimer: NodeJS.Timeout | undefined;
  let inFlight: Promise<void> | undefined;
  let pending: ReadonlyArray<PendingSend> = [];

  const clearIdleTimer = (): void => {
    if (!idleTimer) return;
    clearTimeout(idleTimer);
    idleTimer = undefined;
  };

  const closeWriter = (): Promise<void> => {
    clearIdleTimer();
    const current = writer;
    writer = undefined;
    if (!current) return Promise.resolve();
    return Effect.runPromise(current.close()).catch(() => undefined);
  };

  const scheduleIdleClose = (): void => {
    clearIdleTimer();
    if (!persistent || idleMs === 0) {
      void closeWriter();
      return;
    }
    idleTimer = setTimeout(() => {
      void closeWriter();
    }, idleMs);
    idleTimer.unref?.();
  };

  const writerForSend = (): Effect.Effect<ProxyWriterConnection, TransportError> => {
    if (writer && persistent) return Effect.succeed(writer);
    return connectProxyWriter(options.address).pipe(
      Effect.tap((conn) =>
        Effect.sync(() => {
          writer = conn;
        }),
      ),
      Effect.mapError((e) => transportError(options.address, e)),
    );
  };

  const writePdu = (proxyPdu: Uint8Array): Effect.Effect<void, TransportError> =>
    Effect.gen(function* () {
      clearIdleTimer();
      const conn = yield* writerForSend();
      yield* conn.write(proxyPdu).pipe(Effect.mapError((e) => transportError(options.address, e)));
      yield* Effect.sleep("100 millis");
      yield* Effect.sync(scheduleIdleClose);
    }).pipe(
      Effect.catchAll((e) =>
        Effect.promise(closeWriter).pipe(Effect.flatMap(() => Effect.fail(e))),
      ),
    );

  const sendNow = (
    cmd: Domain.LightCommand,
  ): Effect.Effect<void, TransportError | TransportUnsupportedError> =>
    Effect.gen(function* () {
      const payload = yield* buildPayload(cmd);

      const proxyPdu = yield* Effect.gen(function* () {
        const state: MeshState = yield* loadMeshState(options.statePath).pipe(
          Effect.mapError(
            (e) =>
              new TransportError({
                cause: e,
                message: `loadMeshState(${options.statePath}) failed: ${e.message}`,
              }),
          ),
        );

        const pdu = encodeGodoxFrame({
          netKey: state.networkKey,
          appKey: state.appKey,
          src: state.provisionerAddress,
          dst: state.nodeAddress,
          seq: state.sequenceNumber,
          ivIndex: state.ivIndex,
          vendorOpcode: VENDOR_OPCODE,
          godoxV2Payload: payload,
        });

        const nextState: MeshState = {
          ...state,
          sequenceNumber: state.sequenceNumber + 1,
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
          yield* Effect.logInfo(
            `[mesh dry-run] addr=${options.address} seq=${state.sequenceNumber} pdu=${Array.from(
              pdu,
              (b) => b.toString(16).padStart(2, "0"),
            ).join("")}`,
          );
        }
        return pdu;
      }).pipe(stateMutex.withPermits(1));

      if (!options.dryRun) {
        yield* writePdu(proxyPdu);
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

  const runQueued = (cmd: Domain.LightCommand, waiters: ReadonlyArray<SendWaiter>): void => {
    inFlight = Effect.runPromise(sendNow(cmd))
      .then(() => settle(waiters))
      .catch((error: unknown) => settle(waiters, error))
      .then(() => {
        const [next, ...rest] = pending;
        pending = rest;
        if (next) {
          runQueued(next.cmd, next.waiters);
        } else {
          inFlight = undefined;
        }
      });
  };

  const enqueue = (cmd: Domain.LightCommand): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const waiter = { resolve, reject };
      if (!inFlight) {
        runQueued(cmd, [waiter]);
        return;
      }
      if (!coalesce) {
        pending = [...pending, { cmd, waiters: [waiter] }];
        return;
      }
      const waiters = pending.flatMap((send) => send.waiters);
      pending = [{ cmd, waiters: [...waiters, waiter] }];
    });

  return {
    send: (cmd) =>
      options.dryRun
        ? sendNow(cmd)
        : Effect.tryPromise({
            try: () => enqueue(cmd),
            catch: (cause) => cause as TransportError | TransportUnsupportedError,
          }),
  };
};
