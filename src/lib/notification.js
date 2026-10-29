// Provider notifikasi: mirror Main.messageTray, banner stok diblokir via bannerBlocked.

import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export class NotificationsProvider {
    // callbacks: onLive(notification), onChanged()
    constructor(callbacks) {
        this._cb = callbacks;
        this._tray = Main.messageTray;
        this._sources = new Map(); // source -> [signalIds]
        this._ackTimers = new Set();
        this._destroyed = false;
    }

    start() {
        this._tray.bannerBlocked = true;
        this._sourceAddedId = this._tray.connect('source-added',
            (_tray, source) => this._trackSource(source));
        this._sourceRemovedId = this._tray.connect('source-removed',
            (_tray, source) => this._untrackSource(source));
        for (const source of this._tray.getSources())
            this._trackSource(source);
    }

    destroy() {
        this._destroyed = true;
        for (const id of this._ackTimers)
            GLib.source_remove(id);
        this._ackTimers.clear();
        for (const source of [...this._sources.keys()])
            this._untrackSource(source);
        if (this._sourceAddedId)
            this._tray.disconnect(this._sourceAddedId);
        if (this._sourceRemovedId)
            this._tray.disconnect(this._sourceRemovedId);
        // Kembalikan perilaku banner stok.
        this._tray.bannerBlocked = false;
        this._cb = null;
    }

    _trackSource(source) {
        if (this._sources.has(source))
            return;
        const ids = [
            source.connect('notification-added',
                (_s, notification) => this._onAdded(notification, true)),
            source.connect('notification-removed',
                () => this._cb?.onChanged()),
        ];
        this._sources.set(source, ids);
        // Notif yang sudah ada sebelum extension aktif: mirror saja,
        // jangan ditampilkan sebagai live activity.
        for (const notification of source.notifications)
            this._onAdded(notification, false);
    }

    _untrackSource(source) {
        const ids = this._sources.get(source);
        if (!ids)
            return;
        for (const id of ids)
            source.disconnect(id);
        this._sources.delete(source);
    }

    _onAdded(notification, live) {
        this._cb?.onChanged();
        if (!live || this._destroyed)
            return;
        // Banner stok diblokir via bannerBlocked; peek notch selalu
        // tampil — policy/DND GNOME tidak membisukan notch sendiri.
        this._cb?.onLive(notification);
        // Setelah jendela live-activity (ditangani extension.js),
        // tandai acknowledged agar tidak jadi banner stok belakangan.
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 4200, () => {
            this._ackTimers.delete(id);
            try {
                notification.acknowledged = true;
            } catch (e) { /* notif mungkin sudah destroyed */ }
            this._cb?.onChanged();
            return GLib.SOURCE_REMOVE;
        });
        this._ackTimers.add(id);
    }

    // Semua notif dari semua source, terbaru di atas.
    getAll() {
        const all = [];
        for (const source of this._tray.getSources())
            for (const notification of source.notifications)
                all.push(notification);
        all.sort((a, b) => b.datetime.compare(a.datetime));
        return all;
    }

    get badge() {
        let count = 0;
        for (const source of this._tray.getSources()) {
            try {
                count += source.unseenCount;
            } catch (e) { /* abaikan source aneh */ }
        }
        return count;
    }

    clearAll() {
        for (const source of this._tray.getSources()) {
            try {
                source.destroyNonResidentNotifications();
            } catch (e) { /* lanjut ke source berikutnya */ }
        }
        this._cb?.onChanged();
    }
}
