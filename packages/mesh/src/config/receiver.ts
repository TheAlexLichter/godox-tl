// Decode an incoming Mesh Proxy notification carrying a Config Server status
// message, and surface the (opcode, status) pair to the session.
//
// The full decryption stack is the symmetric inverse of `encodeDeviceKeyFrame`:
//
//   Proxy PDU  ──► strip SAR/type byte
//   Network    ──► deobfuscate + AES-CCM decrypt with k2(NetKey)
//   Lower XPT  ──► strip 1-byte unsegmented header (AKF=0, AID=0)
//   Upper XPT  ──► AES-CCM decrypt with DeviceKey + device nonce
//   Access     ──► split opcode || parameters
//
// We only handle unsegmented complete Network PDUs here — that is what the
// node sends back for the two ConfigSession statuses. Anything else (a
// segmented response, an unrelated mesh broadcast, etc.) is silently
// skipped on the notifications stream until either the expected opcode
// arrives or the caller's timeout fires.

import { Duration, Effect, Option, Stream } from "effect";
import { k2 } from "../crypto/kdf.ts";
import { deviceNonce } from "../crypto/nonces.ts";
import type { ProxyConnection } from "../ble/types.ts";
import { decodeUnsegmentedAccess } from "../pdu/lowerTransport.ts";
import { decodeNetworkPdu } from "../pdu/network.ts";
import { decodeProxyPdu } from "../pdu/proxy.ts";
import { decryptAccessPdu } from "../pdu/upperTransport.ts";
import { ConfigError } from "./errors.ts";
import { splitOpcode } from "./messages.ts";

const DEFAULT_TIMEOUT_MS = 5_000;

export interface AwaitConfigStatusOptions {
  readonly deviceKey: Uint8Array;
  readonly networkKey: Uint8Array;
  readonly nodeAddress: number;
  readonly provisionerAddress: number;
  readonly ivIndex: number;
  readonly timeoutMs?: number;
}

export interface DecodedStatus {
  readonly status: number;
  readonly payload: Uint8Array;
}

interface DecodedAccess {
  readonly opcode: number;
  readonly parameters: Uint8Array;
}

/**
 * Try to decode a single proxy notification frame into its access-layer
 * opcode+parameters. Returns `null` if the frame is not a complete Network
 * PDU we recognise, or fails to decrypt (different src/dst, wrong key,
 * unrelated mesh traffic). The caller treats `null` as "ignore and wait
 * for the next notification".
 */
export const tryDecodeProxyNotification = (
  notification: Uint8Array,
  opts: {
    readonly deviceKey: Uint8Array;
    readonly networkKey: Uint8Array;
    readonly nodeAddress: number;
    readonly provisionerAddress: number;
    readonly ivIndex: number;
  },
): DecodedAccess | null => {
  try {
    const { payload: networkPdu, sar, messageType } = decodeProxyPdu(notification);
    // SAR=0 (complete), messageType=0 (Network PDU). Skip beacons, proxy
    // configuration, and segmented frames here.
    if (sar !== 0 || messageType !== 0) return null;
    if (networkPdu.length < 14) return null;

    const { encryptionKey, privacyKey } = k2(opts.networkKey, new Uint8Array([0x00]));

    const decodedNet = decodeNetworkPdu({
      pdu: networkPdu,
      ivIndex: opts.ivIndex,
      encryptionKey,
      privacyKey,
    });

    // Only consider unicast traffic from the node we're configuring to us.
    if (decodedNet.src !== opts.nodeAddress) return null;
    if (decodedNet.dst !== opts.provisionerAddress) return null;
    if (decodedNet.ctl !== 0) return null;

    const { header, encryptedAccessPdu } = decodeUnsegmentedAccess(decodedNet.lowerTransportPdu);
    // Config Server responses are DeviceKey-secured: AKF=0, AID=0.
    if (header.akf !== 0) return null;

    const nonce = deviceNonce({
      aszmic: 0,
      seq: decodedNet.seq,
      src: decodedNet.src,
      dst: decodedNet.dst,
      ivIndex: opts.ivIndex,
    });

    const accessPdu = decryptAccessPdu({
      encryptedAccessPdu,
      appKey: opts.deviceKey,
      nonce,
      szmic: 0,
    });

    return splitOpcode(accessPdu);
  } catch {
    return null;
  }
};

/**
 * Await the next notification that decodes to `expectedOpcode` and return
 * its `{ status, payload }`. The payload is the parameters *after* the
 * opcode bytes; the first byte is the Foundation Models status code
 * (Annex A.4.4).
 *
 * Rejects with `ConfigError({ stage: "receive" })` on timeout.
 */
export const awaitConfigStatus = (
  conn: ProxyConnection,
  expectedOpcode: number,
  opts: AwaitConfigStatusOptions,
): Effect.Effect<DecodedStatus, ConfigError> => {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const decoded: Stream.Stream<DecodedAccess, ConfigError> = conn.notifications.pipe(
    Stream.mapError(
      (cause) =>
        new ConfigError({
          stage: "receive",
          message: "notification stream errored while awaiting config status",
          cause,
        }),
    ),
    Stream.filterMap((buf) => {
      const access = tryDecodeProxyNotification(buf, {
        deviceKey: opts.deviceKey,
        networkKey: opts.networkKey,
        nodeAddress: opts.nodeAddress,
        provisionerAddress: opts.provisionerAddress,
        ivIndex: opts.ivIndex,
      });
      if (!access) return Option.none();
      if (access.opcode !== expectedOpcode) return Option.none();
      return Option.some(access);
    }),
  );

  return Stream.runHead(decoded).pipe(
    Effect.flatMap((head) =>
      head._tag === "Some"
        ? Effect.succeed(head.value)
        : Effect.fail(
            new ConfigError({
              stage: "receive",
              message: `notification stream ended before opcode 0x${expectedOpcode.toString(16)} arrived`,
            }),
          ),
    ),
    Effect.timeoutFail({
      duration: Duration.millis(timeoutMs),
      onTimeout: () =>
        new ConfigError({
          stage: "receive",
          message: `timed out after ${timeoutMs}ms waiting for opcode 0x${expectedOpcode.toString(16)}`,
        }),
    }),
    Effect.map((decoded) => {
      const params = decoded.parameters;
      const status = params.length > 0 ? params[0]! : 0xff;
      return { status, payload: params } satisfies DecodedStatus;
    }),
  );
};
