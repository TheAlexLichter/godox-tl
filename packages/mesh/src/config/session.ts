// Post-provisioning ConfigSession.
//
// After a fresh provisioning handshake the node has a NetKey + DeviceKey but
// no AppKey bound to its vendor model. Until we send these two messages,
// the light ignores Godox V2 brightness/CCT commands. The sequence is:
//
//   1. Config AppKey Add  (opcode 0x00)    → install the AppKey on the node.
//      Wait for Config AppKey Status        ← status==0x00 means Success.
//   2. Config Model App Bind (opcode 0x803D) → bind that AppKey to the
//      Telink vendor model 0x0211/0x0000.
//      Wait for Config Model App Status     ← status==0x00 means Success.
//
// Both messages are DeviceKey-secured at the upper transport layer
// (AKF=0, AID=0). The proxy connection is opened once for the session and
// closed by the surrounding Scope on exit.

import { Effect, Scope } from "effect";
import { connectProxy } from "../ble/proxy.ts";
import type { BleError } from "../ble/errors.ts";
import type { ProxyConnection } from "../ble/types.ts";
import { encodeDeviceKeyFrame } from "../pdu/accessFrame.ts";
import { ConfigError, type ConfigStage } from "./errors.ts";
import {
  buildAppKeyAdd,
  buildModelAppBind,
  encodeOpcode,
  GODOX_VENDOR_MODEL,
  type ModelIdentifier,
  OPCODE_CONFIG_APP_KEY_ADD,
  OPCODE_CONFIG_APP_KEY_STATUS,
  OPCODE_CONFIG_MODEL_APP_BIND,
  OPCODE_CONFIG_MODEL_APP_STATUS,
  STATUS_SUCCESS,
} from "./messages.ts";
import { awaitConfigStatus } from "./receiver.ts";

const DEFAULT_TTL = 10;
const DEFAULT_TIMEOUT_MS = 5_000;

export interface RebindOptions {
  readonly networkKey: Uint8Array;
  readonly appKey: Uint8Array;
  readonly deviceKey: Uint8Array;
  readonly ivIndex: number;
  readonly provisionerAddress: number;
  readonly nodeAddress: number;
  readonly netKeyIndex?: number;
  readonly appKeyIndex?: number;
  readonly sequenceNumber?: number;
  readonly modelIdentifier?: ModelIdentifier;
  readonly ttl?: number;
  readonly timeoutMs?: number;
}

export interface RebindResult {
  readonly sequenceNumber: number;
}

const concatBytes = (a: Uint8Array, b: Uint8Array): Uint8Array => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
};

interface SendAndAwaitParams {
  readonly conn: ProxyConnection;
  readonly stage: ConfigStage;
  readonly opcode: number;
  readonly payload: Uint8Array;
  readonly expectedStatusOpcode: number;
  readonly seq: number;
  readonly opts: RebindOptions;
}

/**
 * Build one Config Server access PDU, send it, and await the matching
 * status response in parallel — we fork the await first so we never miss
 * a notification that comes back in well under a millisecond.
 */
const sendAndAwait = (params: SendAndAwaitParams): Effect.Effect<void, ConfigError | BleError> =>
  Effect.gen(function* () {
    const { conn, stage, opcode, payload, expectedStatusOpcode, seq, opts } = params;

    const accessPdu = concatBytes(encodeOpcode(opcode), payload);

    const frame = encodeDeviceKeyFrame({
      netKey: opts.networkKey,
      deviceKey: opts.deviceKey,
      src: opts.provisionerAddress,
      dst: opts.nodeAddress,
      seq,
      ivIndex: opts.ivIndex,
      accessPdu,
      ttl: opts.ttl ?? DEFAULT_TTL,
    });

    // Fork the receiver before writing so we don't race the device's reply.
    const awaitFiber = yield* Effect.fork(
      awaitConfigStatus(conn, expectedStatusOpcode, {
        deviceKey: opts.deviceKey,
        networkKey: opts.networkKey,
        nodeAddress: opts.nodeAddress,
        provisionerAddress: opts.provisionerAddress,
        ivIndex: opts.ivIndex,
        timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      }),
    );

    yield* conn.write(frame);

    const result = yield* awaitFiber.await;
    if (result._tag === "Failure") {
      return yield* Effect.failCause(result.cause);
    }
    const { status } = result.value;
    if (status !== STATUS_SUCCESS) {
      return yield* Effect.fail(
        new ConfigError({
          stage,
          status,
          message: `${stage} returned non-success status 0x${status.toString(16).padStart(2, "0")}`,
        }),
      );
    }
  });

/**
 * Drive Config AppKey Add and Config Model App Bind against the node at
 * `address`. The returned sequence number is one past the last seq used —
 * callers can persist it for subsequent vendor traffic.
 */
export const rebindNode = (
  address: string,
  opts: RebindOptions,
): Effect.Effect<RebindResult, ConfigError | BleError, Scope.Scope> =>
  Effect.gen(function* () {
    const conn = yield* connectProxy(address);
    return yield* rebindOverConnection(conn, opts);
  });

/**
 * Variant of {@link rebindNode} that runs against an already-open
 * `ProxyConnection`. Exposed for tests (the fake-proxy harness) and for
 * callers that want to chain multiple config flows over a single GATT
 * connection without paying the scan+connect cost twice.
 */
export const rebindOverConnection = (
  conn: ProxyConnection,
  opts: RebindOptions,
): Effect.Effect<RebindResult, ConfigError | BleError> =>
  Effect.gen(function* () {
    const netKeyIndex = opts.netKeyIndex ?? 0;
    const appKeyIndex = opts.appKeyIndex ?? 0;
    const modelIdentifier = opts.modelIdentifier ?? GODOX_VENDOR_MODEL;
    let seq = opts.sequenceNumber ?? 0;

    // ---- 1. Config AppKey Add ------------------------------------------
    yield* sendAndAwait({
      conn,
      stage: "appKeyAdd",
      opcode: OPCODE_CONFIG_APP_KEY_ADD,
      payload: buildAppKeyAdd({ netKeyIndex, appKeyIndex, appKey: opts.appKey }),
      expectedStatusOpcode: OPCODE_CONFIG_APP_KEY_STATUS,
      seq,
      opts,
    });
    seq += 1;

    // ---- 2. Config Model App Bind --------------------------------------
    yield* sendAndAwait({
      conn,
      stage: "modelAppBind",
      opcode: OPCODE_CONFIG_MODEL_APP_BIND,
      payload: buildModelAppBind({
        elementAddress: opts.nodeAddress,
        appKeyIndex,
        modelIdentifier,
      }),
      expectedStatusOpcode: OPCODE_CONFIG_MODEL_APP_STATUS,
      seq,
      opts,
    });
    seq += 1;

    return { sequenceNumber: seq } satisfies RebindResult;
  });
