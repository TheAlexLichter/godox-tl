# homebridge-godox-tl

[Homebridge](https://homebridge.io/) plugin for Godox TL30 BLE control. Exposes
each registered light as a HomeKit `Lightbulb` accessory with brightness,
color-temperature, and HomeKit color controls, controllable from the Home app
on iOS / macOS / via Siri.

Part of the [godox-tl monorepo](https://github.com/TheAlexLichter/godox-tl).

## Highlights

- **Native JS runtime**: uses [`@godox-tl/mesh`](../mesh/README.md), a
  native Node implementation of the Godox BLE SIG Mesh stack. Installs and
  runs on a Raspberry Pi via `vp add -g homebridge-godox-tl` (or
  `pnpm add -g homebridge-godox-tl`).
- **Registry-first discovery**: reads `~/.config/godox-tl/registry.json`
  at startup and exposes each entry. Provision new lights from the CLI
  (`godox provision <addr> --name <name>`) and the plugin picks them up
  on its next scan cycle.
- **Auto-provision**: periodic BLE scan finds factory-reset Godox lights
  (configurable name-regex filter, default `^GD_LED$`), provisions them
  automatically, registers them, and adds them as HomeKit accessories
  without manual intervention.
- **Debounced writes**: HomeKit slider drags coalesce into one BLE write
  every 100 ms so the mesh isn't flooded.
- **Color + preset modes**: HomeKit Hue/Saturation drives the decoded
  Godox HSI command. Optional momentary switches can trigger configured FX
  and RGBW presets.

## Install

```bash
vp add -g homebridge-godox-tl
# or: pnpm add -g homebridge-godox-tl
```

Then add to your Homebridge `config.json`:

```json
{
  "platforms": [
    {
      "platform": "GodoxTL",
      "name": "Godox TL",
      "autoProvision": false,
      "startupScan": true,
      "autoProvisionOnStartup": true,
      "discoveryFilters": ["^GD_LED$"],
      "scanIntervalSeconds": 60,
      "fxPresets": [{ "name": "Party", "effect": 2, "level": 1, "brightness": 80 }],
      "rgbwPresets": [{ "name": "Red", "red": 255, "brightness": 10 }]
    }
  ]
}
```

Restart Homebridge; lights appear in the Home app.

## Config

| Field                    | Default                            | Description                                                                                                    |
| ------------------------ | ---------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `name`                   | `"Godox TL"`                       | Bridge name in HomeKit.                                                                                        |
| `registryPath`           | `~/.config/godox-tl/registry.json` | Override the registry location.                                                                                |
| `discoveryMode`          | `"merge"`                          | `"registry"`, `"manual"`, or `"merge"` (registry + manual overrides by name).                                  |
| `autoProvision`          | `false`                            | Periodic scan + provision of unprovisioned matching lights. Enable during setup, then leave off for control.   |
| `startupScan`            | `true`                             | Run one BLE scan when Homebridge starts.                                                                       |
| `startupPruneMissing`    | `false`                            | Remove registry entries missed by the startup scan. Leave off for normal BLE use; short scans can miss lights. |
| `autoProvisionOnStartup` | `true`                             | Provision matching factory-reset lights during the startup scan even when periodic auto-provision is off.      |
| `scanIntervalSeconds`    | `60`                               | How often the discovery loop runs. Clamped to ≥10 s.                                                           |
| `discoveryFilters`       | `["^GD_LED$"]`                     | JS regex patterns matched against advertised name.                                                             |
| `nameTemplate`           | `"godox-{shortAddr}"`              | Name assigned to auto-provisioned lights. `{shortAddr}` expands to the last 6 hex chars of the BLE address.    |
| `enableColor`            | `true`                             | Adds HomeKit `Hue` + `Saturation` controls backed by Godox HSI mode.                                           |
| `fxPresets`              | `[]`                               | Optional momentary switch services: `{name, brightness?, effect, level?, subtype?, filter?}`.                  |
| `rgbwPresets`            | `[]`                               | Optional momentary switch services: `{name, brightness?, red?, green?, blue?, white?}`.                        |
| `lights`                 | `[]`                               | Manual entries `{name, address, statePath, nodeAddress?}`. Override-by-name when `discoveryMode` is `"merge"`. |

## Reset / Re-Provision Flow

Factory-resetting a TL30 invalidates its old mesh state file. Homebridge treats
that old provisioned address as stale unless the same address is still visible
in the startup BLE scan. With `autoProvision` enabled, the reset light should
appear as an unprovisioned scan candidate and be provisioned again. If Linux
reports the same BLE MAC after reset, Homebridge still treats
`unprovisioned=true` as a reprovision candidate even when that address is
already known.

The useful log lines are:

- `BLE scan complete: ... unprovisioned ...`: what the Pi can physically see
  right now. This is logged by default when at least one unprovisioned light is
  visible; routine scans with only provisioned lights stay at debug level.
- `Auto-provision candidates: ...`: reset lights that match
  `discoveryFilters` and will be provisioned or re-provisioned.
- `Loaded ... known light(s)`: registry/state entries exposed to HomeKit.

If a light is reset but still appears as `unprov=false`, it is not advertising
as factory-reset. If it does not appear in `BLE scan complete`, the Pi cannot
currently see it over BLE.

## HomeKit characteristics

`Service.Lightbulb` with:

- `On` (boolean)
- `Brightness` (0–100 %)
- `ColorTemperature` (mireds, range 154–357 ≈ 2800–6500 K)
- `Hue` (0–360°)
- `Saturation` (0–100 %)

State is held in the plugin process: `Get` handlers return the local
cache, never poll the mesh. Set handlers debounce 100 ms and emit one
command per flush. Color-temperature writes select CCT mode; Hue or
Saturation writes select HSI mode. After an FX/RGBW preset switch is used,
Brightness continues adjusting that selected mode until another mode is
selected.

FX and RGBW presets are exposed as separate `Service.Switch` services named
`FX: <name>` and `RGBW: <name>`. They are momentary controls: turning one on
sends the command and the switch resets to off.

## Permissions

On Linux, give Node the right to use raw BLE sockets:

```bash
sudo setcap cap_net_raw+eip $(eval readlink -f $(which node))
```

On macOS, the OS will prompt for Bluetooth access the first time
Homebridge runs. Approve it.

## Credit

The underlying mesh protocol implementation builds on reverse-engineering from
[`mattharrison/godox-ul60bi-bt`](https://github.com/mattharrison/godox-ul60bi-bt)
(MIT). See [`@godox-tl/mesh`](../mesh/README.md) for details.

## License

MIT.
