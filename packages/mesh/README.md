# @godox-tl/mesh

Native Node.js Bluetooth SIG Mesh client for Godox TL30 BLE control. Speaks the
encrypted Telink SIG Mesh stack the Godox Light app uses (vendor opcode
0x00F011, V2 payload) directly from JavaScript — no Python runtime required.

Part of the [godox-tl monorepo](https://github.com/TheAlexLichter/godox-tl).

## Credit

This package builds on the reverse-engineering work in
[`mattharrison/godox-ul60bi-bt`](https://github.com/mattharrison/godox-ul60bi-bt)
(MIT license). The initial Bluetooth Mesh framing, Godox vendor opcode,
V2 payload shape, CRC-8 polynomial, provisioning flow, and config/rebind
sequence were derived from that project and cross-checked against its captured
wire output.

This TypeScript implementation is not a one-to-one package port. It includes
the native noble transport, Effect-based resource/error handling,
Homebridge/CLI-oriented controller behavior, persistent writer reuse,
queued/coalesced sends, state-file helpers, auto-provision integration, and
additional command encoders used by this repo.

Pure-function modules (crypto, PDU codecs, V2 payload) are validated against
captured wire bytes from the Python tool's `--dry-run` mode — see
`tests/fixtures/`. 31 byte-exact round-trips assert that the two
implementations produce identical encrypted PDUs given the same inputs.

## Install

```bash
vp install
# or, externally:
vp add @godox-tl/mesh @godox-tl/core
# pnpm equivalent:
pnpm add @godox-tl/mesh @godox-tl/core
```

Native deps:
[`@stoprocent/noble`](https://www.npmjs.com/package/@stoprocent/noble) (BLE HCI
on Linux/macOS), [`@noble/ciphers`](https://www.npmjs.com/package/@noble/ciphers)
and [`@noble/curves`](https://www.npmjs.com/package/@noble/curves) for AES / ECDH.
macOS prompts for Bluetooth permission the first time you run a
provisioning/connect operation.

## What's in here

- **Crypto** (`crypto/`) — AES-CCM, AES-CMAC (RFC 4493), Mesh §3.8 KDFs
  (s1 / k1 / k2 / k3 / k4), P-256 ECDH, Godox CRC-8, nonce builders.
- **PDU codecs** (`pdu/`) — Provisioning PDU, Network, Lower/Upper
  Transport, Access, Proxy. End-to-end `encodeGodoxFrame` for the AppKey
  path and `encodeDeviceKeyFrame` for Config Server messages.
- **BLE transport** (`ble/`) — noble wrapper for scan + Mesh Proxy Service
  (`0x1828`) + Mesh Provisioning Service (`0x1827`). `connectProxy` and
  `connectProvisioning` return Scope-managed `ProxyConnection` handles.
- **Provisioning state machine** (`provisioning/`) — PB-GATT Invite →
  Capabilities → Start → PublicKey → Confirmation → Random → Data →
  Complete. Returns a `ProvisioningResult` with NetKey / AppKey /
  DeviceKey / unicast address.
- **ConfigSession** (`config/`) — Config App Key Add + Config Model App
  Bind, DeviceKey-secured. The "rebind" step that makes a freshly
  provisioned light actually accept commands.
- **Godox V2 payload** (`godox/`) — CCT, HSI, RGBW, FX, and off frame
  builders with the trailing CRC-8.
- **Higher-level helpers** — `provisionAndRebind(address, opts)` one-shot,
  `makeMeshController(opts)` for direct send, `loadMeshState` /
  `saveMeshState` for the on-disk JSON format (compatible with the Python
  tool's `mesh_state.json`).

## Examples

### Promise-style use

The public helpers return Effect values, but non-Effect applications can run
them at the boundary with `Effect.runPromise`.

```ts
import { Domain } from "@godox-tl/core";
import { makeMeshController, provisionAndRebind } from "@godox-tl/mesh";
import { Effect } from "effect";

// First-time setup against a factory-reset light:
await Effect.runPromise(
  Effect.scoped(
    provisionAndRebind("83E72030-EF94-6299-21DD-372408DE38C2", {
      statePath: "./light.json",
    }),
  ),
);

// Subsequent control:
const light = makeMeshController({
  address: "83E72030-EF94-6299-21DD-372408DE38C2",
  statePath: "./light.json",
});
await Effect.runPromise(
  light.send(
    Domain.Cct.make({
      brightness: Domain.pct(40),
      temperature: Domain.kelvin(4000),
    }),
  ),
);
```

### Effect-style use

For larger Effect applications, provide the `LightController` service as a
Layer.

```ts
import { Domain, LightController } from "@godox-tl/core";
import { makeNodeMeshLayer } from "@godox-tl/mesh";
import { Effect } from "effect";

const program = Effect.gen(function* () {
  const light = yield* LightController;
  yield* light.send(
    Domain.Cct.make({
      brightness: Domain.pct(40),
      temperature: Domain.kelvin(4000),
    }),
  );
}).pipe(
  Effect.provide(
    makeNodeMeshLayer({
      address: "83E72030-EF94-6299-21DD-372408DE38C2",
      statePath: "./light.json",
    }),
  ),
);

await Effect.runPromise(program);
```

## Tests

```bash
vp test -F @godox-tl/mesh
```

Crypto vectors come from Mesh Profile §8.1.1 and RFC 4493; PDU round-trips
replay 31 captured fixtures from the Python tool. Hardware-bound tests are
gated by `MESH_HARDWARE_AVAILABLE=1` and skipped by default.

## License

MIT. Includes protocol work derived from
[`mattharrison/godox-ul60bi-bt`](https://github.com/mattharrison/godox-ul60bi-bt),
also MIT.
