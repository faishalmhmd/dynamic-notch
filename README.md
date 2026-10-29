# Dynamic Notch

A top-center notch for GNOME Shell that gives you quick access to everyday features in one compact, native-looking place. It sits in the panel as a small pill with a clock and expands into a flat, tabbed island when you need it.

> Target: **GNOME Shell 51**

## Features

### Tab 1: Overview
- **Compact calendar**: a small, dense calendar right in the notch.
- **Notification list**: GNOME notifications are mirrored into the island. Stock banners are replaced by a short island peek plus a list you can review anytime.
- **Running apps**: icons of open applications for quick switching.
- **Activities button**: jump to the Overview in one click.

### Tab 2: Timer
- A minimal timer that sizes the panel to its own content.

### General
- Icon-only quick actions, with no cards or tiles.
- Flat layout that matches the native GNOME look.
- Configurable panel background.
- Smooth transitions when entering and leaving the Overview.

## Roadmap

- [ ] Clipboard history
- [ ] More quick-access features

Ideas and requests are welcome in the [issues](https://github.com/faishalmhmd/dynamic-notch/issues).

## Installation

### From source

```bash
git clone https://github.com/faishalmhmd/dynamic-notch.git
cd dynamic-notch
make install
gnome-extensions enable dynamic-notch@faishalmhmd
```

Then log out and back in (Wayland) so GNOME Shell picks up the extension.

### From extensions.gnome.org

Coming soon.

## Development

| Command | Description |
|---|---|
| `make install` | Copy the extension to `~/.local/share/gnome-shell/extensions/` and compile the schemas |
| `make debug` | Run it in a nested GNOME Shell session |
| `make compile-schema` | Compile the GSettings schemas |
| `make uninstall` | Remove the installed extension |

Watch the logs while testing:

```bash
journalctl -f -o cat /usr/bin/gnome-shell
```

## Settings

Settings use the schema `org.gnome.shell.extensions.dynamic-notch`. You can inspect or change them with `dconf-editor` or `gsettings`.

## License

Add your license here (e.g. GPL-3.0-or-later, which is the usual choice for GNOME extensions).
