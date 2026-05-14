// Foundation Models access-payload builders used by ConfigSession.
//
// All payloads here are produced *without* the opcode prefix — `session.ts`
// composes the opcode (via `encodeOpcode`) with the payload to form the
// full Access PDU. This matches the public API in milestone 5 and keeps the
// per-message byte-layout asserts in tests focused on the payload bytes.
//
// Byte layouts per Mesh Profile v1.0.1 Annex A.4.3:
//   Config AppKey Add:
//     opcode = 0x00 (1 octet)
//     payload = 3-octet packed (NetKeyIndex || AppKeyIndex) || AppKey (16 B)
//             where the two 12-bit indexes are packed little-endian into 24 bits:
//             byte0 = NetIdx[7:0]
//             byte1 = (AppIdx[3:0] << 4) | NetIdx[11:8]
//             byte2 = AppIdx[11:4]
//
//   Config Model App Bind:
//     opcode = 0x803D (2 octets, big-endian on the wire)
//     payload = ElementAddress(2, LE) || AppKeyIndex(2, LE; 12-bit value)
//               || ModelIdentifier (SIG = 2 B LE, vendor = CompanyID(2, LE) || ModelID(2, LE))
//
// Endianness notes verified against `godox_ul60bi_bt/config.py`:
//   * ElementAddress: little-endian on the access layer (`to_bytes(2, "little")`).
//   * AppKeyIndex: little-endian (`to_bytes(2, "little")`).
//   * Vendor model id: CompanyID LE then ModelID LE (`to_bytes(2, "little")` each).
//   * Vendor model identifier on the wire is therefore 4 bytes; CompanyID first.

// --- Opcode constants -----------------------------------------------------

/** Config AppKey Add — 1-octet opcode. (Mesh Profile Annex A.4.3.) */
export const OPCODE_CONFIG_APP_KEY_ADD = 0x00;
/** Config AppKey Status — 2-octet opcode. */
export const OPCODE_CONFIG_APP_KEY_STATUS = 0x8003;
/** Config Model App Bind — 2-octet opcode. */
export const OPCODE_CONFIG_MODEL_APP_BIND = 0x803d;
/** Config Model App Status — 2-octet opcode. */
export const OPCODE_CONFIG_MODEL_APP_STATUS = 0x803e;

/** Foundation Models Status code: Success. (Mesh Profile Annex A.4.4.) */
export const STATUS_SUCCESS = 0x00;

// --- Telink/Godox defaults ------------------------------------------------

/**
 * Telink (Godox vendor) CompanyID. The Godox light vendor model lives at
 * `(CompanyID=0x0211, ModelID=0x0000)` per `godox_ul60bi_bt/config.py`.
 */
export const TELINK_COMPANY_ID = 0x0211;
/** Telink vendor ModelID for the Godox light element. */
export const TELINK_VENDOR_MODEL_ID = 0x0000;

/** Convenience: the vendor model identifier we bind by default. */
export const GODOX_VENDOR_MODEL: VendorModelIdentifier = {
  vendorId: TELINK_COMPANY_ID,
  modelId: TELINK_VENDOR_MODEL_ID,
};

// --- Types ----------------------------------------------------------------

export interface VendorModelIdentifier {
  readonly vendorId: number;
  readonly modelId: number;
}

export type ModelIdentifier = number | VendorModelIdentifier;

// --- Opcode encoding ------------------------------------------------------

/**
 * Pack a 1- or 2-octet opcode to its on-wire bytes.
 *
 * The Mesh Profile reserves the top bit(s) of the first opcode byte to
 * disambiguate 1 / 2 / 3-octet opcodes. Config Server messages use only
 * 1-octet (`0x00..0x7F`) and 2-octet (`0x8000..0xBFFF`) forms; we encode
 * 2-octet opcodes in big-endian order as per the spec.
 */
export const encodeOpcode = (opcode: number): Uint8Array => {
  if (!Number.isInteger(opcode) || opcode < 0) {
    throw new RangeError(`opcode must be a non-negative integer, got ${opcode}`);
  }
  if (opcode <= 0x7f) {
    // 1-octet form (high bit clear). 0x7F is reserved for "RFU" but we
    // accept it; the only 1-octet Config opcode we emit is 0x00.
    return new Uint8Array([opcode]);
  }
  if (opcode <= 0xffff) {
    if ((opcode & 0xc000) !== 0x8000) {
      throw new RangeError(
        `2-octet opcode must have top two bits = 10b (0x8000..0xBFFF), got 0x${opcode.toString(16)}`,
      );
    }
    return new Uint8Array([(opcode >>> 8) & 0xff, opcode & 0xff]);
  }
  throw new RangeError(`opcode 0x${opcode.toString(16)} is wider than 2 octets`);
};

// --- Payload builders -----------------------------------------------------

const checkIndex12 = (label: string, value: number): void => {
  if (!Number.isInteger(value) || value < 0 || value > 0xfff) {
    throw new RangeError(`${label} must fit in 12 bits, got ${value}`);
  }
};

/**
 * Build the 19-byte Config AppKey Add payload (after the opcode).
 *
 * Layout: `packed_indexes(3) || app_key(16)` where the two 12-bit indexes
 * are packed little-endian into 24 bits — `NetKeyIndex` occupies the low
 * 12 bits, `AppKeyIndex` occupies the high 12 bits.
 */
export const buildAppKeyAdd = (opts: {
  readonly netKeyIndex: number;
  readonly appKeyIndex: number;
  readonly appKey: Uint8Array;
}): Uint8Array => {
  const { netKeyIndex, appKeyIndex, appKey } = opts;
  checkIndex12("netKeyIndex", netKeyIndex);
  checkIndex12("appKeyIndex", appKeyIndex);
  if (appKey.length !== 16) {
    throw new RangeError(`appKey must be 16 bytes, got ${appKey.length}`);
  }
  const packed = (netKeyIndex & 0xfff) | ((appKeyIndex & 0xfff) << 12);
  const out = new Uint8Array(3 + 16);
  out[0] = packed & 0xff;
  out[1] = (packed >>> 8) & 0xff;
  out[2] = (packed >>> 16) & 0xff;
  out.set(appKey, 3);
  return out;
};

/**
 * Build the Config Model App Bind payload (after the opcode).
 *
 * Layout: `ElementAddress(2, LE) || AppKeyIndex(2, LE; 12-bit value) ||
 * ModelIdentifier`. Model identifier is 2 bytes (LE) for SIG models or
 * 4 bytes (CompanyID LE || ModelID LE) for vendor models.
 */
export const buildModelAppBind = (opts: {
  readonly elementAddress: number;
  readonly appKeyIndex: number;
  readonly modelIdentifier: ModelIdentifier;
}): Uint8Array => {
  const { elementAddress, appKeyIndex, modelIdentifier } = opts;
  if (!Number.isInteger(elementAddress) || elementAddress < 0 || elementAddress > 0xffff) {
    throw new RangeError(`elementAddress must fit in 16 bits, got ${elementAddress}`);
  }
  checkIndex12("appKeyIndex", appKeyIndex);

  const modelBytes = encodeModelIdentifier(modelIdentifier);

  const out = new Uint8Array(2 + 2 + modelBytes.length);
  out[0] = elementAddress & 0xff;
  out[1] = (elementAddress >>> 8) & 0xff;
  out[2] = appKeyIndex & 0xff;
  out[3] = (appKeyIndex >>> 8) & 0xff;
  out.set(modelBytes, 4);
  return out;
};

/**
 * Encode a model identifier. SIG model = 2 octets little-endian; vendor
 * model = CompanyID(2, LE) || ModelID(2, LE) per Mesh Profile §3.7.2.
 */
export const encodeModelIdentifier = (identifier: ModelIdentifier): Uint8Array => {
  if (typeof identifier === "number") {
    if (!Number.isInteger(identifier) || identifier < 0 || identifier > 0xffff) {
      throw new RangeError(`SIG modelIdentifier must fit in 16 bits, got ${identifier}`);
    }
    return new Uint8Array([identifier & 0xff, (identifier >>> 8) & 0xff]);
  }
  const { vendorId, modelId } = identifier;
  if (!Number.isInteger(vendorId) || vendorId < 0 || vendorId > 0xffff) {
    throw new RangeError(`vendorId must fit in 16 bits, got ${vendorId}`);
  }
  if (!Number.isInteger(modelId) || modelId < 0 || modelId > 0xffff) {
    throw new RangeError(`modelId must fit in 16 bits, got ${modelId}`);
  }
  return new Uint8Array([
    vendorId & 0xff,
    (vendorId >>> 8) & 0xff,
    modelId & 0xff,
    (modelId >>> 8) & 0xff,
  ]);
};

// --- Status response decoding --------------------------------------------

export interface ParsedAppKeyStatus {
  readonly status: number;
  readonly netKeyIndex: number;
  readonly appKeyIndex: number;
}

/**
 * Parse a Config AppKey Status access payload — *without* the opcode prefix
 * (4 bytes: status(1) || packed_indexes(3)).
 */
export const parseAppKeyStatus = (payload: Uint8Array): ParsedAppKeyStatus => {
  if (payload.length < 4) {
    throw new RangeError(`AppKey Status payload too short: ${payload.length}`);
  }
  const status = payload[0]!;
  const packed = payload[1]! | (payload[2]! << 8) | (payload[3]! << 16);
  return {
    status,
    netKeyIndex: packed & 0xfff,
    appKeyIndex: (packed >>> 12) & 0xfff,
  };
};

export interface ParsedModelAppStatus {
  readonly status: number;
  readonly elementAddress: number;
  readonly appKeyIndex: number;
  readonly modelIdentifier: ModelIdentifier;
}

/**
 * Parse a Config Model App Status payload (without opcode prefix). The model
 * identifier is 2 octets for SIG models or 4 for vendor models — we infer
 * the form from the payload length (7 or 9).
 */
export const parseModelAppStatus = (payload: Uint8Array): ParsedModelAppStatus => {
  if (payload.length !== 7 && payload.length !== 9) {
    throw new RangeError(`ModelApp Status payload must be 7 or 9 bytes, got ${payload.length}`);
  }
  const status = payload[0]!;
  const elementAddress = payload[1]! | (payload[2]! << 8);
  const appKeyIndex = (payload[3]! | (payload[4]! << 8)) & 0xfff;
  const modelIdentifier: ModelIdentifier =
    payload.length === 7
      ? payload[5]! | (payload[6]! << 8)
      : {
          vendorId: payload[5]! | (payload[6]! << 8),
          modelId: payload[7]! | (payload[8]! << 8),
        };
  return { status, elementAddress, appKeyIndex, modelIdentifier };
};

/**
 * Detect a Foundation Models opcode at the start of an access payload and
 * return the opcode plus the parameters that follow it. Supports 1- and
 * 2-octet opcodes only (Config Server never uses 3-octet vendor opcodes).
 */
export const splitOpcode = (
  accessPdu: Uint8Array,
): { readonly opcode: number; readonly parameters: Uint8Array } => {
  if (accessPdu.length === 0) {
    throw new RangeError("access PDU is empty");
  }
  const b0 = accessPdu[0]!;
  if ((b0 & 0x80) === 0) {
    // 1-octet
    return { opcode: b0, parameters: accessPdu.subarray(1) };
  }
  if ((b0 & 0xc0) === 0x80) {
    // 2-octet
    if (accessPdu.length < 2) {
      throw new RangeError("2-octet opcode truncated");
    }
    return { opcode: (b0 << 8) | accessPdu[1]!, parameters: accessPdu.subarray(2) };
  }
  // 3-octet form (top two bits = 11b) — vendor; outside Config scope.
  throw new RangeError(`3-octet (vendor) opcode not supported here: 0x${b0.toString(16)}`);
};
