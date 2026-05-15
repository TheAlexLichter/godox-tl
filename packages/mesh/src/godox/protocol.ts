// Godox V2 vendor payload encoder.
//
// Port of `build_v2_command` from godox_ul60bi_bt/protocol.py and the
// brightness/CCT framing performed by the Python CLI (`_control_v2_parts` in
// cli.py) / GodoxController.set_params in controller.py.
//
// A V2 payload is exactly 8 bytes:
//   [ model, d0, d1, d2, d3, d4, end_byte, crc8 ]
// where data shorter than 5 bytes is padded with 0xFF and the trailing CRC-8
// is computed (Godox lookup-table variant) over the preceding 7 bytes.
//
// This module is the lowest layer of the Godox-specific protocol; it produces
// plaintext bytes that are later wrapped by the Mesh access-layer encryption.

// TODO(mesh-crypto): replace with shared crc8 from ../crypto/crc8.ts once
// milestone 1 lands. Table matches GODOX_CRC8_TABLE in godox_ul60bi_bt/crypto.py.
const GODOX_CRC8_TABLE: readonly number[] = [
  0, 94, 188, 226, 97, 63, 221, 131, 194, 156, 126, 32, 163, 253, 31, 65, 157, 195, 33, 127, 252,
  162, 64, 30, 95, 1, 227, 189, 62, 96, 130, 220, 35, 125, 159, 193, 66, 28, 254, 160, 225, 191, 93,
  3, 128, 222, 60, 98, 190, 224, 2, 92, 223, 129, 99, 61, 124, 34, 192, 158, 29, 67, 161, 255, 70,
  24, 250, 164, 39, 121, 155, 197, 132, 218, 56, 102, 229, 187, 89, 7, 219, 133, 103, 57, 186, 228,
  6, 88, 25, 71, 165, 251, 120, 38, 196, 154, 101, 59, 217, 135, 4, 90, 184, 230, 167, 249, 27, 69,
  198, 152, 122, 36, 248, 166, 68, 26, 153, 199, 37, 123, 58, 100, 134, 216, 91, 5, 231, 185, 140,
  210, 48, 110, 237, 179, 81, 15, 78, 16, 242, 172, 47, 113, 147, 205, 17, 79, 173, 243, 112, 46,
  204, 146, 211, 141, 111, 49, 178, 236, 14, 80, 175, 241, 19, 77, 206, 144, 114, 44, 109, 51, 209,
  143, 12, 82, 176, 238, 50, 108, 142, 208, 83, 13, 239, 177, 240, 174, 76, 18, 145, 207, 45, 115,
  202, 148, 118, 40, 171, 245, 23, 73, 8, 86, 180, 234, 105, 55, 213, 139, 87, 9, 235, 181, 54, 104,
  138, 212, 149, 203, 41, 119, 244, 170, 72, 22, 233, 183, 85, 11, 136, 214, 52, 106, 43, 117, 151,
  201, 74, 20, 246, 168, 116, 42, 200, 150, 21, 75, 169, 247, 182, 232, 10, 84, 215, 137, 107, 53,
];

const crc8 = (data: Uint8Array): number => {
  let crc = 0;
  for (const byte of data) {
    crc = GODOX_CRC8_TABLE[crc ^ byte]!;
  }
  return crc;
};

/**
 * Godox vendor opcode (24-bit) in Telink little-endian wire order.
 *
 * Matches `encode_vendor_opcode(135664) → 0xF0 0x11 0x02` from the Python tool.
 */
export const VENDOR_OPCODE: Readonly<Uint8Array> = Uint8Array.of(0xf0, 0x11, 0x02);

/** Numeric form of the vendor opcode (`0x00F011`-family, encoded as 135664). */
export const VENDOR_OPCODE_INT = 135664;

const V2_PAYLOAD_LENGTH = 8;
const V2_MAX_DATA_BYTES = 5;
const PAD_BYTE = 0xff;

/**
 * Build an 8-byte Godox V2 payload from its raw fields.
 *
 * Data shorter than 5 bytes is padded with 0xFF, then a CRC-8 of the resulting
 * 7-byte header (model + padded data + end_byte) is appended.
 */
const buildV2Command = (model: number, endByte: number, data: readonly number[]): Uint8Array => {
  if (data.length > V2_MAX_DATA_BYTES) {
    throw new RangeError("V2 command data must be at most 5 bytes");
  }
  const out = new Uint8Array(V2_PAYLOAD_LENGTH);
  out[0] = model & 0xff;
  for (let i = 0; i < V2_MAX_DATA_BYTES; i++) {
    out[1 + i] = i < data.length ? data[i]! & 0xff : PAD_BYTE;
  }
  out[6] = endByte & 0xff;
  out[7] = crc8(out.subarray(0, 7));
  return out;
};

/**
 * Encode an arbitrary Godox V2 payload.
 *
 * This is intended for protocol exploration: callers provide the raw model
 * byte, up to five data bytes, and the end byte. The encoder still applies
 * the normal 0xff padding and trailing Godox CRC-8.
 */
export const encodeRawV2 = (model: number, endByte: number, data: readonly number[]): Uint8Array =>
  buildV2Command(model, endByte, data);

const validateBrightness = (value: number): void => {
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new RangeError("brightness must be between 0 and 100");
  }
};

const validateCct = (value: number): void => {
  if (!Number.isInteger(value) || value < 2800 || value > 6500) {
    throw new RangeError("CCT must be between 2800K and 6500K");
  }
};

/**
 * Encode a brightness + CCT command for a Godox TL30 light.
 *
 * @param brightness Brightness percentage in `[0, 100]`. May be fractional; the
 *   integer part becomes the `percent` byte and the first decimal (0-9) is sent
 *   as the V2 `end_byte` (brightness_point).
 * @param kelvin     Color temperature in `[2800, 6500]` Kelvin.
 */
export const encodeSet = (brightness: number, kelvin: number): Uint8Array => {
  validateBrightness(brightness);
  validateCct(kelvin);

  const percent = Math.trunc(brightness);
  // brightness_point: first decimal digit of brightness, clamped to 0..9.
  // Matches `int(round((final_brightness - percent) * 10))` from cli.py.
  const brightnessPoint = Math.min(9, Math.max(0, Math.round((brightness - percent) * 10)));
  const temp = Math.trunc(kelvin / 100);

  // Captured app traffic: 0xF0 family, end_byte=brightness_point,
  // data=[percent, temp, 50 (gm), 0 (gm2), 0].
  return buildV2Command(0xf0, brightnessPoint, [percent, temp, 50, 0, 0]);
};

const validateHue = (value: number): void => {
  if (!Number.isFinite(value) || value < 0 || value > 360) {
    throw new RangeError("hue must be between 0 and 360");
  }
};

const validateSaturation = (value: number): void => {
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new RangeError("saturation must be between 0 and 100");
  }
};

const validateByte = (value: number, label: string): void => {
  if (!Number.isInteger(value) || value < 0 || value > 255) {
    throw new RangeError(`${label} must be between 0 and 255`);
  }
};

/**
 * Encode an HSI command for a Godox TL30 light.
 *
 * Reverse-engineered from Godox Bluetooth Mesh traffic:
 * model `0xf1`, data `[brightness, hueLow, hueHigh, saturation, 0]`, end byte `0`.
 * Hue is sent as little-endian degrees. This differs from DMX profiles that map
 * hue onto one 0..255 channel.
 */
export const encodeHsi = (brightness: number, hue: number, saturation: number): Uint8Array => {
  validateBrightness(brightness);
  validateHue(hue);
  validateSaturation(saturation);

  const percent = Math.round(brightness);
  const hueDegrees = Math.round(hue);
  const sat = Math.round(saturation);

  return buildV2Command(0xf1, 0x00, [percent, hueDegrees & 0xff, hueDegrees >> 8, sat, 0]);
};

/**
 * Encode an RGBW command for a Godox TL30 light.
 *
 * Reverse-engineered from Godox Bluetooth Mesh traffic:
 * model `0xf2`, data `[brightness, red, green, blue, white]`, end byte `0`.
 */
export const encodeRgbw = (
  brightness: number,
  red: number,
  green: number,
  blue: number,
  white: number,
): Uint8Array => {
  validateBrightness(brightness);
  validateByte(red, "red");
  validateByte(green, "green");
  validateByte(blue, "blue");
  validateByte(white, "white");

  return buildV2Command(0xf2, 0x00, [Math.round(brightness), red, green, blue, white]);
};

/**
 * Encode an FX command for a Godox TL30 light.
 *
 * Reverse-engineered from Godox Bluetooth Mesh traffic:
 * model `0xf3`, data `[brightness, effect, level, filter, 0]`, end byte `0`.
 * Byte 2 changes the level/speed for at least some effects; bytes 3/4 appear
 * effect-dependent and may be ignored by simpler effects.
 */
export const encodeFx = (
  brightness: number,
  effect: number,
  level: number,
  filter: number,
): Uint8Array => {
  validateBrightness(brightness);
  validateByte(effect, "effect");
  validateByte(level, "level");
  validateByte(filter, "filter");

  return buildV2Command(0xf3, 0x00, [Math.round(brightness), effect, level, filter, 0]);
};

/**
 * Encode an OFF command.
 *
 * Mirrors the Python CLI: model `0xFE`, end_byte `0xFF`, data `[0x01]`.
 */
export const encodeOff = (): Uint8Array => buildV2Command(0xfe, 0xff, [0x01]);

/**
 * Encode an ON command (companion to {@link encodeOff}).
 *
 * Model `0xFE`, end_byte `0xFF`, data `[0x00]`. Not currently exercised by the
 * captured fixtures but included for parity with the Python CLI.
 */
export const encodeOn = (): Uint8Array => buildV2Command(0xfe, 0xff, [0x00]);
