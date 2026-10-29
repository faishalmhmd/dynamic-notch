// Provider musik: klien MPRIS standar di session bus (pola yang sama
// dengan dynamic-music-pill: proxy per player, tanpa service duplikat).
import Gio from "gi://Gio";
import GLib from "gi://GLib";

const PLAYER_XML = `
<node>
  <interface name="org.mpris.MediaPlayer2.Player">
    <property name="Metadata" type="a{sv}" access="read"/>
    <property name="PlaybackStatus" type="s" access="read"/>
    <property name="CanGoNext" type="b" access="read"/>
    <property name="CanGoPrevious" type="b" access="read"/>
    <property name="CanPlay" type="b" access="read"/>
    <property name="CanPause" type="b" access="read"/>
    <method name="PlayPause"/>
    <method name="Play"/>
    <method name="Pause"/>
    <method name="Next"/>
    <method name="Previous"/>
  </interface>
</node>`;

const PlayerProxy = Gio.DBusProxy.makeProxyWrapper(PLAYER_XML);
const MPRIS_PREFIX = "org.mpris.MediaPlayer2.";

export class MusicProvider {
  constructor({ onChanged }) {
    this._onChanged = onChanged;
    this._players = new Map();
    this._lastChange = new Map();
    this._currentName = null;
    this._subId = 0;
    this._destroyed = false;
  }

  start() {
    const bus = Gio.DBus.session;
    bus.call(
      "org.freedesktop.DBus",
      "/org/freedesktop/DBus",
      "org.freedesktop.DBus",
      "ListNames",
      null,
      null,
      Gio.DBusCallFlags.NONE,
      -1,
      null,
      (conn, res) => {
        if (this._destroyed) return;
        try {
          const names = conn.call_finish(res).deep_unpack()[0];
          for (const name of names) {
            if (name.startsWith(MPRIS_PREFIX)) this._addPlayer(name);
          }
        } catch (e) {
          logError(e, "dynamic-notch: MPRIS ListNames failed");
        }
      },
    );
    this._subId = bus.signal_subscribe(
      "org.freedesktop.DBus",
      "org.freedesktop.DBus",
      "NameOwnerChanged",
      "/org/freedesktop/DBus",
      null,
      Gio.DBusSignalFlags.NONE,
      (conn, sender, path, iface, signal, params) => {
        if (this._destroyed) return;
        const [name, , newOwner] = params.deep_unpack();
        if (!name.startsWith(MPRIS_PREFIX)) return;
        if (newOwner) this._addPlayer(name);
        else this._removePlayer(name);
      },
    );
  }

  _addPlayer(name) {
    if (this._players.has(name)) return;
    new PlayerProxy(
      Gio.DBus.session,
      name,
      "/org/mpris/MediaPlayer2",
      (proxy, error) => {
        if (this._destroyed) return;
        if (error) {
          logError(error, "dynamic-notch: MPRIS proxy failed");
          return;
        }
        const propsId = proxy.connect("g-properties-changed", () => {
          this._lastChange.set(name, GLib.get_monotonic_time());
          this._emit();
        });
        this._players.set(name, { proxy, propsId });
        this._lastChange.set(name, GLib.get_monotonic_time());
        this._emit();
      },
    );
  }

  _removePlayer(name) {
    const entry = this._players.get(name);
    if (entry) {
      try {
        entry.proxy.disconnect(entry.propsId);
      } catch (_e) {}
      this._players.delete(name);
    }
    this._lastChange.delete(name);
    this._emit();
  }

  _read(proxy) {
    const get = (n) => {
      const v = proxy.get_cached_property(n);
      return v ? v.deep_unpack() : null;
    };
    const md = get("Metadata") ?? {};
    return {
      status: get("PlaybackStatus") ?? "Stopped",
      title: md["xesam:title"] ?? "",
      artist: (md["xesam:artist"] ?? []).join(", "),
      artUrl: md["mpris:artUrl"] ?? "",
      canNext: !!get("CanGoNext"),
      canPrevious: !!get("CanGoPrevious"),
      canPlayPause: !!get("CanPlay") || !!get("CanPause"),
    };
  }

  // Player yang ditampilkan: yang sedang Playing dulu, lalu Paused,
  // seri diputuskan dari perubahan properti paling baru.
  getState() {
    let best = null;
    for (const [name, entry] of this._players) {
      const s = this._read(entry.proxy);
      if (!s.title) continue;
      const score = s.status === "Playing" ? 2 : s.status === "Paused" ? 1 : 0;
      const t = this._lastChange.get(name) ?? 0;
      if (!best || score > best.score || (score === best.score && t > best.t))
        best = { ...s, score, t, name };
    }
    if (!best) {
      this._currentName = null;
      return { available: false };
    }
    this._currentName = best.name;
    return {
      available: true,
      status: best.status,
      title: best.title,
      artist: best.artist,
      artUrl: best.artUrl,
      canNext: best.canNext,
      canPrevious: best.canPrevious,
      canPlayPause: best.canPlayPause,
    };
  }

  _call(method) {
    const entry = this._currentName
      ? this._players.get(this._currentName)
      : null;
    if (!entry) return;
    try {
      entry.proxy[`${method}Remote`](() => {});
    } catch (e) {
      logError(e, `dynamic-notch: MPRIS ${method} failed`);
    }
  }

  playPause() {
    this._call("PlayPause");
  }

  next() {
    this._call("Next");
  }

  previous() {
    this._call("Previous");
  }

  _emit() {
    if (!this._destroyed) this._onChanged(this.getState());
  }

  destroy() {
    this._destroyed = true;
    if (this._subId) {
      Gio.DBus.session.signal_unsubscribe(this._subId);
      this._subId = 0;
    }
    for (const entry of this._players.values()) {
      try {
        entry.proxy.disconnect(entry.propsId);
      } catch (_e) {}
    }
    this._players.clear();
    this._lastChange.clear();
  }
}
