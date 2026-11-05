// Provider musik: klien MPRIS (org.mpris.MediaPlayer2.Player) di
// session bus — discovery via ListNames/NameOwnerChanged, update
// via g-properties-changed (tanpa polling).

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const PREFIX = 'org.mpris.MediaPlayer2.';
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
        this._settleId = 0;
        this._destroyed = false;
        this._lastKey = '';
        this._lockName = null;
        this._lockUntilUs = 0;
    }

    start() {
        const conn = Gio.DBus.session;
        this._conn = conn;
        conn.call('org.freedesktop.DBus', '/org/freedesktop/DBus',
            'org.freedesktop.DBus', 'ListNames', null,
            new GLib.VariantType('(as)'), Gio.DBusCallFlags.NONE, -1,
            null, (c, res) => {
                if (this._destroyed)
                    return;
                try {
                    const [names] = c.call_finish(res).deep_unpack();
                    for (const n of names)
                        if (n.startsWith(PREFIX))
                            this._addPlayer(n);
                } catch (e) { /* tidak ada bus: diam */ }
                this._emit();
            });
        this._subId = conn.signal_subscribe('org.freedesktop.DBus',
            'org.freedesktop.DBus', 'NameOwnerChanged',
            '/org/freedesktop/DBus', null, Gio.DBusSignalFlags.NONE,
            (_c, _s, _p, _i, _sig, params) => {
                if (this._destroyed)
                    return;
                const [name, , newOwner] = params.deep_unpack();
                if (!name.startsWith(PREFIX))
                    return;
                if (newOwner)
                    this._addPlayer(name);
                else
                    this._removePlayer(name);
            });
    }

    destroy() {
        this._destroyed = true;
        if (this._subId)
            this._conn?.signal_unsubscribe(this._subId);
        this._subId = 0;
        if (this._settleId)
            GLib.source_remove(this._settleId);
        this._settleId = 0;
        for (const entry of this._players.values())
            this._teardown(entry);
        this._players.clear();
        this._cb = null;
    }

    _control(method) {
        const entry = this._selected();
        if (!entry)
            return;
        // Post-action lock: the view stays on the player the
        // user just controlled for 3s instead of jumping away.
        this._lockName = entry.busName;
        this._lockUntilUs = GLib.get_monotonic_time() + 3000000;
        entry.proxy[method]?.();
    }

    playPause() {
        this._control('PlayPauseRemote');
    }

    next() {
        this._control('NextRemote');
    }

    previous() {
        this._control('PreviousRemote');
    }

    _addPlayer(busName) {
        if (this._players.has(busName) || this._destroyed)
            return;
        try {
            const proxy = new PlayerProxy(Gio.DBus.session, busName,
                '/org/mpris/MediaPlayer2');
            const entry = {
                busName, proxy, status: 'Stopped', metadata: {},
                positionUs: 0, stamp: 0, sigId: 0, seekId: 0,
                identity: '', desktopEntry: '', lastPlayingUs: 0,
            };
            entry.sigId = proxy.connect('g-properties-changed',
                () => this._onProps(entry));
            entry.seekId = proxy.connectSignal('Seeked',
                (_p, _s, [pos]) => {
                    entry.positionUs = pos ?? entry.positionUs;
                    entry.stamp = GLib.get_monotonic_time();
                    this._emit(true);
                });
            this._players.set(busName, entry);
            this._onProps(entry);
            this._fetchRootProps(entry);
            // Cache properti proxy terisi async; baca ulang sekali.
            if (!this._settleId) {
                this._settleId = GLib.timeout_add(
                    GLib.PRIORITY_DEFAULT, 400, () => {
                        this._settleId = 0;
                        for (const e of this._players.values())
                            this._onProps(e);
                        return GLib.SOURCE_REMOVE;
                    });
            }
        } catch (e) { /* player aneh: lewati */ }
    }

    _removePlayer(busName) {
        const entry = this._players.get(busName);
        if (!entry)
            return;
        this._teardown(entry);
        this._players.delete(busName);
        this._emit();
    }

    _teardown(entry) {
        try {
            if (entry.sigId)
                entry.proxy.disconnect(entry.sigId);
            if (entry.seekId)
                entry.proxy.disconnectSignal(entry.seekId);
        } catch (e) { /* sudah mati */ }
    }

    _onProps(entry) {
        if (this._destroyed)
            return;
        const prevStatus = entry.status;
        const prevTrack = entry.metadata?.['mpris:trackid'];
        try {
            const status = entry.proxy.PlaybackStatus;
            if (status)
                entry.status = status;
            const md = entry.proxy.Metadata;
            if (md)
                entry.metadata = md.deep_unpack();
            const pos = entry.proxy.Position;
            if (typeof pos === 'number')
                entry.positionUs = pos;
        } catch (e) { return; }
        entry.stamp = GLib.get_monotonic_time();
        if (entry.status === 'Playing')
            entry.lastPlayingUs = entry.stamp;
        // Some players (browsers especially) let the cached
        // Position go stale; re-read it on track/status change.
        if (entry.status !== prevStatus ||
            entry.metadata?.['mpris:trackid'] !== prevTrack)
            this._fetchPosition(entry);
        this._emit();
    }

    // Identity/DesktopEntry live on the root interface, outside
    // the Player proxy's cache: fetch them once per player.
    _fetchRootProps(entry) {
        this._conn.call(entry.busName, '/org/mpris/MediaPlayer2',
            'org.freedesktop.DBus.Properties', 'GetAll',
            new GLib.Variant('(s)', ['org.mpris.MediaPlayer2']),
            new GLib.VariantType('(a{sv})'), Gio.DBusCallFlags.NONE,
            -1, null, (c, res) => {
                if (this._destroyed ||
                    !this._players.has(entry.busName))
                    return;
                try {
                    const [props] = c.call_finish(res).deep_unpack();
                    entry.identity = props?.Identity ?? '';
                    entry.desktopEntry = props?.DesktopEntry ?? '';
                } catch (e) { return; }
                this._emit(true);
            });
    }

    _fetchPosition(entry) {
        this._conn.call(entry.busName, '/org/mpris/MediaPlayer2',
            'org.freedesktop.DBus.Properties', 'Get',
            new GLib.Variant('(ss)',
                ['org.mpris.MediaPlayer2.Player', 'Position']),
            new GLib.VariantType('(v)'), Gio.DBusCallFlags.NONE,
            -1, null, (c, res) => {
                if (this._destroyed ||
                    !this._players.has(entry.busName))
                    return;
                try {
                    const [v] = c.call_finish(res).deep_unpack();
                    if (typeof v === 'number' && v >= 0) {
                        entry.positionUs = v;
                        entry.stamp = GLib.get_monotonic_time();
                        this._emit(true);
                    }
                } catch (e) { /* diam */ }
            });
    }

    _selected() {
        // The post-action lock wins while it lasts.
        if (this._lockName &&
            GLib.get_monotonic_time() < this._lockUntilUs) {
            const locked = this._players.get(this._lockName);
            if (locked && locked.status !== 'Stopped')
                return locked;
        }
        // Scored selection: a playing, titled player beats a
        // paused one; ties go to whoever played most recently.
        let best = null, bestScore = -1;
        for (const entry of this._players.values()) {
            if (entry.status !== 'Playing' &&
                entry.status !== 'Paused')
                continue;
            const hasTitle = !!(entry.metadata?.['xesam:title'] ||
                entry.metadata?.['xesam:url']);
            let score = entry.status === 'Playing' ? 300 : 10;
            if (hasTitle)
                score += entry.status === 'Playing' ? 200 : 90;
            if (score > bestScore ||
                (score === bestScore && best &&
                    entry.lastPlayingUs > best.lastPlayingUs)) {
                best = entry;
                bestScore = score;
            }
        }
        return best;
    }

    _emit(force = false) {
        if (this._destroyed || !this._cb)
            return;
        const entry = this._selected();
        if (!entry) {
            if (this._lastKey !== 'none') {
                this._lastKey = 'none';
                this._cb.onChanged(null);
            }
            return;
        }
        const m = entry.metadata ?? {};
        let title = m['xesam:title'] ?? '';
        if (!title) {
            // Players like VLC often leave the title empty for
            // local files; the file name is the honest fallback.
            const u = m['xesam:url'] ?? '';
            if (u.startsWith('file://')) {
                try {
                    title = decodeURIComponent(u.split('/').pop() ?? '');
                } catch (_e) {}
            }
        }
        const snap = {
            busName: entry.busName,
            status: entry.status,
            identity: entry.identity ?? '',
            desktopEntry: entry.desktopEntry ?? '',
            title,
            artist: (m['xesam:artist'] ?? []).join(', '),
            album: m['xesam:album'] ?? '',
            artUrl: m['mpris:artUrl'] ?? '',
            lengthUs: m['mpris:length'] ?? 0,
            canNext: !!entry.proxy.CanGoNext,
            canPrev: !!entry.proxy.CanGoPrevious,
            canPlay: !!entry.proxy.CanPlay,
            canPause: !!entry.proxy.CanPause,
            positionUs: entry.positionUs,
            stampUs: entry.stamp,
        };
        const key = [snap.busName, snap.status, snap.title, snap.artist,
            snap.artUrl, snap.canNext, snap.canPrev].join('|');
        if (!force && key === this._lastKey)
            return;
        this._lastKey = key;
        this._cb.onChanged(snap);
    }
}
