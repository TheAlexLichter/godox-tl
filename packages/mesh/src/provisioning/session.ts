// BT Mesh PB-GATT provisioning state machine.
//
// Drives a factory-reset Godox light through the eight-step provisioning
// dance (Mesh Profile spec §5.4) and returns a populated `ProvisioningResult`
// the caller can persist as `mesh_state.json`.
//
//   Invite           →
//                    ←   Capabilities
//   Start            →
//   PublicKey        →
//                    ←   PublicKey
//   [ECDH + ConfirmationKey derived]
//   Confirmation     →
//                    ←   Confirmation
//   Random           →
//                    ←   Random
//   [verify peer confirmation, derive session keys + device key]
//   Data             →
//                    ←   Complete  (or Failed → ProvisioningError)
//
// The session is wired with **No-OOB** authentication only — both the
// PublicKey type and the AuthMethod fields in the Start PDU are zero, so
// the authentication value is 16 zero bytes appended to each Random
// before CMAC.

import { randomBytes } from "node:crypto";
import { Effect, type Scope, type Stream } from "effect";
import { connectProvisioning } from "../ble/provisioning.ts";
import type { BleError } from "../ble/errors.ts";
import type { ProxyConnection } from "../ble/types.ts";
import { aesCcmEncrypt } from "../crypto/aes.ts";
import { cmac } from "../crypto/cmac.ts";
import { computeSharedSecret, generateKeyPair } from "../crypto/ecdh.ts";
import { k1, s1 } from "../crypto/kdf.ts";
import { ConfirmationMismatchError, ProvisioningError } from "./errors.ts";
import { decodeProvisioningPdu, DEFAULT_PB_GATT_MTU, encodeProvisioningPdu } from "./pbGatt.ts";
import {
  buildConfirmation,
  buildData,
  buildInvite,
  buildPublicKey,
  buildRandom,
  buildStart,
  parseCapabilities,
  parseConfirmation,
  parsePdu,
  parsePublicKey,
  parseRandom,
  PDU_CAPABILITIES,
  PDU_COMPLETE,
  PDU_CONFIRMATION,
  PDU_FAILED,
  PDU_PUBLIC_KEY,
  PDU_RANDOM,
} from "./pdus.ts";

const AUTH_VALUE_NO_OOB = new Uint8Array(16);
const PROVISIONER_ADDRESS_DEFAULT = 0x0001;
const NODE_ADDRESS_DEFAULT = 0x0002;
const ATTENTION_DURATION_DEFAULT = 0;

/** UTF-8 ASCII helper without depending on `TextEncoder` everywhere. */
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

/** Concatenate any number of byte buffers into a single `Uint8Array`. */
const concat = (...parts: ReadonlyArray<Uint8Array>): Uint8Array => {
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

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

export interface ProvisioningResult {
  readonly networkKey: Uint8Array;
  readonly appKey: Uint8Array;
  readonly deviceKey: Uint8Array;
  readonly nodeAddress: number;
  readonly provisionerAddress: number;
  readonly ivIndex: number;
  readonly sequenceNumber: number;
}

export interface ProvisionLightOptions {
  /** 16-byte Network Key to push into the new node. Random if omitted. */
  readonly networkKey?: Uint8Array;
  /** 16-byte Application Key. Random if omitted. (Bound separately in milestone 5.) */
  readonly appKey?: Uint8Array;
  /** Unicast address to assign to the new node (default `0x0002`). */
  readonly nodeAddress?: number;
  /** Provisioner unicast address (default `0x0001`). */
  readonly provisionerAddress?: number;
  /** Attention timer value sent in the Invite PDU (default `0`). */
  readonly attentionDuration?: number;
  /**
   * ATT MTU for PB-GATT segmentation. Defaults to 20 (the Mesh spec
   * minimum). Bumping this is mainly useful for tests so PDUs land in a
   * single write — real devices will usually negotiate larger MTUs but
   * the spec-mandated floor is the safe default for production.
   */
  readonly mtu?: number;
}

/**
 * Build the 25-byte plaintext that we encrypt into the Provisioning Data PDU.
 *
 * Layout (Mesh Profile §5.4.2.5):
 *   netKey(16) ‖ keyIndex(2 BE, 12 bits packed) ‖ flags(1) ‖ ivIndex(4 BE) ‖ unicast(2 BE)
 */
export const buildProvisioningDataPlaintext = (opts: {
  readonly networkKey: Uint8Array;
  readonly keyIndex: number;
  readonly flags: number;
  readonly ivIndex: number;
  readonly unicastAddress: number;
}): Uint8Array => {
  const { networkKey, keyIndex, flags, ivIndex, unicastAddress } = opts;
  if (networkKey.length !== 16) {
    throw new RangeError(`networkKey must be 16 bytes, got ${networkKey.length}`);
  }
  if (keyIndex < 0 || keyIndex > 0x0fff) {
    throw new RangeError("keyIndex must fit in 12 bits");
  }
  if (unicastAddress < 0 || unicastAddress > 0xffff) {
    throw new RangeError("unicastAddress must fit in 16 bits");
  }
  const out = new Uint8Array(25);
  out.set(networkKey, 0);
  // keyIndex packed into 2 BE bytes — the upper 4 bits are zero.
  out[16] = (keyIndex >>> 8) & 0x0f;
  out[17] = keyIndex & 0xff;
  out[18] = flags & 0xff;
  out[19] = (ivIndex >>> 24) & 0xff;
  out[20] = (ivIndex >>> 16) & 0xff;
  out[21] = (ivIndex >>> 8) & 0xff;
  out[22] = ivIndex & 0xff;
  out[23] = (unicastAddress >>> 8) & 0xff;
  out[24] = unicastAddress & 0xff;
  return out;
};

/**
 * Compute ConfirmationInputs = Invite ‖ Capabilities ‖ Start ‖ ProvPubKey ‖ DevPubKey.
 *
 * All five inputs are the *raw payload bytes* — no PDU-type byte, no proxy
 * header. Always 145 bytes total (1 + 11 + 5 + 64 + 64).
 */
export const buildConfirmationInputs = (opts: {
  readonly invitePayload: Uint8Array;
  readonly capabilitiesPayload: Uint8Array;
  readonly startPayload: Uint8Array;
  readonly provisionerPublicKey: Uint8Array;
  readonly devicePublicKey: Uint8Array;
}): Uint8Array => {
  const out = concat(
    opts.invitePayload,
    opts.capabilitiesPayload,
    opts.startPayload,
    opts.provisionerPublicKey,
    opts.devicePublicKey,
  );
  if (out.length !== 145) {
    throw new RangeError(`ConfirmationInputs must be 145 bytes, got ${out.length}`);
  }
  return out;
};

/**
 * Compute the 16-byte Confirmation value for a given Random.
 *
 *   ConfirmationKey = k1(ECDHSecret, ConfirmationSalt, "prck")
 *   Confirmation    = AES-CMAC(ConfirmationKey, random ‖ authValue)
 *
 * For No-OOB authentication the auth value is sixteen zero bytes.
 */
export const computeConfirmation = (opts: {
  readonly ecdhSecret: Uint8Array;
  readonly confirmationSalt: Uint8Array;
  readonly random: Uint8Array;
  readonly authValue?: Uint8Array;
}): Uint8Array => {
  const authValue = opts.authValue ?? AUTH_VALUE_NO_OOB;
  const confirmationKey = k1(opts.ecdhSecret, opts.confirmationSalt, utf8("prck"));
  return cmac(confirmationKey, concat(opts.random, authValue));
};

/**
 * Receive a single provisioning PDU from the bearer notifications stream
 * and parse off the type/payload. Maps a stream error → ProvisioningError.
 */
const receivePdu = <E>(
  notifications: Stream.Stream<Uint8Array, E>,
  stage: ProvisioningError["stage"],
): Effect.Effect<{ readonly type: number; readonly payload: Uint8Array }, ProvisioningError | E> =>
  decodeProvisioningPdu(notifications, stage).pipe(Effect.map(parsePdu));

const sendPdu = (
  connection: ProxyConnection,
  pdu: Uint8Array,
  stage: ProvisioningError["stage"],
  mtu: number,
): Effect.Effect<void, ProvisioningError | BleError> =>
  Effect.gen(function* () {
    const frames = encodeProvisioningPdu(pdu, mtu);
    for (const frame of frames) {
      yield* connection.write(frame).pipe(
        Effect.catchTag("BleError", (e) =>
          Effect.fail(
            new ProvisioningError({
              stage,
              message: `BLE write failed during ${stage} step`,
              cause: e,
            }),
          ),
        ),
      );
    }
  });

const failedFromPdu = (stage: ProvisioningError["stage"], payload: Uint8Array): ProvisioningError =>
  new ProvisioningError({
    stage,
    message: `device responded with Provisioning Failed (error=0x${(payload[0] ?? 0xff).toString(16).padStart(2, "0")})`,
  });

const unexpectedPdu = (
  stage: ProvisioningError["stage"],
  expected: number,
  actual: number,
): ProvisioningError =>
  new ProvisioningError({
    stage,
    message: `expected PDU type 0x${expected.toString(16).padStart(2, "0")}, got 0x${actual.toString(16).padStart(2, "0")}`,
  });

/**
 * Drive a provisioning exchange against an *already-open* connection.
 * Exposed for tests so the state machine can be exercised against a fake
 * `ProxyConnection`.
 */
export const runProvisioning = (
  connection: ProxyConnection,
  opts: ProvisionLightOptions = {},
): Effect.Effect<ProvisioningResult, ProvisioningError | ConfirmationMismatchError | BleError> =>
  Effect.gen(function* () {
    const networkKey = opts.networkKey ?? new Uint8Array(randomBytes(16));
    const appKey = opts.appKey ?? new Uint8Array(randomBytes(16));
    const nodeAddress = opts.nodeAddress ?? NODE_ADDRESS_DEFAULT;
    const provisionerAddress = opts.provisionerAddress ?? PROVISIONER_ADDRESS_DEFAULT;
    const attentionDuration = opts.attentionDuration ?? ATTENTION_DURATION_DEFAULT;
    const mtu = opts.mtu ?? DEFAULT_PB_GATT_MTU;
    const keyIndex = 0;
    const ivIndex = 0;
    const flags = 0;

    if (networkKey.length !== 16) {
      return yield* Effect.fail(
        new ProvisioningError({
          stage: "invite",
          message: `networkKey must be 16 bytes, got ${networkKey.length}`,
        }),
      );
    }
    if (appKey.length !== 16) {
      return yield* Effect.fail(
        new ProvisioningError({
          stage: "invite",
          message: `appKey must be 16 bytes, got ${appKey.length}`,
        }),
      );
    }

    const keyPair = generateKeyPair();

    // --- Step 1: Invite → Capabilities ---------------------------------
    const invitePayload = Uint8Array.of(attentionDuration & 0xff);
    yield* sendPdu(connection, buildInvite(attentionDuration), "invite", mtu);

    const capPdu = yield* receivePdu(connection.notifications, "capabilities");
    if (capPdu.type === PDU_FAILED)
      return yield* Effect.fail(failedFromPdu("capabilities", capPdu.payload));
    if (capPdu.type !== PDU_CAPABILITIES) {
      return yield* Effect.fail(unexpectedPdu("capabilities", PDU_CAPABILITIES, capPdu.type));
    }
    const capabilities = parseCapabilities(capPdu.payload);

    // --- Step 2: Start + PublicKey → device PublicKey ------------------
    // No-OOB profile: algorithm=0, publicKeyType=0, authMethod=0, action=0, size=0.
    const startPayload = Uint8Array.of(0, 0, 0, 0, 0);
    yield* sendPdu(connection, buildStart(), "start", mtu);
    yield* sendPdu(connection, buildPublicKey(keyPair.publicKey), "publicKey", mtu);

    const pkPdu = yield* receivePdu(connection.notifications, "publicKey");
    if (pkPdu.type === PDU_FAILED)
      return yield* Effect.fail(failedFromPdu("publicKey", pkPdu.payload));
    if (pkPdu.type !== PDU_PUBLIC_KEY) {
      return yield* Effect.fail(unexpectedPdu("publicKey", PDU_PUBLIC_KEY, pkPdu.type));
    }
    const devicePublicKey = parsePublicKey(pkPdu.payload);

    // --- Step 3: ECDH + Confirmation ----------------------------------
    const ecdhSecret = computeSharedSecret(keyPair.privateKey, devicePublicKey);
    const confirmationInputs = buildConfirmationInputs({
      invitePayload,
      capabilitiesPayload: capabilities.raw,
      startPayload,
      provisionerPublicKey: keyPair.publicKey,
      devicePublicKey,
    });
    const confirmationSalt = s1(confirmationInputs);
    const provisionerRandom = new Uint8Array(randomBytes(16));
    const provisionerConfirmation = computeConfirmation({
      ecdhSecret,
      confirmationSalt,
      random: provisionerRandom,
    });

    yield* sendPdu(connection, buildConfirmation(provisionerConfirmation), "confirmation", mtu);

    const confPdu = yield* receivePdu(connection.notifications, "confirmation");
    if (confPdu.type === PDU_FAILED)
      return yield* Effect.fail(failedFromPdu("confirmation", confPdu.payload));
    if (confPdu.type !== PDU_CONFIRMATION) {
      return yield* Effect.fail(unexpectedPdu("confirmation", PDU_CONFIRMATION, confPdu.type));
    }
    const deviceConfirmation = parseConfirmation(confPdu.payload);

    // --- Step 4: Random exchange + verify peer confirmation ------------
    yield* sendPdu(connection, buildRandom(provisionerRandom), "random", mtu);

    const randPdu = yield* receivePdu(connection.notifications, "random");
    if (randPdu.type === PDU_FAILED)
      return yield* Effect.fail(failedFromPdu("random", randPdu.payload));
    if (randPdu.type !== PDU_RANDOM) {
      return yield* Effect.fail(unexpectedPdu("random", PDU_RANDOM, randPdu.type));
    }
    const deviceRandom = parseRandom(randPdu.payload);

    const expectedDeviceConfirmation = computeConfirmation({
      ecdhSecret,
      confirmationSalt,
      random: deviceRandom,
    });
    if (
      expectedDeviceConfirmation.length !== deviceConfirmation.length ||
      !expectedDeviceConfirmation.every((b, i) => b === deviceConfirmation[i])
    ) {
      return yield* Effect.fail(
        new ConfirmationMismatchError({
          expected: toHex(expectedDeviceConfirmation),
          actual: toHex(deviceConfirmation),
        }),
      );
    }

    // --- Step 5: derive keys + send Data ------------------------------
    const provisioningSalt = s1(concat(confirmationSalt, provisionerRandom, deviceRandom));
    const sessionKey = k1(ecdhSecret, provisioningSalt, utf8("prsk"));
    const sessionNonce = k1(ecdhSecret, provisioningSalt, utf8("prsn")).subarray(3);
    const deviceKey = k1(ecdhSecret, provisioningSalt, utf8("prdk"));

    const plaintext = buildProvisioningDataPlaintext({
      networkKey,
      keyIndex,
      flags,
      ivIndex,
      unicastAddress: nodeAddress,
    });
    const encryptedData = aesCcmEncrypt(sessionKey, sessionNonce, plaintext, 8);
    yield* sendPdu(connection, buildData(encryptedData), "data", mtu);

    // --- Step 6: wait for Complete ------------------------------------
    const completePdu = yield* receivePdu(connection.notifications, "complete");
    if (completePdu.type === PDU_FAILED)
      return yield* Effect.fail(failedFromPdu("complete", completePdu.payload));
    if (completePdu.type !== PDU_COMPLETE) {
      return yield* Effect.fail(unexpectedPdu("complete", PDU_COMPLETE, completePdu.type));
    }

    return {
      networkKey,
      appKey,
      deviceKey,
      nodeAddress,
      provisionerAddress,
      ivIndex,
      sequenceNumber: 0,
    } satisfies ProvisioningResult;
  });

/**
 * Open a PB-GATT connection to a factory-reset Godox light and run the
 * provisioning exchange end-to-end.
 *
 * Lifetime is bound to the surrounding Scope — wrap the call in
 * `Effect.scoped` to disconnect the peripheral automatically.
 */
export const provisionLight = (
  address: string,
  opts: ProvisionLightOptions = {},
): Effect.Effect<
  ProvisioningResult,
  ProvisioningError | ConfirmationMismatchError | BleError,
  Scope.Scope
> =>
  Effect.gen(function* () {
    const connection = yield* connectProvisioning(address);
    return yield* runProvisioning(connection, opts);
  });
