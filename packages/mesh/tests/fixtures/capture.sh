#!/usr/bin/env bash
# Capture wire-byte fixtures for the @godox-tl/mesh port.
#
# Uses the upstream Python tool's `--dry-run` mode (no BLE traffic) with a
# pinned mesh state + explicit sequence numbers so output is fully
# deterministic. The captured JSON for each input has:
#   - inputs: ble_device, mesh_src, mesh_dst, proxy_config_sequences, sequence, iv_index, vendor_opcode
#   - outputs: godox_v2_payload_hex (Godox V2 frame), proxy_pdu_hex (final encrypted PDU)
#
# Pair these with state-sample.json (the mesh state at capture time — contains
# network_key, app_key, device_key, etc.) to fully reproduce the encryption
# pipeline from plain inputs.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE="$DIR/state-sample.json"
DEVICE="83E72030-EF94-6299-21DD-372408DE38C2"
SEQ=100

mkdir -p "$DIR/set" "$DIR/off"

for brightness in 0 10 25 50 75 100; do
  for cct in 2800 3200 4500 5600 6500; do
    out="$DIR/set/b${brightness}-c${cct}-seq${SEQ}.json"
    godox-ul60bi set \
      --brightness "$brightness" --cct "$cct" \
      --device "$DEVICE" --state "$STATE" \
      --sequence-number "$SEQ" --iv-index 0 \
      --dry-run > "$out"
    SEQ=$((SEQ + 10))
  done
done

godox-ul60bi off \
  --device "$DEVICE" --state "$STATE" \
  --sequence-number 9000 --iv-index 0 \
  --dry-run > "$DIR/off/seq9000.json"

echo "Captured fixtures under $DIR/{set,off}/"
