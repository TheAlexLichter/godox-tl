// PB-GATT — Provisioning Bearer over GATT (Mesh Profile §6.6).
//
// Each ATT notification or write is a single proxy frame: one header byte
// holding `(SAR << 6) | MessageType`, followed by up to `mtu - 1` bytes of
// payload. For provisioning the message type is always `0x03`.
//
// SAR (Segmentation And Reassembly) encodes:
//   0 — complete (the whole PDU fits in one frame)
//   1 — first segment of a multi-frame PDU
//   2 — continuation segment
//   3 — last segment
//
// Reassembly: collect frames until we see SAR=0 or SAR=3 and concatenate the
// payloads. Frames with the wrong message type are ignored — the device
// occasionally interleaves other proxy traffic on a hybrid bearer, though
// in practice during provisioning we only ever see type=0x03.

import { Chunk, Effect, Stream } from "effect";
import { ProvisioningError } from "./errors.ts";

const PROVISIONING_MESSAGE_TYPE = 0x03;

const SAR_COMPLETE = 0x00;
const SAR_FIRST = 0x01;
const SAR_CONTINUATION = 0x02;
const SAR_LAST = 0x03;

/**
 * Maximum write size for the GATT Data In characteristic. The Mesh spec
 * mandates supporting at least 20-byte ATT MTU (so 19 bytes of payload
 * after the proxy header). Godox lights happily accept larger writes but
 * we keep the safe default so segmentation always exercises correctly.
 */
export const DEFAULT_PB_GATT_MTU = 20;

const concat = (parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
};

const header = (sar: number): number => ((sar & 0x03) << 6) | (PROVISIONING_MESSAGE_TYPE & 0x3f);

/**
 * Segment a provisioning PDU into one or more PB-GATT frames ready to write
 * to the Data In characteristic.
 *
 * @param pdu - unwrapped provisioning PDU (`[type, ...payload]`, no proxy header).
 * @param mtu - ATT MTU. Frames will be at most `mtu` bytes long (header + payload).
 */
export const encodeProvisioningPdu = (
  pdu: Uint8Array,
  mtu: number = DEFAULT_PB_GATT_MTU,
): Uint8Array[] => {
  if (mtu < 2) throw new RangeError(`mtu must be >= 2, got ${mtu}`);
  const maxPayload = mtu - 1;

  // Fits in a single frame — SAR=0 (complete).
  if (pdu.length <= maxPayload) {
    const out = new Uint8Array(1 + pdu.length);
    out[0] = header(SAR_COMPLETE);
    out.set(pdu, 1);
    return [out];
  }

  // Segment. First chunk gets SAR=1, intermediate chunks SAR=2, last SAR=3.
  const frames: Uint8Array[] = [];
  let offset = 0;
  while (offset < pdu.length) {
    const remaining = pdu.length - offset;
    const take = Math.min(maxPayload, remaining);
    const isFirst = offset === 0;
    const isLast = offset + take === pdu.length;
    const sar = isFirst ? SAR_FIRST : isLast ? SAR_LAST : SAR_CONTINUATION;
    const frame = new Uint8Array(1 + take);
    frame[0] = header(sar);
    frame.set(pdu.subarray(offset, offset + take), 1);
    frames.push(frame);
    offset += take;
  }
  return frames;
};

/**
 * Pull notification frames from `stream` until a complete provisioning PDU
 * has been reassembled, then succeed with the unwrapped PDU bytes
 * (`[type, ...payload]`). Frames whose message type isn't `0x03` are
 * dropped. Stream termination before a complete PDU yields a
 * `ProvisioningError`.
 *
 * The caller is responsible for choosing which `stage` label is most
 * informative if reassembly fails — pass it in as `stage`.
 */
export const decodeProvisioningPdu = <E>(
  stream: Stream.Stream<Uint8Array, E>,
  stage: ProvisioningError["stage"],
): Effect.Effect<Uint8Array, ProvisioningError | E> =>
  Effect.gen(function* () {
    const segments: Uint8Array[] = [];
    let sawFirst = false;

    const exit: Uint8Array | undefined = yield* Stream.runFoldWhile(
      stream,
      undefined as Uint8Array | undefined,
      (acc) => acc === undefined,
      (_acc, frame) => {
        if (frame.length < 1) return undefined; // ignore empty
        const head = frame[0]!;
        const messageType = head & 0x3f;
        if (messageType !== PROVISIONING_MESSAGE_TYPE) return undefined;
        const sar = (head >>> 6) & 0x03;
        const payload = frame.subarray(1);
        if (sar === SAR_COMPLETE) {
          // A complete PDU in one frame — but discard anything we'd been
          // half-collecting (out-of-order frame; protocol restart).
          segments.length = 0;
          sawFirst = false;
          return new Uint8Array(payload);
        }
        if (sar === SAR_FIRST) {
          segments.length = 0;
          segments.push(new Uint8Array(payload));
          sawFirst = true;
          return undefined;
        }
        if (sar === SAR_CONTINUATION) {
          if (!sawFirst) return undefined; // stray continuation, drop
          segments.push(new Uint8Array(payload));
          return undefined;
        }
        // SAR_LAST
        if (!sawFirst) return undefined; // stray last segment, drop
        segments.push(new Uint8Array(payload));
        const merged = concat(segments);
        segments.length = 0;
        sawFirst = false;
        return merged;
      },
    );

    if (exit === undefined) {
      return yield* Effect.fail(
        new ProvisioningError({
          stage,
          message: "notifications stream ended before a complete provisioning PDU arrived",
        }),
      );
    }
    return exit;
  });

// `Chunk` is intentionally re-exported so call sites that build test streams
// don't have to import directly from `effect`.
export { Chunk };
