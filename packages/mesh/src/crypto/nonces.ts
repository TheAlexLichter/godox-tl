// Bluetooth Mesh nonce builders per Mesh Profile v1.0.1 §3.8.5.
//
// All nonces are 13 bytes and start with a one-byte type discriminator:
//   0x00 — Network Nonce
//   0x01 — Application Nonce
//   0x02 — Device Nonce
//   0x03 — Proxy Nonce
//
// Multi-byte fields (SEQ, SRC, DST, IVIndex) are big-endian.

const NONCE_LEN = 13;

const writeUintBE = (buf: Uint8Array, value: number, offset: number, bytes: number): void => {
  for (let i = bytes - 1; i >= 0; i--) {
    buf[offset + i] = value & 0xff;
    value = Math.floor(value / 256);
  }
};

const checkSeq = (seq: number): void => {
  if (!Number.isInteger(seq) || seq < 0 || seq > 0xffffff) {
    throw new RangeError(`SEQ must fit in 24 bits, got ${seq}`);
  }
};

const checkAddr = (label: string, addr: number): void => {
  if (!Number.isInteger(addr) || addr < 0 || addr > 0xffff) {
    throw new RangeError(`${label} must fit in 16 bits, got ${addr}`);
  }
};

const checkIv = (iv: number): void => {
  if (!Number.isInteger(iv) || iv < 0 || iv > 0xffffffff) {
    throw new RangeError(`IVIndex must fit in 32 bits, got ${iv}`);
  }
};

export interface NetworkNonceInput {
  readonly ctl: number; // 0 or 1
  readonly ttl: number; // 0..127
  readonly seq: number; // 24-bit
  readonly src: number; // 16-bit unicast address
  readonly ivIndex: number; // 32-bit IV index
}

/**
 * Type 0x00 — Network Nonce.
 * Layout: 0x00 || (CTL<<7 | TTL) || SEQ(3) || SRC(2) || 0x0000 || IVIndex(4)
 */
export const networkNonce = ({ ctl, ttl, seq, src, ivIndex }: NetworkNonceInput): Uint8Array => {
  if (ctl !== 0 && ctl !== 1) throw new RangeError(`CTL must be 0 or 1, got ${ctl}`);
  if (!Number.isInteger(ttl) || ttl < 0 || ttl > 0x7f) {
    throw new RangeError(`TTL must fit in 7 bits, got ${ttl}`);
  }
  checkSeq(seq);
  checkAddr("SRC", src);
  checkIv(ivIndex);

  const out = new Uint8Array(NONCE_LEN);
  out[0] = 0x00;
  out[1] = ((ctl & 0x01) << 7) | (ttl & 0x7f);
  writeUintBE(out, seq, 2, 3);
  writeUintBE(out, src, 5, 2);
  // out[7] / out[8] already zero
  writeUintBE(out, ivIndex, 9, 4);
  return out;
};

export interface ApplicationNonceInput {
  readonly aszmic: number; // 0 or 1
  readonly seq: number;
  readonly src: number;
  readonly dst: number;
  readonly ivIndex: number;
}

/**
 * Type 0x01 — Application Nonce.
 * Layout: 0x01 || (ASZMIC<<7) || SEQ(3) || SRC(2) || DST(2) || IVIndex(4)
 */
export const applicationNonce = ({
  aszmic,
  seq,
  src,
  dst,
  ivIndex,
}: ApplicationNonceInput): Uint8Array => {
  if (aszmic !== 0 && aszmic !== 1) {
    throw new RangeError(`ASZMIC must be 0 or 1, got ${aszmic}`);
  }
  checkSeq(seq);
  checkAddr("SRC", src);
  checkAddr("DST", dst);
  checkIv(ivIndex);

  const out = new Uint8Array(NONCE_LEN);
  out[0] = 0x01;
  out[1] = (aszmic & 0x01) << 7;
  writeUintBE(out, seq, 2, 3);
  writeUintBE(out, src, 5, 2);
  writeUintBE(out, dst, 7, 2);
  writeUintBE(out, ivIndex, 9, 4);
  return out;
};

export interface DeviceNonceInput {
  readonly aszmic: number;
  readonly seq: number;
  readonly src: number;
  readonly dst: number;
  readonly ivIndex: number;
}

/**
 * Type 0x02 — Device Nonce.
 * Layout: 0x02 || (ASZMIC<<7) || SEQ(3) || SRC(2) || DST(2) || IVIndex(4)
 */
export const deviceNonce = ({ aszmic, seq, src, dst, ivIndex }: DeviceNonceInput): Uint8Array => {
  if (aszmic !== 0 && aszmic !== 1) {
    throw new RangeError(`ASZMIC must be 0 or 1, got ${aszmic}`);
  }
  checkSeq(seq);
  checkAddr("SRC", src);
  checkAddr("DST", dst);
  checkIv(ivIndex);

  const out = new Uint8Array(NONCE_LEN);
  out[0] = 0x02;
  out[1] = (aszmic & 0x01) << 7;
  writeUintBE(out, seq, 2, 3);
  writeUintBE(out, src, 5, 2);
  writeUintBE(out, dst, 7, 2);
  writeUintBE(out, ivIndex, 9, 4);
  return out;
};

export interface ProxyNonceInput {
  readonly seq: number;
  readonly src: number;
  readonly ivIndex: number;
}

/**
 * Type 0x03 — Proxy Nonce.
 * Layout: 0x03 || 0x00 || SEQ(3) || SRC(2) || 0x0000 || IVIndex(4)
 */
export const proxyNonce = ({ seq, src, ivIndex }: ProxyNonceInput): Uint8Array => {
  checkSeq(seq);
  checkAddr("SRC", src);
  checkIv(ivIndex);

  const out = new Uint8Array(NONCE_LEN);
  out[0] = 0x03;
  out[1] = 0x00;
  writeUintBE(out, seq, 2, 3);
  writeUintBE(out, src, 5, 2);
  // pad zeros at 7..8
  writeUintBE(out, ivIndex, 9, 4);
  return out;
};
