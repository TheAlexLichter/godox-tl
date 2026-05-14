// Mesh Proxy PDU framing — what we actually write to the Mesh Proxy data-in
// characteristic (0x2ADD on GATT service 0x1828).
//
// Wire layout:
//   byte 0: (SAR << 6) | MessageType
//     SAR: 0=complete, 1=first segment, 2=continuation, 3=last segment
//     MessageType: 0=Network PDU, 1=Mesh Beacon, 2=Proxy Configuration, 3=Provisioning
//   bytes 1..: payload
//
// For our Godox control path we only emit SAR=0, MessageType=0 (complete
// network PDU), so the first byte is 0x00.

export const encodeProxyPdu = (opts: {
  readonly sar: number;
  readonly messageType: number;
  readonly payload: Uint8Array;
}): Uint8Array => {
  const { sar, messageType, payload } = opts;
  if (sar < 0 || sar > 0x03) throw new RangeError("sar must fit in 2 bits");
  if (messageType < 0 || messageType > 0x3f) {
    throw new RangeError("messageType must fit in 6 bits");
  }
  const out = new Uint8Array(1 + payload.length);
  out[0] = ((sar & 0x03) << 6) | (messageType & 0x3f);
  out.set(payload, 1);
  return out;
};

export const decodeProxyPdu = (
  pdu: Uint8Array,
): { readonly sar: number; readonly messageType: number; readonly payload: Uint8Array } => {
  if (pdu.length < 1) throw new Error("proxy PDU is empty");
  const h = pdu[0]!;
  return {
    sar: (h >>> 6) & 0x03,
    messageType: h & 0x3f,
    payload: pdu.slice(1),
  };
};
