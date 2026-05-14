// Single tagged error covering every failure mode the BLE transport can hit:
// HCI not available / never powered on, peripheral not found during a scan,
// GATT service or characteristic discovery failed, write/notify failed, etc.
// Callers discriminate on the `message` field and (where useful) the inner
// `cause`.

import { Data } from "effect";

export class BleError extends Data.TaggedError("BleError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}
