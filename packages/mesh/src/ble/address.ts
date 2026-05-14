// BLE address normalization utilities.
//
// On macOS, noble reports CoreBluetooth UUIDs **without separators**
// (`83e72030ef94629921dd372408de38c2`) while the rest of our codebase
// (registries and user-facing CLIs) may carry the dashed form
// (`83E72030-EF94-6299-21DD-372408DE38C2`). Linux addresses usually use
// MAC-style colons. Whenever we compare addresses across those surfaces we
// strip every non-hex character and lowercase — both inputs go through the
// same normalizer, so any format pair matches if and only if it refers to the
// same device.

import type { PeripheralLike } from "./noble.ts";

/** Strip BLE-address punctuation and lowercase. */
export const normalizeAddress = (s: string | undefined | null): string =>
  (s ?? "").toLowerCase().replace(/[^0-9a-f]/g, "");

/** True iff `target` matches any of the peripheral's identifier fields under
 * `normalizeAddress`. An empty / undefined target never matches. */
export const matchAddress = (peripheral: PeripheralLike, target: string): boolean => {
  const normalized = normalizeAddress(target);
  if (!normalized) return false;
  return (
    normalizeAddress(peripheral.address) === normalized ||
    normalizeAddress(peripheral.uuid) === normalized ||
    normalizeAddress(peripheral.id) === normalized
  );
};
