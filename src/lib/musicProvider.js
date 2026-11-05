// Provider musik: klien MPRIS (org.mpris.MediaPlayer2.Player) di
// session bus — discovery via ListNames/NameOwnerChanged, update
// via g-properties-changed (tanpa polling).

import Gio from "gi://Gio";
import GLib from "gi://GLib";

const PREFIX = "org.mpris.MediaPlayer2.";

// Payload values can stay wrapped as GLib.Variant after a
// deep_unpack (dict values especially); always unwrap first.
function _unwrap(v) {
  return v instanceof GLib.Variant ? v.deep_unpack() : v;
}

function _unpackMetadata(v) {
  const o = _unwrap(v);
  if (!o || typeof o !== "object") return {};
  const out = {};
  for (const [k, val] of Object.entries(o)) out[k] = _unwrap(val);
  return out;
}

const CAN_PROPS = [
  ["CanGoNext", "canNext"],
  ["CanGoPrevious", "canPrev"],
  ["CanPlay", "canPlay"],
  ["CanPause", "canPause"],
];
const PlayerProxy = Gio.DBusProxy.makeProxyWrapper(`
<node>
  <interface name="org.mpris.MediaPlayer2.Player">
    <property name="PlaybackStatus" type="s" access="read"/>
    <property name="Metadata" type="a{sv}" access="read"/>
    <property name="Position" type="x" access="read"/>
    <property name="CanGoNext" type="b" access="read"/>
    <property name="CanGoPrevious" type="b" access="read"/>
    <property name="CanPlay" type="b" access="read"/>
    <property name="CanPause" type="b" access="read"/>
    <property name="CanControl" type="b" access="read"/>
    <method name="Next"/>
    <method name="Previous"/>
    <method name="Pause"/>
    <method name="PlayPause"/>
    <method name="Play"/>
    <method name="Stop"/>
    <signal name="Seeked">
      <arg name="Position" type="x"/>
    </signal>
  </interface>
</node>`);

export class MusicProvider {
  // callbacks: onChanged(snapshot | null)
  constructor(callbacks) {
    this._cb = callbacks;
    this._players = new Map(); // busName -> entry
    this._subId = 0;
    this._destroyed = false;
    this._lastKey = "";
    this._lockName = null;
    this._lockUntilUs = 0;
  }

  start() {
    const conn = Gio.DBus.session;
    this._conn = conn;
    conn.call(
      "org.freedesktop.DBus",
      "/org/freedesktop/DBus",
      "org.freedesktop.DBus",
      "ListNames",
      null,
      new GLib.VariantType("(as)"),
      Gio.DBusCallFlags.NONE,
      -1,
      null,
      (c, res) => {
        if (this._destroyed) return;
        try {
          const [names] = c.call_finish(res).deep_unpack();
          for (const n of names) if (n.startsWith(PREFIX)) this._addPlayer(n);
        } catch (e) {
          /* tidak ada bus: diam */
        }
        this._emit();
      },
    );
    this._subId = conn.signal_subscribe(
      "org.freedesktop.DBus",
      "org.freedesktop.DBus",
      "NameOwnerChanged",
      "/org/freedesktop/DBus",
      null,
      Gio.DBusSignalFlags.NONE,
      (_c, _s, _p, _i, _sig, params) => {
        if (this._destroyed) return;
        const [name, , newOwner] = params.deep_unpack();
        if (!name.startsWith(PREFIX)) return;
        if (newOwner) this._addPlayer(name);
        else this._removePlayer(name);
      },
    );
  }

  destroy() {
    this._destroyed = true;
    if (this._subId) this._conn?.signal_unsubscribe(this._subId);
    this._subId = 0;
    for (const entry of this._players.values()) this._teardown(entry);
    this._players.clear();
    this._cb = null;
  }

  _control(method) {
    const entry = this._selected();
    if (!entry) return;
    // Post-action lock: the view stays on the player the
    // user just controlled for 3s instead of jumping away.
    this._lockName = entry.busName;
    this._lockUntilUs = GLib.get_monotonic_time() + 3000000;
    entry.proxy[method]?.();
  }

  playPause() {
    this._control("PlayPauseRemote");
  }

  next() {
    this._control("NextRemote");
  }

  previous() {
    this._control("PreviousRemote");
  }

  _addPlayer(busName) {
    if (this._players.has(busName) || this._destroyed) return;
    try {
      const proxy = new PlayerProxy(
        Gio.DBus.session,
        busName,
        "/org/mpris/MediaPlayer2",
      );
      const entry = {
        busName,
        proxy,
        status: "Stopped",
        metadata: {},
        positionUs: 0,
        stamp: 0,
        sigId: 0,
        seekId: 0,
        ownerId: 0,
        identity: "",
        desktopEntry: "",
        lastPlayingUs: 0,
        gotPayload: false,
        canNext: false,
        canPrev: false,
        canPlay: false,
        canPause: false,
      };
      entry.sigId = proxy.connect("g-properties-changed", (_p, changed) =>
        this._onProps(entry, changed),
      );
      entry.seekId = proxy.connectSignal("Seeked", (_p, _s, [pos]) => {
        entry.positionUs = pos ?? entry.positionUs;
        entry.stamp = GLib.get_monotonic_time();
        this._emit(true);
      });
      entry.ownerId = proxy.connect("notify::g-name-owner", () => {
        if (!proxy.g_name_owner) this._removePlayer(busName);
      });
      this._players.set(busName, entry);
      this._onProps(entry);
      this._fetchPlayerProps(entry);
      this._fetchRootProps(entry);
    } catch (e) {
      /* player aneh: lewati */
    }
  }

  _removePlayer(busName) {
    const entry = this._players.get(busName);
    if (!entry) return;
    this._teardown(entry);
    this._players.delete(busName);
    this._emit();
  }

  _teardown(entry) {
    try {
      if (entry.sigId) entry.proxy.disconnect(entry.sigId);
      if (entry.ownerId) entry.proxy.disconnect(entry.ownerId);
      if (entry.seekId) entry.proxy.disconnectSignal(entry.seekId);
    } catch (e) {
      /* sudah mati */
    }
  }

  // State comes from the g-properties-changed PAYLOAD first
  // (the data that arrived with the signal), the proxy cache
  // only as a fallback: a playing tab shows up the moment
  // its PropertiesChanged lands, cache timing aside.
  _onProps(entry, changed = null) {
    if (this._destroyed) return;
    const prevStatus = entry.status;
    const prevTrack = entry.metadata?.["mpris:trackid"];
    let keys = null;
    try {
      keys = changed ? _unwrap(changed) : null;
    } catch (e) {
      keys = null;
    }
    const has = (k) => !!keys && typeof keys === "object" && k in keys;
    try {
      const status = has("PlaybackStatus")
        ? _unwrap(keys.PlaybackStatus)
        : entry.proxy.PlaybackStatus;
      if (typeof status === "string" && status) entry.status = status;
      if (has("Metadata")) entry.metadata = _unpackMetadata(keys.Metadata);
      else if (!changed) {
        const md = entry.proxy.Metadata;
        if (md) entry.metadata = _unpackMetadata(md);
      }
      const pos = has("Position")
        ? _unwrap(keys.Position)
        : entry.proxy.Position;
      if (typeof pos === "number") entry.positionUs = pos;
      for (const [prop, field] of CAN_PROPS) {
        const v = has(prop) ? _unwrap(keys[prop]) : entry.proxy[prop];
        if (typeof v === "boolean") entry[field] = v;
      }
    } catch (e) {
      return;
    }
    if (changed) entry.gotPayload = true;
    entry.stamp = GLib.get_monotonic_time();
    if (entry.status === "Playing") entry.lastPlayingUs = entry.stamp;
    // Some players (browsers especially) let the cached
    // Position go stale; re-read it on track/status change.
    if (
      entry.status !== prevStatus ||
      entry.metadata?.["mpris:trackid"] !== prevTrack
    )
      this._fetchPosition(entry);
    this._emit();
  }

  // Initial state is fetched explicitly instead of waiting
  // for the proxy cache: the player appears as soon as it
  // answers, with status, metadata, position and Can* set.
  _fetchPlayerProps(entry) {
    this._conn.call(
      entry.busName,
      "/org/mpris/MediaPlayer2",
      "org.freedesktop.DBus.Properties",
      "GetAll",
      new GLib.Variant("(s)", ["org.mpris.MediaPlayer2.Player"]),
      new GLib.VariantType("(a{sv})"),
      Gio.DBusCallFlags.NONE,
      -1,
      null,
      (c, res) => {
        if (
          this._destroyed ||
          !this._players.has(entry.busName) ||
          entry.gotPayload
        )
          return;
        try {
          const [props] = c.call_finish(res).unpack();
          if (!props) return;
          const get = (k, t) => {
            const v = props.lookup_value(k, new GLib.VariantType(t));
            return v ? v.deep_unpack() : undefined;
          };
          const status = get("PlaybackStatus", "s");
          if (typeof status === "string" && status) entry.status = status;
          const md = props.lookup_value("Metadata", null);
          if (md) {
            // A late reply must not overwrite fuller
            // metadata that arrived via the payload.
            const fetched = _unpackMetadata(md);
            if (fetched["xesam:title"] || !entry.metadata?.["xesam:title"])
              entry.metadata = fetched;
          }
          const pos = get("Position", "x");
          if (typeof pos === "number") entry.positionUs = pos;
          for (const [prop, field] of CAN_PROPS) {
            const v = get(prop, "b");
            if (typeof v === "boolean") entry[field] = v;
          }
        } catch (e) {
          return;
        }
        entry.stamp = GLib.get_monotonic_time();
        if (entry.status === "Playing") entry.lastPlayingUs = entry.stamp;
        this._emit(true);
      },
    );
  }

  // Identity/DesktopEntry live on the root interface, outside
  // the Player proxy's cache: fetch them once per player.
  // Extract with lookup_value + get_string: deep_unpack can
  // leave dict values wrapped as Variants on some players,
  // and a Variant where a string is expected throws later.
  _fetchRootProps(entry) {
    this._conn.call(
      entry.busName,
      "/org/mpris/MediaPlayer2",
      "org.freedesktop.DBus.Properties",
      "GetAll",
      new GLib.Variant("(s)", ["org.mpris.MediaPlayer2"]),
      new GLib.VariantType("(a{sv})"),
      Gio.DBusCallFlags.NONE,
      -1,
      null,
      (c, res) => {
        if (this._destroyed || !this._players.has(entry.busName)) return;
        try {
          const [props] = c.call_finish(res).unpack();
          const idv = props?.lookup_value(
            "Identity",
            new GLib.VariantType("s"),
          );
          const dev = props?.lookup_value(
            "DesktopEntry",
            new GLib.VariantType("s"),
          );
          entry.identity = idv ? idv.get_string()[0] : "";
          entry.desktopEntry = dev ? dev.get_string()[0] : "";
        } catch (e) {
          return;
        }
        this._emit(true);
      },
    );
  }

  _fetchPosition(entry) {
    this._conn.call(
      entry.busName,
      "/org/mpris/MediaPlayer2",
      "org.freedesktop.DBus.Properties",
      "Get",
      new GLib.Variant("(ss)", ["org.mpris.MediaPlayer2.Player", "Position"]),
      new GLib.VariantType("(v)"),
      Gio.DBusCallFlags.NONE,
      -1,
      null,
      (c, res) => {
        if (this._destroyed || !this._players.has(entry.busName)) return;
        try {
          const [posVar] = c.call_finish(res).unpack();
          const v = posVar?.deep_unpack();
          if (typeof v === "number" && v >= 0) {
            entry.positionUs = v;
            entry.stamp = GLib.get_monotonic_time();
            this._emit(true);
          }
        } catch (e) {
          /* diam */
        }
      },
    );
  }

  _selected() {
    // The post-action lock wins while it lasts.
    if (this._lockName && GLib.get_monotonic_time() < this._lockUntilUs) {
      const locked = this._players.get(this._lockName);
      if (locked && locked.status !== "Stopped") return locked;
    }
    // Scored selection: a playing, titled player beats a
    // paused one; ties go to whoever played most recently.
    let best = null,
      bestScore = -1;
    for (const entry of this._players.values()) {
      if (entry.status !== "Playing" && entry.status !== "Paused") continue;
      const hasTitle = !!(
        entry.metadata?.["xesam:title"] || entry.metadata?.["xesam:url"]
      );
      let score = entry.status === "Playing" ? 300 : 10;
      if (hasTitle) score += entry.status === "Playing" ? 200 : 90;
      if (
        score > bestScore ||
        (score === bestScore &&
          best &&
          entry.lastPlayingUs > best.lastPlayingUs)
      ) {
        best = entry;
        bestScore = score;
      }
    }
    return best;
  }

  _emit(force = false) {
    if (this._destroyed || !this._cb) return;
    const entry = this._selected();
    if (!entry) {
      if (this._lastKey !== "none") {
        const states = [...this._players.values()]
          .map((e) => `${e.busName}=${e.status}`)
          .join(",");
        log(`DN-MEDIA no player selected: ${states || "none"}`);
        this._lastKey = "none";
        this._cb.onChanged(null);
      }
      return;
    }
    const m = entry.metadata ?? {};
    let title = m["xesam:title"] ?? "";
    if (!title) {
      // Players like VLC often leave the title empty for
      // local files; the file name is the honest fallback.
      const u = m["xesam:url"] ?? "";
      if (u.startsWith("file://")) {
        try {
          title = decodeURIComponent(u.split("/").pop() ?? "");
        } catch (_e) {}
      }
    }
    const snap = {
      busName: entry.busName,
      status: entry.status,
      identity: entry.identity ?? "",
      desktopEntry: entry.desktopEntry ?? "",
      title,
      artist: (m["xesam:artist"] ?? []).join(", "),
      album: m["xesam:album"] ?? "",
      artUrl: m["mpris:artUrl"] ?? "",
      lengthUs: m["mpris:length"] ?? 0,
      canNext: entry.canNext,
      canPrev: entry.canPrev,
      canPlay: entry.canPlay,
      canPause: entry.canPause,
      positionUs: entry.positionUs,
      stampUs: entry.stamp,
    };
    const key = [
      snap.busName,
      snap.status,
      snap.title,
      snap.artist,
      snap.artUrl,
      snap.canNext,
      snap.canPrev,
    ].join("|");
    if (!force && key === this._lastKey) return;
    this._lastKey = key;
    log(`DN-MEDIA selected ${snap.busName} ${snap.status} "${snap.title}"`);
    if (!snap.title)
      log(
        `DN-MEDIA empty title; metadata keys: ${Object.keys(m).join(",") || "none"}`,
      );
    this._cb.onChanged(snap);
  }
}
