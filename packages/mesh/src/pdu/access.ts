// Access PDU encoder — topmost mesh layer below the application payload.
//
// An Access PDU is just `opcode || payload`. For Godox, the opcode is the
// 3-byte vendor opcode in Telink little-endian order (see Python
// `encode_vendor_opcode` in godox_ul60bi_bt/crypto.py).

export const encodeAccessPdu = (opts: {
  readonly opcode: Uint8Array;
  readonly payload: Uint8Array;
}): Uint8Array => {
  const { opcode, payload } = opts;
  const out = new Uint8Array(opcode.length + payload.length);
  out.set(opcode, 0);
  out.set(payload, opcode.length);
  return out;
};

/**
 * Encode a 24-bit Godox / Telink vendor opcode as 3 bytes in little-endian
 * order. The Python tool stores the opcode as a decimal int (e.g. 135664 =
 * 0x21170, which becomes bytes f0 11 02 — note `02 11` is the Telink CID).
 */
export const encodeVendorOpcode = (opcode: number): Uint8Array => {
  if (opcode < 0 || opcode > 0xff_ff_ff) {
    throw new RangeError("vendor opcode must fit in 24 bits");
  }
  return new Uint8Array([opcode & 0xff, (opcode >>> 8) & 0xff, (opcode >>> 16) & 0xff]);
};
