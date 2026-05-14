// Upper Transport PDU — applies AES-CCM with the AppKey (or DeviceKey) to
// the Access PDU produced by `access.ts`. For our Godox use case, we always
// produce unsegmented messages with a 4-byte transport MIC (szmic=0).

import { aesCcmDecrypt, aesCcmEncrypt } from "../crypto/aes.ts";

const micLenForSzmic = (szmic: 0 | 1): 4 | 8 => (szmic === 0 ? 4 : 8);

/**
 * Encrypt an Access PDU into an Upper Transport ciphertext+MIC.
 *
 * The caller is responsible for computing the correct nonce (application
 * nonce when using an AppKey, device nonce when using the DeviceKey).
 */
export const encryptAccessPdu = (opts: {
  readonly accessPdu: Uint8Array;
  readonly appKey: Uint8Array;
  readonly nonce: Uint8Array;
  readonly szmic: 0 | 1;
}): Uint8Array => {
  const { accessPdu, appKey, nonce, szmic } = opts;
  return aesCcmEncrypt(appKey, nonce, accessPdu, micLenForSzmic(szmic));
};

export const decryptAccessPdu = (opts: {
  readonly encryptedAccessPdu: Uint8Array;
  readonly appKey: Uint8Array;
  readonly nonce: Uint8Array;
  readonly szmic: 0 | 1;
}): Uint8Array => {
  const { encryptedAccessPdu, appKey, nonce, szmic } = opts;
  return aesCcmDecrypt(appKey, nonce, encryptedAccessPdu, micLenForSzmic(szmic));
};
