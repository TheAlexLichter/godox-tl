// Provisioning PDU builders + parsers (Mesh Profile spec §5.4.1).
//
// On the wire each PDU is `[type (1 byte) | payload]`. The PB-GATT framing
// layer (see `pbGatt.ts`) wraps these in proxy SAR+type bytes before they
// hit the GATT characteristic. Builders here return *just the unwrapped*
// PDU type+payload — the framing layer adds segmentation.

/** Provisioning PDU type codes (Mesh Profile §5.4.1). */
export const PDU_INVITE = 0x00;
export const PDU_CAPABILITIES = 0x01;
export const PDU_START = 0x02;
export const PDU_PUBLIC_KEY = 0x03;
export const PDU_INPUT_COMPLETE = 0x04; // OOB auth only — not used for No-OOB
export const PDU_CONFIRMATION = 0x05;
export const PDU_RANDOM = 0x06;
export const PDU_DATA = 0x07;
export const PDU_COMPLETE = 0x08;
export const PDU_FAILED = 0x09;

export interface ProvisioningCapabilities {
  readonly numElements: number;
  readonly algorithms: number;
  readonly pubKeyType: number;
  readonly staticOobType: number;
  readonly outputOobSize: number;
  readonly outputOobAction: number;
  readonly inputOobSize: number;
  readonly inputOobAction: number;
  /** Original 11-byte payload — needed verbatim for `confirmationInputs`. */
  readonly raw: Uint8Array;
}

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

const wrap = (pduType: number, payload: Uint8Array): Uint8Array =>
  concat(Uint8Array.of(pduType), payload);

// --- Builders (provisioner → device) -------------------------------------

/** Build a Provisioning Invite PDU (1-byte payload). */
export const buildInvite = (attentionDuration = 0): Uint8Array =>
  wrap(PDU_INVITE, Uint8Array.of(attentionDuration & 0xff));

/**
 * Build a Provisioning Start PDU.
 *
 * Defaults to the No-OOB profile we use everywhere: algorithm=FIPS P-256,
 * public-key=No OOB, authentication method=No OOB, action=0, size=0.
 */
export const buildStart = (
  opts: {
    readonly algorithm?: number;
    readonly publicKeyType?: number;
    readonly authMethod?: number;
    readonly authAction?: number;
    readonly authSize?: number;
  } = {},
): Uint8Array => {
  const { algorithm = 0, publicKeyType = 0, authMethod = 0, authAction = 0, authSize = 0 } = opts;
  return wrap(
    PDU_START,
    Uint8Array.of(
      algorithm & 0xff,
      publicKeyType & 0xff,
      authMethod & 0xff,
      authAction & 0xff,
      authSize & 0xff,
    ),
  );
};

/** Build a Provisioning Public Key PDU. The public key is the raw 64-byte X||Y form. */
export const buildPublicKey = (publicKey: Uint8Array): Uint8Array => {
  if (publicKey.length !== 64) {
    throw new RangeError(`publicKey must be 64 bytes (X||Y), got ${publicKey.length}`);
  }
  return wrap(PDU_PUBLIC_KEY, publicKey);
};

/** Build a Provisioning Confirmation PDU (16-byte CMAC). */
export const buildConfirmation = (confirmation: Uint8Array): Uint8Array => {
  if (confirmation.length !== 16) {
    throw new RangeError(`confirmation must be 16 bytes, got ${confirmation.length}`);
  }
  return wrap(PDU_CONFIRMATION, confirmation);
};

/** Build a Provisioning Random PDU. */
export const buildRandom = (random: Uint8Array): Uint8Array => {
  if (random.length !== 16) {
    throw new RangeError(`random must be 16 bytes, got ${random.length}`);
  }
  return wrap(PDU_RANDOM, random);
};

/** Build a Provisioning Data PDU (25 bytes plaintext + 8-byte MIC). */
export const buildData = (encryptedData: Uint8Array): Uint8Array => {
  if (encryptedData.length !== 33) {
    throw new RangeError(
      `encrypted data must be 33 bytes (25 + 8 MIC), got ${encryptedData.length}`,
    );
  }
  return wrap(PDU_DATA, encryptedData);
};

// --- Parsers (device → provisioner) --------------------------------------

/**
 * Parse a Capabilities payload (11 bytes, with PDU-type byte already stripped).
 * Keeps the raw bytes around — they go straight into ConfirmationInputs.
 */
export const parseCapabilities = (payload: Uint8Array): ProvisioningCapabilities => {
  if (payload.length !== 11) {
    throw new RangeError(`capabilities payload must be 11 bytes, got ${payload.length}`);
  }
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  return {
    numElements: payload[0]!,
    algorithms: view.getUint16(1, false),
    pubKeyType: payload[3]!,
    staticOobType: payload[4]!,
    outputOobSize: payload[5]!,
    outputOobAction: view.getUint16(6, false),
    inputOobSize: payload[8]!,
    inputOobAction: view.getUint16(9, false),
    raw: new Uint8Array(payload),
  };
};

/** Parse a Public Key payload (64 raw bytes, X||Y). */
export const parsePublicKey = (payload: Uint8Array): Uint8Array => {
  if (payload.length !== 64) {
    throw new RangeError(`public key payload must be 64 bytes, got ${payload.length}`);
  }
  return new Uint8Array(payload);
};

/** Parse a Confirmation payload (16-byte CMAC). */
export const parseConfirmation = (payload: Uint8Array): Uint8Array => {
  if (payload.length !== 16) {
    throw new RangeError(`confirmation payload must be 16 bytes, got ${payload.length}`);
  }
  return new Uint8Array(payload);
};

/** Parse a Random payload (16 bytes). */
export const parseRandom = (payload: Uint8Array): Uint8Array => {
  if (payload.length !== 16) {
    throw new RangeError(`random payload must be 16 bytes, got ${payload.length}`);
  }
  return new Uint8Array(payload);
};

/**
 * Split a raw provisioning PDU (after the proxy SAR/type byte is stripped)
 * into `(type, payload)`. The Failed PDU (0x09) is not turned into an
 * exception here — the state machine maps it to a `ProvisioningError`.
 */
export const parsePdu = (
  raw: Uint8Array,
): { readonly type: number; readonly payload: Uint8Array } => {
  if (raw.length < 1) throw new RangeError("provisioning PDU is empty");
  return { type: raw[0]!, payload: raw.subarray(1) };
};
