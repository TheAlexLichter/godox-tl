# Upgrading to 2.0

All four packages now use version 2.0.0. The major version reflects the move
from Effect 3 to Effect 4 in the public library API.

## Homebridge and CLI users

Update `homebridge-godox-tl` or `@godox-tl/cli` to 2.0.0 and restart Homebridge
after updating the plugin. The CLI subcommands and Homebridge platform alias
(`GodoxTL`) are unchanged. The plugin still supports Node 22 or 24 and
Homebridge 1.8 or 2.x.

Existing valid registry and mesh state JSON files remain readable. Loading and
saving now validate these files and report invalid fields instead of accepting
malformed data. A version upgrade alone does not require re-provisioning lights.

Mesh sequence counters are now persisted in a shared directory. If Homebridge
and the CLI control the same mesh, use the same registry and state files on the
same host, with write access to the state files and shared sequence directory.
See the [Homebridge setup](./packages/homebridge/README.md#quick-start).

## Library users

Upgrade the Godox packages and Effect together:

```bash
vp add @godox-tl/core@2 @godox-tl/mesh@2 effect@~4.1.2
```

The exported effects, schemas, layers, and `LightController` service use Effect 4
and cannot be composed with Effect 3 values. Update application code to the
Effect 4 APIs; `LightController` is now a `Context.Service`.

`makeNodeMeshLayer` now closes its controller when its layer scope ends.
Prefer `makeMeshControllerScoped` inside `Effect.scoped` for direct use.
`makeMeshController` is still available; call its new `close()` effect when
finished. See the [controller examples](./packages/mesh/README.md#examples).

## Included fixes

- More reliable power transitions and retries on fresh BLE connections.
- Shared sequence reservations across CLI and Homebridge processes.
- Cancellable queued commands and bounded shutdown cleanup.
- HomeKit transport failures reported to the caller, plus correlated command logs.
- TL30 color temperatures down to 2700K.
