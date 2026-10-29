import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const EXPANDED_W = 620;
const EXPANDED_H = 336;
const ANIM_MS = 260;
const PANEL_DEBOUNCE_MS = 100;

const State = {
    COMPACT: 'compact',
    EXPANDING: 'expanding',
    EXPANDED: 'expanded',
    COLLAPSING: 'collapsing',
};

// Parse 'rgb(r,g,b)', 'rgba(r,g,b,a)' or '#rrggbb' into {r,g,b,a} or null.
function parseColor(str) {
    if (!str)
        return null;
    const s = str.trim();
    let m = s.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/);
    if (m) {
        return {
            r: Number(m[1]), g: Number(m[2]), b: Number(m[3]),
            a: m[4] === undefined ? 1 : Number(m[4]),
        };
    }
    m = s.match(/^#([0-9a-fA-F]{6})$/);
    if (m) {
        const v = parseInt(m[1], 16);
        return {r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255, a: 1};
    }
    return null;
}

function rgbaString({r, g, b}, a) {
    return `rgba(${r},${g},${b},${a})`;
}

// Perceived luminance 0..1 of an opaque color.
function luminance({r, g, b}) {
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

export default class DynamicNotchExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._ifaceSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});

        this._state = State.COMPACT;
        this._animGen = 0;
        this._animOnDone = null;
        this._timerRunning = false;

        // Panel appearance currently applied (null = nothing applied yet).
        this._appliedPanelBg = null;    // 'theme' | 'transparent' | 'solid' | 'semi'
        this._appliedPanelStyle = null; // inline style string currently set
        this._appliedPanelFg = null;    // 'light' | 'dark' | null

        this._panelDebounceId = 0;
        this._overviewRecheckId = 0;
        this._closeIdleId = 0;
        this._clockTimeoutId = 0;
        this._stagePressId = 0;
        this._stageKeyId = 0;
        this._focusWindowId = 0;
        this._grabOpId = 0;
        this._settingsChangedId = 0;
        this._monitorsChangedId = 0;

        this._buildNotch();
        Main.layoutManager.addChrome(this._notch);
        this._applyNotchStyle();
        this._applySize(false);

        this._clockTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            this._updateClock();
            return GLib.SOURCE_CONTINUE;
        });
        this._updateClock();

        this._settingsChangedId = this._settings.connect('changed', () => {
            this._applyNotchStyle();
            this._refreshGeometry();
            this._updatePanelAppearance();
        });
        this._monitorsChangedId = Main.layoutManager.connect('monitors-changed', () => {
            this._applySize(false);
            this._updatePanelAppearance();
        });

        // --- Panel background tracking ---
        this._actorSignalIds = new Map();
        this._windowSignalIds = new Map();

        this._actorSignalIds.set(Main.overview, [
            Main.overview.connect('showing', () => {
                // Opening the Overview counts as interacting outside the
                // notch: collapse it, then follow the Overview styling.
                if (this._state === State.EXPANDED || this._state === State.EXPANDING)
                    this._closePanel();
                this._updatePanelAppearance();
            }),
            Main.overview.connect('shown', () => this._updatePanelAppearance()),
            Main.overview.connect('hiding', () => this._updatePanelAppearance()),
            Main.overview.connect('hidden', () => {
                this._updatePanelAppearance();
                this._scheduleOverviewRecheck();
            }),
        ]);

        this._actorSignalIds.set(Main.sessionMode, [
            Main.sessionMode.connect('updated', () => this._updatePanelAppearance()),
        ]);

        this._actorSignalIds.set(global.workspace_manager, [
            global.workspace_manager.connect('active-workspace-changed', () => {
                // Switching workspace is an outside interaction too.
                this._closePanel();
                this._schedulePanelUpdate();
            }),
        ]);

        this._actorSignalIds.set(global.display, [
            global.display.connect('restacked', () => this._schedulePanelUpdate()),
        ]);

        for (const metaWindowActor of global.get_window_actors())
            this._onWindowActorAdded(metaWindowActor.get_parent(), metaWindowActor);

        this._actorSignalIds.set(global.window_group, [
            global.window_group.connect('child-added', this._onWindowActorAdded.bind(this)),
            global.window_group.connect('child-removed', this._onWindowActorRemoved.bind(this)),
        ]);

        this._updatePanelAppearance();
    }

    disable() {
        // Synchronous, per the Shell 51 porting guide. Everything that
        // enable() installed is removed here, in dependency order.
        for (const id of [this._clockTimeoutId, this._panelDebounceId,
            this._overviewRecheckId, this._closeIdleId]) {
            if (id)
                GLib.source_remove(id);
        }
        this._clockTimeoutId = this._panelDebounceId = 0;
        this._overviewRecheckId = this._closeIdleId = 0;

        this._removeOutsideHandlers();

        if (this._settings && this._settingsChangedId)
            this._settings.disconnect(this._settingsChangedId);
        this._settingsChangedId = 0;
        if (this._monitorsChangedId)
            Main.layoutManager.disconnect(this._monitorsChangedId);
        this._monitorsChangedId = 0;

        for (const map of [this._actorSignalIds, this._windowSignalIds]) {
            if (!map)
                continue;
            for (const [actor, signalIds] of map) {
                for (const signalId of signalIds) {
                    try {
                        actor.disconnect(signalId);
                    } catch (_e) {
                        // Window actor may already be gone; nothing to do.
                    }
                }
            }
            map.clear();
        }
        this._actorSignalIds = null;
        this._windowSignalIds = null;

        // Restore the stock panel completely: classes, inline style, corners.
        this._restorePanel();

        if (this._notch) {
            this._notch.remove_all_transitions();
            Main.layoutManager.removeChrome(this._notch);
            this._notch.destroy();
            this._notch = null;
        }
        this._animOnDone = null;
        this._ifaceSettings = null;
        this._settings = null;
    }

    // ------------------------------------------------------------- notch UI

    _buildNotch() {
        this._notch = new St.Widget({
            name: 'dynamic-notch',
            style_class: 'dn-notch',
            reactive: true,
            track_hover: true,
            clip_to_allocation: true,
            layout_manager: new Clutter.BinLayout(),
        });

        this._notchBox = new St.BoxLayout({
            style_class: 'dn-box',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
        });
        this._notch.add_child(this._notchBox);

        // --- Compact view: time + date, as before ---
        this._clockWidget = new St.BoxLayout({
            style_class: 'dn-clock-widget',
            reactive: true,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._clockTime = new St.Label({
            style_class: 'dn-clock-time',
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._clockDate = new St.Label({
            style_class: 'dn-clock-date',
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._clockWidget.add_child(this._clockTime);
        this._clockWidget.add_child(this._clockDate);
        this._clockWidget.connect('button-press-event', () => {
            this._togglePanel();
            return Clutter.EVENT_STOP;
        });
        this._notchBox.add_child(this._clockWidget);

        // --- Expanded view: big clock + dummy cards ---
        this._expandedView = new St.BoxLayout({
            style_class: 'dn-expanded',
            orientation: Clutter.Orientation.VERTICAL,
            visible: false,
            opacity: 0,
            x_expand: true,
            y_expand: true,
        });
        this._notchBox.add_child(this._expandedView);

        const header = new St.BoxLayout({
            style_class: 'dn-expanded-head',
            orientation: Clutter.Orientation.VERTICAL,
            reactive: true,
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._expandedClock = new St.Label({
            style_class: 'dn-expanded-clock',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._expandedDate = new St.Label({
            style_class: 'dn-expanded-date',
            x_align: Clutter.ActorAlign.CENTER,
        });
        header.add_child(this._expandedClock);
        header.add_child(this._expandedDate);
        // Clicking the expanded header collapses again (it is inside the
        // notch, so the outside-click handler ignores it anyway).
        header.connect('button-press-event', () => {
            this._closePanel();
            return Clutter.EVENT_STOP;
        });
        this._expandedView.add_child(header);

        const row1 = new St.BoxLayout({style_class: 'dn-cards-row', x_expand: true});
        const row2 = new St.BoxLayout({style_class: 'dn-cards-row', x_expand: true});
        this._expandedView.add_child(row1);
        this._expandedView.add_child(row2);

        // Quick Notes — with a real entry, to prove typing / clicking
        // inside the panel never triggers the outside-click collapse.
        const notesCard = this._makeCard('document-edit-symbolic', 'Quick Notes',
            'Catatan dummy untuk uji layout.');
        this._noteEntry = new St.Entry({
            style_class: 'dn-note-entry',
            hint_text: 'Tulis catatan singkat…',
            can_focus: true,
            x_expand: true,
        });
        notesCard.add_child(this._noteEntry);
        row1.add_child(notesCard);

        // Timer — dummy, but its button really toggles, again to prove
        // inner controls stay usable while the panel is open.
        const timerCard = this._makeCard('alarm-symbolic', 'Timer',
            '25:00 • sesi fokus (dummy)');
        this._timerButton = new St.Button({
            label: 'Mulai',
            style_class: 'dn-card-button',
            x_align: Clutter.ActorAlign.START,
        });
        this._timerButton.connect('clicked', () => {
            this._timerRunning = !this._timerRunning;
            this._timerButton.label = this._timerRunning ? 'Jeda' : 'Mulai';
        });
        timerCard.add_child(this._timerButton);
        row1.add_child(timerCard);

        row2.add_child(this._makeCard('edit-paste-symbolic', 'Clipboard',
            '“Dynamic Island” — teks dummy terakhir yang disalin.'));
        row2.add_child(this._makeCard('appointment-soon-symbolic', 'Activity',
            'Tidak ada aktivitas terbaru (dummy).'));
    }

    _makeCard(iconName, title, body) {
        const card = new St.BoxLayout({
            style_class: 'dn-card',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
        });
        const head = new St.BoxLayout({style_class: 'dn-card-head'});
        head.add_child(new St.Icon({
            icon_name: iconName,
            icon_size: 16,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        head.add_child(new St.Label({
            text: title,
            style_class: 'dn-card-title',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        card.add_child(head);
        const bodyLabel = new St.Label({text: body, style_class: 'dn-card-body'});
        bodyLabel.get_clutter_text().set_line_wrap(true);
        card.add_child(bodyLabel);
        return card;
    }

    _updateClock() {
        if (!this._clockTime)
            return;
        const now = GLib.DateTime.new_now_local();
        const format = this._ifaceSettings.get_string('clock-format');
        const time = format === '12h' ? now.format('%I:%M %p') : now.format('%H:%M');
        this._clockTime.text = time;
        this._clockDate.text = now.format('%a, %e %B');
        this._expandedClock.text = format === '12h'
            ? now.format('%I:%M:%S %p') : now.format('%H:%M:%S');
        this._expandedDate.text = now.format('%A, %e %B %Y');
    }

    // ------------------------------------------------------- open / close

    _togglePanel() {
        if (this._state === State.COMPACT || this._state === State.COLLAPSING)
            this._openPanel();
        else
            this._closePanel();
    }

    _openPanel() {
        if (this._state === State.EXPANDED || this._state === State.EXPANDING)
            return;
        this._state = State.EXPANDING;
        const gen = ++this._animGen;

        this._clockWidget.visible = false;
        this._expandedView.visible = true;
        this._expandedView.remove_all_transitions();
        if (this._animationsEnabled()) {
            this._expandedView.ease({
                opacity: 255,
                duration: ANIM_MS,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            });
        } else {
            this._expandedView.opacity = 255;
        }

        this._animOnDone = () => {
            if (gen !== this._animGen)
                return;
            this._state = State.EXPANDED;
        };
        this._applySize(true);
        this._installOutsideHandlers();
    }

    _closePanel() {
        if (this._state === State.COMPACT || this._state === State.COLLAPSING)
            return;
        this._state = State.COLLAPSING;
        const gen = ++this._animGen;

        // Outside handlers are only needed while fully open / opening.
        this._removeOutsideHandlers();

        this._expandedView.remove_all_transitions();
        if (this._animationsEnabled()) {
            this._expandedView.ease({
                opacity: 0,
                duration: Math.round(ANIM_MS * 0.7),
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            });
        } else {
            this._expandedView.opacity = 0;
        }

        this._animOnDone = () => {
            if (gen !== this._animGen)
                return;
            this._expandedView.visible = false;
            this._clockWidget.visible = true;
            this._state = State.COMPACT;
        };
        this._applySize(true);

        // Without animation the ease never fires; finish synchronously.
        if (!this._animationsEnabled() && gen === this._animGen)
            this._animOnDone();
    }

    // Outside-click detection needs three channels, because no single
    // one sees every outside interaction on Wayland:
    //
    //  1. global.display 'notify::focus-window' — PRIMARY channel for
    //     application windows. Mutter filters pointer events before
    //     Clutter ever sees them: clicks inside client windows are
    //     processed by mutter / the client and are NOT passed on to
    //     Clutter, so the stage never emits captured-event for them
    //     (documented GNOME behaviour — stage events only cover Shell
    //     UI elements). The first version of this handler relied on
    //     captured-event alone, which is why clicks on app windows
    //     never closed the panel. A click on another window does
    //     reliably move MetaWindow focus, and interacting *inside*
    //     the notch (entry, buttons) never changes MetaWindow focus —
    //     so any focus-window change while open means "user went
    //     elsewhere": close. 'grab-op-begin' covers starting to drag
    //     a window by its titlebar.
    //  2. Stage captured-event with a COORDINATE hit-test — covers
    //     the clicks Clutter does see: Shell UI (top panel, dash,
    //     desktop background, Overview). Coordinates, not
    //     event.get_source(): after interacting inside the notch the
    //     source can be misleading (e.g. the actor holding key focus),
    //     the pointer position never lies.
    //  3. Overview 'showing' and workspace switches, connected in
    //     enable().
    //
    // Known limit, by design: a click inside the *already focused*
    // window changes neither focus nor reaches Clutter, so without a
    // modal grab (pushModal) — deliberately not used, it would eat
    // the first click — that one click cannot be observed. The panel
    // still closes on the next focus change, workspace switch,
    // Overview, titlebar drag, or Shell-UI click.
    _installOutsideHandlers() {
        if (this._stagePressId)
            return; // already installed — never stack duplicates

        this._focusWindowId = global.display.connect('notify::focus-window', () => {
            if (this._state === State.EXPANDED || this._state === State.EXPANDING)
                this._closePanel();
        });
        this._grabOpId = global.display.connect('grab-op-begin', () => {
            if (this._state === State.EXPANDED || this._state === State.EXPANDING)
                this._closePanel();
        });

        this._stagePressId = global.stage.connect('captured-event', (_a, event) => {
            const type = event.type();
            if (type !== Clutter.EventType.BUTTON_PRESS &&
                type !== Clutter.EventType.TOUCH_BEGIN)
                return Clutter.EVENT_PROPAGATE;
            if (this._state !== State.EXPANDED && this._state !== State.EXPANDING)
                return Clutter.EVENT_PROPAGATE;

            if (this._eventInsideNotch(event))
                return Clutter.EVENT_PROPAGATE;

            // Click outside (on Shell UI): close, but let the click
            // reach its real target. Closing is deferred to idle so
            // we never mutate the actor tree in the capture phase.
            this._scheduleClose();
            return Clutter.EVENT_PROPAGATE;
        });

        this._stageKeyId = global.stage.connect('key-press-event', (_a, event) => {
            if (event.get_key_symbol() !== Clutter.KEY_Escape)
                return Clutter.EVENT_PROPAGATE;
            if (this._state !== State.EXPANDED && this._state !== State.EXPANDING)
                return Clutter.EVENT_PROPAGATE;
            // If keyboard focus is inside the panel (e.g. the notes
            // entry), Escape belongs to that control first.
            const focus = global.stage.get_key_focus();
            if (focus && this._isInsideNotch(focus))
                return Clutter.EVENT_PROPAGATE;
            this._closePanel();
            return Clutter.EVENT_STOP;
        });
    }

    _removeOutsideHandlers() {
        if (this._stagePressId) {
            global.stage.disconnect(this._stagePressId);
            this._stagePressId = 0;
        }
        if (this._stageKeyId) {
            global.stage.disconnect(this._stageKeyId);
            this._stageKeyId = 0;
        }
        if (this._focusWindowId) {
            global.display.disconnect(this._focusWindowId);
            this._focusWindowId = 0;
        }
        if (this._grabOpId) {
            global.display.disconnect(this._grabOpId);
            this._grabOpId = 0;
        }
        if (this._closeIdleId) {
            GLib.source_remove(this._closeIdleId);
            this._closeIdleId = 0;
        }
    }

    _scheduleClose() {
        if (this._closeIdleId)
            return;
        this._closeIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._closeIdleId = 0;
            this._closePanel();
            return GLib.SOURCE_REMOVE;
        });
    }

    _eventInsideNotch(event) {
        // Coordinate hit-test first: decisive regardless of which
        // actor the event claims as its source.
        try {
            const [x, y] = event.get_coords();
            const [nx, ny] = this._notch.get_transformed_position();
            const [nw, nh] = this._notch.get_transformed_size();
            if (nw > 0 && nh > 0)
                return x >= nx && x < nx + nw && y >= ny && y < ny + nh;
        } catch (_e) {
            // fall through to the source check
        }
        const source = event.get_source();
        return !!(source && this._isInsideNotch(source));
    }

    _isInsideNotch(actor) {
        try {
            return actor === this._notch || this._notch.contains(actor);
        } catch (_e) {
            return false;
        }
    }

    // ------------------------------------------------------------ geometry

    _animationsEnabled() {
        return this._ifaceSettings?.get_boolean('enable-animations') ?? true;
    }

    _refreshGeometry() {
        // Settings / monitor changes during an animation re-target the
        // running ease; otherwise they snap (same as the old behaviour).
        if (this._state === State.EXPANDING || this._state === State.COLLAPSING)
            this._applySize(true);
        else
            this._applySize(false);
    }

    _targetExpanded() {
        return this._state === State.EXPANDING || this._state === State.EXPANDED;
    }

    _applySize(animate = true) {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor || !this._notch)
            return;

        const style = this._settings.get_enum('notch-style');
        const position = this._settings.get_enum('pill-position');
        const w = this._settings.get_int('notch-width');
        const h = this._settings.get_int('notch-height');
        const expanded = this._targetExpanded();

        let x, y, notchW, notchH;

        if (expanded) {
            // The expanded panel is always a wide rectangle anchored to
            // the same edge the pill lives on — no width/height swap, so
            // the card grid never gets squeezed on left/right positions.
            notchW = Math.min(EXPANDED_W, Math.max(280, monitor.width - 16));
            notchH = Math.min(EXPANDED_H, Math.max(200, monitor.height - 16));
            if (style === 0 || position === 0) {          // apple / top
                x = Math.round(monitor.x + (monitor.width - notchW) / 2);
                y = style === 0 ? monitor.y : monitor.y + 6;
            } else if (position === 1) {                  // bottom
                x = Math.round(monitor.x + (monitor.width - notchW) / 2);
                y = monitor.y + monitor.height - notchH - 6;
            } else if (position === 2) {                  // left
                x = monitor.x + 6;
                y = Math.round(monitor.y + (monitor.height - notchH) / 2);
            } else {                                      // right
                x = monitor.x + monitor.width - notchW - 6;
                y = Math.round(monitor.y + (monitor.height - notchH) / 2);
            }
            this._clockWidget.orientation = Clutter.Orientation.HORIZONTAL;
        } else if (style === 0) {                         // apple, compact
            x = Math.round(monitor.x + (monitor.width - w) / 2);
            y = monitor.y;
            notchW = w;
            notchH = h;
            this._clockWidget.orientation = Clutter.Orientation.HORIZONTAL;
        } else {
            switch (position) {
            case 0:
                x = Math.round(monitor.x + (monitor.width - w) / 2);
                y = monitor.y + 6;
                notchW = w; notchH = h;
                this._clockWidget.orientation = Clutter.Orientation.HORIZONTAL;
                break;
            case 1:
                x = Math.round(monitor.x + (monitor.width - w) / 2);
                y = monitor.y + monitor.height - h - 6;
                notchW = w; notchH = h;
                this._clockWidget.orientation = Clutter.Orientation.HORIZONTAL;
                break;
            case 2:
                x = monitor.x + 6;
                y = Math.round(monitor.y + (monitor.height - w) / 2);
                notchW = h; notchH = w;
                this._clockWidget.orientation = Clutter.Orientation.VERTICAL;
                break;
            default:
                x = monitor.x + monitor.width - h - 6;
                y = Math.round(monitor.y + (monitor.height - w) / 2);
                notchW = h; notchH = w;
                this._clockWidget.orientation = Clutter.Orientation.VERTICAL;
                break;
            }
        }

        const onDone = this._animOnDone;
        if (animate && this._animationsEnabled()) {
            // Kill any running ease first: a new ease starts from the
            // current geometry, so rapid toggling reverses smoothly
            // instead of stacking transitions or jumping.
            this._notch.remove_all_transitions();
            this._notch.ease({
                x, y, width: notchW, height: notchH,
                duration: ANIM_MS,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                onComplete: () => onDone?.(),
            });
        } else {
            this._notch.remove_all_transitions();
            this._notch.set_position(x, y);
            this._notch.set_size(notchW, notchH);
            onDone?.();
        }
    }

    // -------------------------------------------------------- notch styling

    _applyNotchStyle() {
        if (!this._notch)
            return;
        const apple = this._settings.get_enum('notch-style') === 0;
        const bg = this._settings.get_string('notch-bg');
        const r = this._settings.get_int('notch-radius');

        if (apple) {
            this._notch.set_style(`background-color: ${bg}; border-radius: 0 0 ${r}px ${r}px;`);
            this._notch.remove_style_class_name('dn-notch-pill');
            this._notch.add_style_class_name('dn-notch-apple');
        } else {
            this._notch.set_style(`background-color: ${bg}; border-radius: ${r}px;`);
            this._notch.remove_style_class_name('dn-notch-apple');
            this._notch.add_style_class_name('dn-notch-pill');
        }

        // Foreground: explicit light/dark, or auto from the notch's own
        // known background color.
        const fgMode = this._settings.get_enum('notch-text-mode');
        let fg = null;
        if (fgMode === 1)
            fg = 'light';
        else if (fgMode === 2)
            fg = 'dark';
        else {
            const c = parseColor(bg);
            fg = c && luminance(c) > 0.6 ? 'dark' : 'light';
        }
        this._notch.remove_style_class_name('dn-fg-light');
        this._notch.remove_style_class_name('dn-fg-dark');
        this._notch.add_style_class_name(`dn-fg-${fg}`);
    }

    // ------------------------------------------------- panel background

    _schedulePanelUpdate() {
        if (this._panelDebounceId)
            return;
        this._panelDebounceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
            PANEL_DEBOUNCE_MS, () => {
                this._panelDebounceId = 0;
                this._updatePanelAppearance();
                return GLib.SOURCE_REMOVE;
            });
    }

    _scheduleOverviewRecheck() {
        // After 'hidden', GNOME removes the panel's :overview styling on
        // its own schedule; re-check once after that has settled so the
        // final state is ours, not a leftover of the Overview transition.
        if (this._overviewRecheckId)
            GLib.source_remove(this._overviewRecheckId);
        this._overviewRecheckId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 350, () => {
            this._overviewRecheckId = 0;
            this._updatePanelAppearance();
            return GLib.SOURCE_REMOVE;
        });
    }

    // Returns 'theme' | 'transparent' | 'solid' | 'semi'
    _desiredPanelBg() {
        const mode = this._settings.get_enum('panel-bg-mode'); // theme, transparent, solid, semi-transparent

        // Lock / login screens and the Overview always get the stock
        // transparent overview look, whatever the configured mode.
        if (!Main.sessionMode.hasWindows ||
            Main.overview.visible || Main.overview.visibleTarget ||
            Main.panel.has_style_pseudo_class('overview'))
            return 'transparent';

        // The original 'transparent-panel' key stays the dynamic switch,
        // exactly as in the shipped schema: while it is on, the panel is
        // transparent unless a window on the active workspace touches
        // it. When a window does touch it, solid/semi use their color
        // and anything else falls back to the stock theme look.
        if (this._settings.get_boolean('transparent-panel')) {
            if (!Main.layoutManager.primaryMonitor)
                return 'transparent';
            const activeWorkspace = global.workspace_manager.get_active_workspace();
            const windows = activeWorkspace.list_windows().filter(metaWindow => {
                return metaWindow.is_on_primary_monitor() &&
                       metaWindow.showing_on_its_workspace() &&
                       !metaWindow.is_hidden() &&
                       metaWindow.get_window_type() !== Meta.WindowType.DESKTOP;
            });
            const panelTop = Main.panel.get_transformed_position()[1];
            const panelBottom = panelTop + Main.panel.get_height();
            const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
            const near = windows.some(metaWindow =>
                metaWindow.get_frame_rect().y < panelBottom + 5 * scale);
            if (!near)
                return 'transparent';
            if (mode === 2)
                return 'solid';
            if (mode === 3)
                return 'semi';
            return 'theme';
        }

        switch (mode) {
        case 1:
            return 'transparent';
        case 2:
            return 'solid';
        case 3:
            return 'semi';
        case 0:
        default:
            return 'theme';
        }
    }

    _desiredPanelFg(bg) {
        const fgMode = this._settings.get_enum('panel-text-mode'); // auto, light, dark
        if (fgMode === 1)
            return 'light';
        if (fgMode === 2)
            return 'dark';
        // Auto: only computed from a color we actually know.
        if (bg === 'solid' || bg === 'semi') {
            const c = parseColor(this._settings.get_string('panel-color'));
            return c && luminance(c) > 0.6 ? 'dark' : 'light';
        }
        if (bg === 'transparent')
            return 'light'; // documented fallback — wallpaper is NOT read
        return null; // theme: leave the theme's own foreground alone
    }

    _updatePanelAppearance() {
        if (!this._settings)
            return;
        const bg = this._desiredPanelBg();
        const fg = this._desiredPanelFg(bg);

        let style = null;
        if (bg === 'solid' || bg === 'semi') {
            const c = parseColor(this._settings.get_string('panel-color'));
            if (c)
                style = `background-color: ${rgbaString(c, bg === 'solid' ? 1 : c.a)};`;
        }

        // The whole point of the rework: if nothing changed, touch
        // nothing. Re-setting the same style restarts the transition.
        if (bg === this._appliedPanelBg && style === this._appliedPanelStyle &&
            fg === this._appliedPanelFg)
            return;

        const panel = Main.panel;
        panel.remove_style_class_name('dn-panel-transparent');
        if (bg === 'transparent')
            panel.add_style_class_name('dn-panel-transparent');

        if (style !== this._appliedPanelStyle) {
            // Plain inline background-color only — no !important, no
            // background-image/box-shadow resets — so the transition
            // declared on #panel in stylesheet.css can animate it.
            panel.set_style(style);
            const cornerStyle = (bg === 'solid' || bg === 'semi')
                ? `-panel-corner-background-color: ${style.slice('background-color: '.length, -1)};`
                : null;
            for (const child of panel.get_children()) {
                if (child.has_style_class_name('panel-corner'))
                    child.set_style(cornerStyle);
            }
        }

        panel.remove_style_class_name('dn-fg-light');
        panel.remove_style_class_name('dn-fg-dark');
        if (fg)
            panel.add_style_class_name(`dn-fg-${fg}`);

        this._appliedPanelBg = bg;
        this._appliedPanelStyle = style;
        this._appliedPanelFg = fg;
    }

    _restorePanel() {
        const panel = Main.panel;
        panel.remove_style_class_name('dn-panel-transparent');
        panel.remove_style_class_name('dn-fg-light');
        panel.remove_style_class_name('dn-fg-dark');
        // Also clears the legacy 'transparent-top-bar' class + inline
        // styles an older build of this extension may have left behind.
        panel.remove_style_class_name('transparent-top-bar');
        panel.set_style(null);
        for (const child of panel.get_children()) {
            if (child.has_style_class_name('panel-corner'))
                child.set_style(null);
        }
        this._appliedPanelBg = null;
        this._appliedPanelStyle = null;
        this._appliedPanelFg = null;
    }

    // ------------------------------------------------------ window tracking

    _onWindowActorAdded(_container, metaWindowActor) {
        if (!this._windowSignalIds || this._windowSignalIds.has(metaWindowActor))
            return;
        this._windowSignalIds.set(metaWindowActor, [
            metaWindowActor.connect('notify::allocation', () => this._schedulePanelUpdate()),
            metaWindowActor.connect('notify::visible', () => this._schedulePanelUpdate()),
        ]);
        this._schedulePanelUpdate();
    }

    _onWindowActorRemoved(_container, metaWindowActor) {
        if (!this._windowSignalIds)
            return;
        for (const signalId of this._windowSignalIds.get(metaWindowActor) ?? []) {
            try {
                metaWindowActor.disconnect(signalId);
            } catch (_e) {}
        }
        this._windowSignalIds.delete(metaWindowActor);
        this._schedulePanelUpdate();
    }
}
