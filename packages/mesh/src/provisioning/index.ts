// Public surface of the @godox-tl/mesh provisioning module — milestone 4.

export { ConfirmationMismatchError, ProvisioningError } from "./errors.ts";
export { DEFAULT_PB_GATT_MTU, decodeProvisioningPdu, encodeProvisioningPdu } from "./pbGatt.ts";
export {
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
  PDU_DATA,
  PDU_FAILED,
  PDU_INPUT_COMPLETE,
  PDU_INVITE,
  PDU_PUBLIC_KEY,
  PDU_RANDOM,
  PDU_START,
} from "./pdus.ts";
export type { ProvisioningCapabilities } from "./pdus.ts";
export {
  buildConfirmationInputs,
  buildProvisioningDataPlaintext,
  computeConfirmation,
  provisionLight,
  runProvisioning,
} from "./session.ts";
export type { ProvisioningResult, ProvisionLightOptions } from "./session.ts";
