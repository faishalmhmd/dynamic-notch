// Provider kalender: instance DBusEventSource sendiri (backend yang
// sama dengan dateMenu stok: org.gnome.Shell.CalendarServer), jadi
// UI kalender kita tidak bergantung pada widget stok sama sekali.

import * as Calendar from 'resource:///org/gnome/shell/ui/calendar.js';

function beginOfDay(date) {
    const d = new Date(date.getTime());
    d.setHours(0, 0, 0, 0);
    return d;
}

function endOfDay(date) {
    const d = beginOfDay(date);
    d.setDate(d.getDate() + 1);
    return d;
}

export class CalendarProvider {
    // callbacks: onChanged()
    constructor(callbacks) {
        this._cb = callbacks;
        this._source = new Calendar.DBusEventSource();
        this._changedId = this._source.connect('changed',
            () => this._cb?.onChanged());
        const now = new Date();
        this.viewMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        this.selectedDay = beginOfDay(now);
        this.requestVisibleRange();
    }

    destroy() {
        if (this._changedId)
            this._source.disconnect(this._changedId);
        this._source.destroy();
        this._cb = null;
    }

    // Range yang diminta ke CalendarServer: grid bulan ini plus margin
    // lebar di kedua sisi, supaya convention awal-minggu apa pun
    // (Minggu/Senin) yang dipakai grid UI tetap tercakup.
    requestVisibleRange() {
        const first = new Date(this.viewMonth.getTime());
        first.setDate(first.getDate() - 14);
        const last = new Date(this.viewMonth.getTime());
        last.setDate(last.getDate() + 56);
        this._source.requestRange(first, last);
    }

    // Pindah bulan yang dimintakan event-nya tanpa mengubah pilihan
    // hari di provider (dipakai navigasi grid UI).
    ensureMonth(date) {
        this.viewMonth = new Date(date.getFullYear(), date.getMonth(), 1);
        this.requestVisibleRange();
    }

    moveMonth(delta) {
        this.viewMonth = new Date(this.viewMonth.getFullYear(),
            this.viewMonth.getMonth() + delta, 1);
        this.requestVisibleRange();
        this._cb?.onChanged();
    }

    selectDay(date) {
        this.selectedDay = beginOfDay(date);
        this._cb?.onChanged();
    }

    getEventsForDay(date) {
        return this._source.getEvents(beginOfDay(date), endOfDay(date));
    }

    hasEvents(date) {
        try {
            return this._source.hasEvents(beginOfDay(date));
        } catch (e) {
            return this.getEventsForDay(date).length > 0;
        }
    }

    get hasCalendars() {
        return this._source.hasCalendars;
    }
}
