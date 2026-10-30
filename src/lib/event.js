// Provider event sistem: UPower, BlueZ, audio (Gvc), network (NM),
// sesi (logind/ScreenSaver/gsd), storage, desktop (GSettings), workspace.
// Semua sumber failure-isolated. Callback: onEvent({iconName, gicon, text}).

import Gio from "gi://Gio";

import * as Main from "resource:///org/gnome/shell/ui/main.js";

const UP_DEVICE_XML = `<node>
  <interface name="org.freedesktop.UPower.Device">
    <property name="Type" type="u" access="read"/>
    <property name="State" type="u" access="read"/>
    <property name="Percentage" type="d" access="read"/>
    <property name="WarningLevel" type="u" access="read"/>
    <property name="IconName" type="s" access="read"/>
    <property name="Model" type="s" access="read"/>
    <property name="PowerSupply" type="b" access="read"/>
  </interface>
</node>`;

const UP_XML = `<node>
  <interface name="org.freedesktop.UPower">
    <property name="OnBattery" type="b" access="read"/>
    <property name="LidIsClosed" type="b" access="read"/>
    <signal name="DeviceAdded"><arg type="o"/></signal>
  </interface>
</node>`;

const PROFILES_XML = `<node>
  <interface name="net.hadess.PowerProfiles">
    <property name="ActiveProfile" type="s" access="read"/>
  </interface>
</node>`;

const SCREENSAVER_XML = `<node>
  <interface name="org.gnome.ScreenSaver">
    <signal name="ActiveChanged"><arg type="b"/></signal>
  </interface>
</node>`;

const GSD_POWER_XML = `<node>
  <interface name="org.gnome.SettingsDaemon.Power.Screen">
    <property name="Brightness" type="i" access="read"/>
  </interface>
</node>`;

const TIMEDATE_XML = `<node>
  <interface name="org.freedesktop.timedate1">
    <property name="Timezone" type="s" access="read"/>
  </interface>
</node>`;

// Nilai satu properti dari variant a{sv}; undefined kalau tidak ada.
function _prop(dict, key) {
  const v = dict.lookup_value(key, null);
  return v ? v.deep_unpack() : undefined;
}

// Pasangan [keyVariant, valueVariant] dari variant dictionary.
function _dictEntries(dict) {
  const out = [];
  for (let i = 0; i < dict.n_children(); i++) {
    const e = dict.get_child_value(i);
    out.push([e.get_child_value(0), e.get_child_value(1)]);
  }
  return out;
}

export class SystemEventsProvider {
  // callbacks: onEvent({iconName, gicon, text})
  constructor(callbacks) {
    this._cb = callbacks;
    this._cleanups = [];
    this._destroyed = false;
  }

  start() {
    const starters = [
      "_startPower",
      "_startPowerProfiles",
      "_startBluetooth",
      "_startAudio",
      "_startNetwork",
      "_startSession",
      "_startStorage",
      "_startDesktop",
      "_startShell",
    ];
    for (const name of starters) {
      try {
        const r = this[name]();
        if (r && typeof r.catch === "function")
          r.catch((e) => logError(e, `dynamic-notch: ${name} failed`));
      } catch (e) {
        logError(e, `dynamic-notch: event source ${name} unavailable`);
      }
    }
  }

  destroy() {
    this._destroyed = true;
    for (const fn of this._cleanups) {
      try {
        fn();
      } catch (_e) {}
    }
    this._cleanups = [];
    this._cb = null;
  }

  _on(cleanup) {
    this._cleanups.push(cleanup);
  }

  _emit(iconName, text, gicon = null) {
    if (!this._destroyed) this._cb?.onEvent({ iconName, gicon, text });
  }

  // ------------------------------------------------------------- power

  _startPower() {
    const DeviceProxy = Gio.DBusProxy.makeProxyWrapper(UP_DEVICE_XML);
    this._DeviceProxy = DeviceProxy;
    this._power = new DeviceProxy(
      Gio.DBus.system,
      "org.freedesktop.UPower",
      "/org/freedesktop/UPower/devices/DisplayDevice",
      (p, err) => {
        if (err || this._destroyed) return;
        this._powerState = p.State;
        this._powerWarn = p.WarningLevel;
        const id = p.connect("g-properties-changed", () =>
          this._onPowerChanged(),
        );
        this._on(() => p.disconnect(id));
      },
    );
    const UpProxy = Gio.DBusProxy.makeProxyWrapper(UP_XML);
    this._upower = new UpProxy(
      Gio.DBus.system,
      "org.freedesktop.UPower",
      "/org/freedesktop/UPower",
      (p, err) => {
        if (err || this._destroyed) return;
        this._onBattery = p.OnBattery;
        this._lidClosed = p.LidIsClosed;
        const id = p.connect("g-properties-changed", () =>
          this._onUpowerChanged(),
        );
        this._on(() => p.disconnect(id));
        const addId = p.connectSignal("DeviceAdded", (_p, _s, [path]) =>
          this._onUpowerDeviceAdded(path),
        );
        this._on(() => p.disconnectSignal(addId));
      },
    );
    this._on(() => {
      this._power = null;
      this._upower = null;
    });
  }

  _onPowerChanged() {
    const p = this._power;
    if (!p) return;
    const pct = Math.round(p.Percentage ?? 0);
    const icon = p.IconName || "battery-good-symbolic";
    if (p.State !== this._powerState) {
      if (p.State === 4) this._emit(icon, `Fully charged · ${pct}%`);
      this._powerState = p.State;
    }
    if (p.WarningLevel !== this._powerWarn) {
      if (p.WarningLevel === 3) this._emit(icon, `Low battery · ${pct}%`);
      else if (p.WarningLevel >= 4)
        this._emit(icon, `Battery critical · ${pct}%`);
      this._powerWarn = p.WarningLevel;
    }
  }

  _onUpowerChanged() {
    const p = this._upower;
    if (!p) return;
    if (p.OnBattery !== this._onBattery) {
      this._onBattery = p.OnBattery;
      const pct = Math.round(this._power?.Percentage ?? 0);
      const icon = this._power?.IconName || "battery-good-symbolic";
      this._emit(
        icon,
        p.OnBattery ? `Charger unplugged · ${pct}%` : `Charging · ${pct}%`,
      );
    }
    if (p.LidIsClosed !== this._lidClosed) {
      this._lidClosed = p.LidIsClosed;
      this._emit(
        "computer-symbolic",
        p.LidIsClosed ? "Lid closed" : "Lid opened",
      );
    }
  }

  _onUpowerDeviceAdded(path) {
    if (path.includes("DisplayDevice")) return;
    new this._DeviceProxy(
      Gio.DBus.system,
      "org.freedesktop.UPower",
      path,
      (p, err) => {
        if (err || this._destroyed || !p) return;
        // Type 2 = battery, PowerSupply false = peripheral.
        if (p.Type === 2 && !p.PowerSupply)
          this._emit(
            p.IconName || "battery-good-symbolic",
            `${p.Model || "Wireless device"} connected`,
          );
      },
    );
  }

  _startPowerProfiles() {
    const Proxy = Gio.DBusProxy.makeProxyWrapper(PROFILES_XML);
    const labels = {
      "power-saver": "Power Saver",
      balanced: "Balanced",
      performance: "Performance",
    };
    const icons = {
      "power-saver": "power-profile-power-saver-symbolic",
      balanced: "power-profile-balanced-symbolic",
      performance: "power-profile-performance-symbolic",
    };
    this._profiles = new Proxy(
      Gio.DBus.system,
      "org.freedesktop.UPower",
      "/org/freedesktop/UPower/PowerProfiles",
      (p, err) => {
        if (err || this._destroyed) return;
        this._profile = p.ActiveProfile;
        const id = p.connect("g-properties-changed", () => {
          if (p.ActiveProfile === this._profile) return;
          this._profile = p.ActiveProfile;
          this._emit(
            icons[this._profile] ?? "power-profile-balanced-symbolic",
            `Power profile · ${labels[this._profile] ?? this._profile}`,
          );
        });
        this._on(() => p.disconnect(id));
      },
    );
    this._on(() => {
      this._profiles = null;
    });
  }

  // ---------------------------------------------------------- bluetooth

  _startBluetooth() {
    this._btDevices = new Map(); // path -> {name, connected, paired, battery}
    this._btAdapter = null;
    const conn = Gio.DBus.system;
    conn.call(
      "org.bluez",
      "/",
      "org.freedesktop.DBus.ObjectManager",
      "GetManagedObjects",
      null,
      null,
      Gio.DBusCallFlags.NONE,
      -1,
      null,
      (c, res) => {
        if (this._destroyed) return;
        try {
          const objects = c.call_finish(res).get_child_value(0);
          for (const [pathV, ifaces] of _dictEntries(objects))
            this._btSeed(pathV.deep_unpack(), ifaces);
        } catch (_e) {}
      },
    );
    const subProps = conn.signal_subscribe(
      "org.bluez",
      "org.freedesktop.DBus.Properties",
      "PropertiesChanged",
      null,
      null,
      Gio.DBusSignalFlags.NONE,
      (_c, _s, path, _i, _m, params) => {
        this._btProps(
          path,
          params.get_child_value(0).get_string(),
          params.get_child_value(1),
        );
      },
    );
    const subAdded = conn.signal_subscribe(
      "org.bluez",
      "org.freedesktop.DBus.ObjectManager",
      "InterfacesAdded",
      "/",
      null,
      Gio.DBusSignalFlags.NONE,
      (_c, _s, _p, _i, _m, params) => {
        this._btSeed(
          params.get_child_value(0).get_string(),
          params.get_child_value(1),
        );
      },
    );
    const subRemoved = conn.signal_subscribe(
      "org.bluez",
      "org.freedesktop.DBus.ObjectManager",
      "InterfacesRemoved",
      "/",
      null,
      Gio.DBusSignalFlags.NONE,
      (_c, _s, _p, _i, _m, params) => {
        this._btRemoved(
          params.get_child_value(0).get_string(),
          params.get_child_value(1).get_strv(),
        );
      },
    );
    this._on(() => {
      conn.signal_unsubscribe(subProps);
      conn.signal_unsubscribe(subAdded);
      conn.signal_unsubscribe(subRemoved);
      this._btDevices.clear();
    });
  }

  _btSeed(path, ifaces) {
    for (const [nameV, props] of _dictEntries(ifaces)) {
      const name = nameV.deep_unpack();
      if (name === "org.bluez.Device1") {
        this._btDevices.set(path, {
          name:
            _prop(props, "Alias") || _prop(props, "Name") || "Bluetooth device",
          connected: !!_prop(props, "Connected"),
          paired: !!_prop(props, "Paired"),
          battery: undefined,
        });
      } else if (name === "org.bluez.Adapter1") {
        this._btAdapter = { path, powered: !!_prop(props, "Powered") };
      } else if (name === "org.bluez.Battery1") {
        const dev = this._btDevices.get(path);
        if (dev) dev.battery = _prop(props, "Percentage");
      }
    }
  }

  _btProps(path, ifaceName, changed) {
    if (ifaceName === "org.bluez.Adapter1" && this._btAdapter?.path === path) {
      const powered = _prop(changed, "Powered");
      if (powered !== undefined && powered !== this._btAdapter.powered) {
        this._btAdapter.powered = powered;
        this._emit(
          powered ? "bluetooth-active-symbolic" : "bluetooth-disabled-symbolic",
          powered ? "Bluetooth on" : "Bluetooth off",
        );
      }
      return;
    }
    const dev = this._btDevices.get(path);
    if (!dev) return;
    if (ifaceName === "org.bluez.Battery1") {
      const pct = _prop(changed, "Percentage");
      if (pct !== undefined) dev.battery = pct;
      return;
    }
    if (ifaceName !== "org.bluez.Device1") return;
    const connected = _prop(changed, "Connected");
    if (connected !== undefined && connected !== dev.connected) {
      dev.connected = connected;
      if (connected) {
        const batt = dev.battery !== undefined ? ` · ${dev.battery}%` : "";
        this._emit("bluetooth-active-symbolic", `${dev.name} connected${batt}`);
      } else {
        this._emit("bluetooth-disabled-symbolic", `${dev.name} disconnected`);
      }
    }
    const paired = _prop(changed, "Paired");
    if (paired === true && !dev.paired)
      this._emit("bluetooth-active-symbolic", `${dev.name} paired`);
    if (paired !== undefined) dev.paired = paired;
  }

  _btRemoved(path, ifaceNames) {
    if (ifaceNames.includes("org.bluez.Device1")) {
      const dev = this._btDevices.get(path);
      if (dev?.connected)
        this._emit("bluetooth-disabled-symbolic", `${dev.name} disconnected`);
      this._btDevices.delete(path);
    }
    if (
      ifaceNames.includes("org.bluez.Adapter1") &&
      this._btAdapter?.path === path
    )
      this._btAdapter = null;
  }

  // -------------------------------------------------------------- audio

  async _startAudio() {
    let Gvc;
    try {
      Gvc = (await import("gi://Gvc")).default;
    } catch (_e) {
      return;
    }
    if (this._destroyed || !Gvc) return;
    const control = new Gvc.MixerControl({ name: "Dynamic Notch Events" });
    this._gvc = control;
    this._sinkIds = [];
    this._sourceIds = [];
    const stateId = control.connect("state-changed", (_c, state) => {
      if (state === Gvc.MixerControlState.READY) this._onAudioStreams();
    });
    const outId = control.connect("active-output-update", () =>
      this._onAudioStreams(),
    );
    const inId = control.connect("active-input-update", () =>
      this._onAudioStreams(),
    );
    control.open();
    this._on(() => {
      for (const [obj, id] of [...this._sinkIds, ...this._sourceIds])
        obj.disconnect(id);
      this._sinkIds = [];
      this._sourceIds = [];
      control.disconnect(stateId);
      control.disconnect(outId);
      control.disconnect(inId);
      control.close();
      this._gvc = null;
    });
  }

  _audioPortName(sink) {
    try {
      const port = sink.get_port();
      return `${port?.port_name ?? ""} ${port?.human_port_name ?? ""}`.toLowerCase();
    } catch (_e) {
      return "";
    }
  }

  _onAudioPort(first = false) {
    const name = this._audioPortName(this._audioSink);
    const head = name.includes("headphone") || name.includes("headset");
    if (!first && this._audioHead !== undefined && head !== this._audioHead)
      this._emit(
        head ? "audio-headphones-symbolic" : "audio-speakers-symbolic",
        head ? "Headphones connected" : "Headphones disconnected",
      );
    this._audioHead = head;
  }

  // Only mute transitions are events; volume level changes never emit.
  _onVolume() {
    const sink = this._audioSink;
    if (!sink || !this._gvc) return;
    const muted = sink.get_is_muted();
    if (this._volMuted === null || muted === this._volMuted) return;
    this._volMuted = muted;
    if (muted) {
      this._emit("audio-volume-muted-symbolic", "Volume muted");
      return;
    }
    const pct = Math.round(
      (100 * sink.get_volume()) / this._gvc.get_vol_max_norm(),
    );
    const icon =
      pct === 0
        ? "audio-volume-muted-symbolic"
        : pct < 34
          ? "audio-volume-low-symbolic"
          : pct < 67
            ? "audio-volume-medium-symbolic"
            : pct <= 100
              ? "audio-volume-high-symbolic"
              : "audio-volume-overamplified-symbolic";
    this._emit(icon, "Volume unmuted");
  }

  _onAudioStreams() {
    const control = this._gvc;
    if (!control) return;
    const sink = control.get_default_sink();
    if (sink !== this._audioSink) {
      for (const [obj, id] of this._sinkIds) obj.disconnect(id);
      this._sinkIds = [];
      this._audioSink = sink;
      this._volMuted = null;
      this._audioHead = undefined;
      if (sink) {
        const on = (sig, fn) =>
          this._sinkIds.push([sink, sink.connect(sig, fn)]);
        on("notify::is-muted", () => this._onVolume());
        try {
          on("notify::port", () => this._onAudioPort());
        } catch (_e) {}
        this._volMuted = sink.get_is_muted();
        if (this._audioSeenSink) {
          const head = this._audioPortName(sink).includes("headphone");
          this._emit(
            head ? "audio-headphones-symbolic" : "audio-speakers-symbolic",
            `Output · ${sink.get_description()}`,
          );
        }
        this._audioSeenSink = true;
        this._onAudioPort(true);
      }
    }
    const source = control.get_default_source();
    if (source !== this._audioSource) {
      for (const [obj, id] of this._sourceIds) obj.disconnect(id);
      this._sourceIds = [];
      this._audioSource = source;
      this._micMuted = null;
      if (source) {
        const id = source.connect("notify::is-muted", () => {
          const muted = source.get_is_muted();
          if (muted === this._micMuted) return;
          this._micMuted = muted;
          this._emit(
            muted
              ? "microphone-sensitivity-muted-symbolic"
              : "microphone-sensitivity-high-symbolic",
            muted ? "Microphone muted" : "Microphone unmuted",
          );
        });
        this._sourceIds.push([source, id]);
        this._micMuted = source.get_is_muted();
      }
    }
  }

  // ------------------------------------------------------------ network

  async _startNetwork() {
    let NM;
    try {
      NM = (await import("gi://NM")).default;
    } catch (_e) {
      return;
    }
    if (this._destroyed || !NM) return;
    let client;
    try {
      client = await new Promise((resolve, reject) => {
        NM.Client.new_async(null, (_o, res) => {
          try {
            resolve(NM.Client.new_finish(res));
          } catch (e) {
            reject(e);
          }
        });
      });
    } catch (_e) {
      return;
    }
    if (this._destroyed) return;
    this._nm = client;
    this._nmIds = [];
    const on = (obj, sig, fn) => this._nmIds.push([obj, obj.connect(sig, fn)]);
    on(client, "notify::connectivity", () => this._onNmConnectivity());
    on(client, "notify::wireless-enabled", () => {
      const onn = client.wireless_enabled;
      this._emit(
        onn ? "network-wireless-symbolic" : "airplane-mode-symbolic",
        onn ? "Wireless on" : "Wireless off",
      );
    });
    on(client, "notify::primary-connection", () => this._nmTrackPrimary());
    this._nmConn = client.connectivity;
    this._nmTrackPrimary();
    this._on(() => {
      for (const [obj, id] of this._nmIds) obj.disconnect(id);
      this._nmIds = [];
      this._nm = null;
    });
  }

  _nmTrackPrimary() {
    const ac = this._nm?.primary_connection;
    if (!ac || ac === this._nmAc) return;
    this._nmAc = ac;
    const conn = ac.get_connection();
    const name = conn?.get_id() ?? "Network";
    const type = conn?.get_connection_type() ?? "";
    const icon =
      type === "vpn" || type === "wireguard"
        ? "network-vpn-symbolic"
        : type === "802-3-ethernet"
          ? "network-wired-symbolic"
          : "network-wireless-symbolic";
    const id = ac.connect("state-changed", (_a, state) => {
      // NM.ActiveConnectionState: ACTIVATED=2, DEACTIVATED=4.
      if (state === 2) this._emit(icon, `Connected · ${name}`);
      else if (state === 4)
        this._emit(
          "network-wireless-offline-symbolic",
          `Disconnected · ${name}`,
        );
    });
    this._nmIds.push([ac, id]);
  }

  _onNmConnectivity() {
    const c = this._nm?.connectivity;
    if (c === undefined || c === this._nmConn) return;
    this._nmConn = c;
    // NM.ConnectivityState: NONE=1, PORTAL=2, LIMITED=3, FULL=4.
    if (c === 1)
      this._emit("network-offline-symbolic", "No internet connection");
    else if (c === 2)
      this._emit("network-wireless-symbolic", "Network sign-in required");
    else if (c === 3)
      this._emit("network-wireless-offline-symbolic", "Limited connectivity");
  }

  // ------------------------------------------------------------- session

  _startSession() {
    const SsProxy = Gio.DBusProxy.makeProxyWrapper(SCREENSAVER_XML);
    this._screenSaver = new SsProxy(
      Gio.DBus.session,
      "org.gnome.ScreenSaver",
      "/org/gnome/ScreenSaver",
      (p, err) => {
        if (err || this._destroyed) return;
        const id = p.connectSignal("ActiveChanged", (_p, _s, [active]) => {
          this._emit(
            active ? "system-lock-screen-symbolic" : "dialog-password-symbolic",
            active ? "Screen locked" : "Screen unlocked",
          );
        });
        this._on(() => p.disconnectSignal(id));
      },
    );
    const sub = Gio.DBus.system.signal_subscribe(
      "org.freedesktop.login1",
      "org.freedesktop.login1.Manager",
      "PrepareForSleep",
      "/org/freedesktop/login1",
      null,
      Gio.DBusSignalFlags.NONE,
      (_c, _s, _p, _i, _m, params) => {
        const sleep = params.get_child_value(0).get_boolean();
        this._emit(
          sleep ? "weather-clear-night-symbolic" : "computer-symbolic",
          sleep ? "Suspending" : "Resumed",
        );
      },
    );
    this._on(() => Gio.DBus.system.signal_unsubscribe(sub));
    const BrProxy = Gio.DBusProxy.makeProxyWrapper(GSD_POWER_XML);
    this._gsdPower = new BrProxy(
      Gio.DBus.session,
      "org.gnome.SettingsDaemon.Power",
      "/org/gnome/SettingsDaemon/Power",
      (p, err) => {
        if (err || this._destroyed) return;
        this._brightness = p.Brightness;
        const id = p.connect("g-properties-changed", () => {
          const v = p.Brightness;
          if (v === undefined || v < 0 || v === this._brightness) return;
          this._brightness = v;
          this._emit("display-brightness-symbolic", `Brightness · ${v}%`);
        });
        this._on(() => p.disconnect(id));
      },
    );
    const TzProxy = Gio.DBusProxy.makeProxyWrapper(TIMEDATE_XML);
    this._timedate = new TzProxy(
      Gio.DBus.system,
      "org.freedesktop.timedate1",
      "/org/freedesktop/timedate1",
      (p, err) => {
        if (err || this._destroyed) return;
        this._timezone = p.Timezone;
        const id = p.connect("g-properties-changed", () => {
          if (!p.Timezone || p.Timezone === this._timezone) return;
          this._timezone = p.Timezone;
          this._emit("alarm-symbolic", `Timezone · ${p.Timezone}`);
        });
        this._on(() => p.disconnect(id));
      },
    );
    this._on(() => {
      this._screenSaver = null;
      this._gsdPower = null;
      this._timedate = null;
    });
  }

  // ------------------------------------------------------------- storage

  _startStorage() {
    const monitor = Gio.VolumeMonitor.get();
    this._volMonitor = monitor;
    const addedId = monitor.connect("mount-added", (_m, mount) => {
      this._emit(null, `${mount.get_name()} mounted`, mount.get_icon());
    });
    const removedId = monitor.connect("mount-removed", (_m, mount) => {
      this._emit(null, `${mount.get_name()} unmounted`, mount.get_icon());
    });
    this._on(() => {
      monitor.disconnect(addedId);
      monitor.disconnect(removedId);
      this._volMonitor = null;
    });
    this._monCount = Main.layoutManager.monitors.length;
    const monId = Main.layoutManager.connect("monitors-changed", () => {
      const n = Main.layoutManager.monitors.length;
      if (n === this._monCount) return;
      const up = n > this._monCount;
      this._monCount = n;
      this._emit(
        "video-display-symbolic",
        up ? "External display connected" : "External display disconnected",
      );
    });
    this._on(() => Main.layoutManager.disconnect(monId));
  }

  // ------------------------------------------------------------- desktop

  _startDesktop() {
    this._eventSettings = [];
    const watch = (schemaId, key, fn) => {
      try {
        const s = new Gio.Settings({ schema_id: schemaId });
        const id = s.connect(`changed::${key}`, () => fn(s));
        this._eventSettings.push(s);
        this._on(() => s.disconnect(id));
      } catch (_e) {}
    };
    watch("org.gnome.desktop.interface", "color-scheme", (s) => {
      const dark = s.get_string("color-scheme") === "prefer-dark";
      this._emit(
        dark ? "weather-clear-night-symbolic" : "weather-clear-symbolic",
        dark ? "Dark mode on" : "Light mode on",
      );
    });
    const wallpaper = () =>
      this._emit("preferences-desktop-wallpaper-symbolic", "Wallpaper changed");
    watch("org.gnome.desktop.background", "picture-uri", wallpaper);
    watch("org.gnome.desktop.background", "picture-uri-dark", wallpaper);
    watch("org.gnome.desktop.notifications", "show-banners", (s) => {
      const banners = s.get_boolean("show-banners");
      this._emit(
        banners ? "user-available-symbolic" : "notifications-disabled-symbolic",
        banners ? "Do Not Disturb off" : "Do Not Disturb on",
      );
    });
    watch(
      "org.gnome.settings-daemon.plugins.color",
      "night-light-enabled",
      (s) => {
        const onn = s.get_boolean("night-light-enabled");
        this._emit(
          onn ? "night-light-symbolic" : "night-light-disabled-symbolic",
          onn ? "Night light on" : "Night light off",
        );
      },
    );
    watch("org.gnome.desktop.input-sources", "current", (s) => {
      try {
        const sources = s.get_value("sources");
        const idx = s.get_uint("current");
        if (idx >= sources.n_children()) return;
        const id = sources.get_child_value(idx).get_child_value(1).get_string();
        this._emit("input-keyboard-symbolic", `Keyboard · ${id.toUpperCase()}`);
      } catch (_e) {}
    });
    this._on(() => {
      this._eventSettings = [];
    });
  }

  // --------------------------------------------------------------- shell

  _startShell() {
    const wsId = global.workspace_manager.connect(
      "active-workspace-changed",
      () => {
        const n = global.workspace_manager.get_active_workspace_index() + 1;
        this._emit("view-grid-symbolic", `Workspace ${n}`);
      },
    );
    this._on(() => global.workspace_manager.disconnect(wsId));
  }
}
