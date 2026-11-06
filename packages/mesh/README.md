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

Light-control sends retry a BLE failure once on a fresh connection, within the
same `sendTimeoutMs` attempt deadline. The retry reserves fresh sequence numbers.
Failure cleanup can take up to six additional seconds for two bounded disconnect
attempts. Replacement connections wait for cleanup to succeed, including cleanup
started by an idle timer, so a late disconnect cannot close a replacement link.
If cleanup fails, the retired writer remains fenced until a later cleanup succeeds.
Disconnected cached writers are replaced before sending; state-file failures
are reported directly without retrying the Bluetooth connection.

Power changes are sent twice. Cold connections, soft-off restores, and sends
after another controller used the shared source send power-on twice before
restoring settings; uninterrupted warm updates send only settings. This tracks
our command history, not confirmed hardware state: physical buttons and apps
using an independent sequence store are not observed.

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
await Effect.runPromise(light.close());
```

Call `light.close()` when a direct controller is no longer needed. It rejects
queued and future sends, interrupts active work, and waits for the existing
bounded disconnect cleanup without sending lighting commands.

`makeMeshControllerScoped(options)` registers this cleanup in the caller's
Effect scope. `makeNodeMeshLayer` also closes its controller when the layer's
scope ends. Homebridge disposes controllers and cancels pending debounces and
discovery during shutdown.

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

## Shared mesh sequence counters

Sequence numbers belong to a network/source pair, not an individual light.
Control and config/rebind messages reserve from the same durable counter before
writing BLE data, and hold a process lock through transmission. A crash consumes
its reserved range; it never makes that range available again.

Homebridge defaults to `sequences/` beside its registry. Other callers default
to `$GODOX_TL_SEQUENCE_DIRECTORY` or `~/.config/godox-tl/sequences` (respecting
`XDG_CONFIG_HOME`). Set `sequenceDirectory` explicitly for isolated tests and
dry runs. State files gain an optional `sequence_directory` field, and adjacent
store pointers let CLI and Homebridge converge even on simultaneous first use.
Existing state JSON fields remain compatible.

Legacy migration takes the highest counter from registered states and sibling
JSON state files with the same network/source. Library callers with states in
other directories should supply every known `statePaths` entry, or explicitly
share one sequence directory across all controllers. Never delete or restore
an older sequence store: the lights may have already accepted higher numbers.

To move a store, stop all controllers, then make one reservation with the new
`sequenceDirectory` and `migrateSequenceDirectory: true`, supplying all known
state paths. Keep the old store until migration succeeds. Preserve the counter store
and selected absolute paths when moving to another host, or migrate after copying. Locks support processes
on one host using a local filesystem; network filesystems require a distributed
lock. Live owners are never expired, and lock acquisition fails after 10 seconds
by default (`lockTimeoutMs`) or when the enclosing Effect is interrupted.

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

### Cancelling queued commands

Controller sends use a scoped Effect mailbox. Cancelling a queued caller removes
its request before it reserves sequences or writes BLE data. Coalescing selects
the newest remaining caller and preserves that caller's logging context.
Cancelling the last waiter for an active command interrupts it and waits for its
cleanup before another command runs; this cannot undo writes already accepted
by the native Bluetooth stack. Closing the controller settles queued callers and
joins the active cleanup. Idle workers exit rather than keeping CLI processes alive.
