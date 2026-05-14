// Lower Transport PDU — for unsegmented access messages this is just a
// 1-byte header prepended to the encrypted Upper Transport PDU.
//
// Header layout (Mesh Profile §3.5.2.1):
//   bit 7   : SEG (0 = unsegmented)
//   bit 6   : AKF (1 = AppKey-secured, 0 = DeviceKey-secured)
//   bits 5-0: AID (6-bit application key identifier, ignored when AKF=0)
//
// Segmentation is out of scope — Godox commands fit in one segment.

export interface UnsegmentedAccessHeader {
  readonly akf: 0 | 1;
  readonly aid: number;
}

export const encodeUnsegmentedAccess = (opts: {
  readonly akf: 0 | 1;
  readonly aid: number;
  readonly encryptedAccessPdu: Uint8Array;
}): Uint8Array => {
  const { akf, aid, encryptedAccessPdu } = opts;
  if (aid < 0 || aid > 0x3f) {
    throw new RangeError("aid must fit in 6 bits");
  }
  // SEG=0, AKF, AID
  const header = ((akf & 0x01) << 6) | (aid & 0x3f);
  const out = new Uint8Array(1 + encryptedAccessPdu.length);
  out[0] = header;
  out.set(encryptedAccessPdu, 1);
  return out;
};

export const decodeUnsegmentedAccess = (
  pdu: Uint8Array,
): { readonly header: UnsegmentedAccessHeader; readonly encryptedAccessPdu: Uint8Array } => {
  if (pdu.length < 1) throw new Error("lower transport PDU is empty");
  const header0 = pdu[0]!;
  if ((header0 & 0x80) !== 0) {
    throw new Error("segmented lower transport PDUs are not supported");
  }
  return {
    header: {
      akf: ((header0 >>> 6) & 0x01) as 0 | 1,
      aid: header0 & 0x3f,
    },
    encryptedAccessPdu: pdu.slice(1),
  };
};
