// Tagged errors raised by the PB-GATT provisioning bearer and the
// `ProvisioningSession` state machine. Callers discriminate on `_tag` plus
// the structured `stage` / `expected` / `actual` fields.

import { Data } from "effect";

/**
 * Anything that goes wrong during the provisioning exchange that is not
 * a confirmation mismatch (which gets its own tag so callers can react
 * to "device authenticated incorrectly" separately from generic timeouts
 * / unexpected PDU types).
 */
export class ProvisioningError extends Data.TaggedError("ProvisioningError")<{
  readonly stage:
    | "invite"
    | "capabilities"
    | "start"
    | "publicKey"
    | "confirmation"
    | "random"
    | "data"
    | "complete";
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * The device's Confirmation PDU did not match the value we re-computed
 * from its Random. Either the device authenticated incorrectly or our
 * key derivation went off the rails — either way we must abort.
 */
export class ConfirmationMismatchError extends Data.TaggedError("ConfirmationMismatchError")<{
  readonly expected: string;
  readonly actual: string;
}> {}
