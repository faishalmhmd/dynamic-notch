// Dynamic Notch — simple clock notch, GNOME Shell 51.
//
// Menampilkan jam dan tanggal yang bisa di-expand.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

export default class DynamicNotchExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._ifaceSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._expanded = false;

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
            this._applySize(false);
            this._updateTransparent();
        });
        this._monitorsChangedId = Main.layoutManager.connect('monitors-changed', () => {
            this._applySize(false);
            this._updateTransparent();
        });

        // --- Transparency (zhanghai transparent-top-bar logic) ---
        this._actorSignalIds = new Map();
        this._windowSignalIds = new Map();

        this._actorSignalIds.set(Main.overview, [
            Main.overview.connect('showing', this._updateTransparent.bind(this)),
            Main.overview.connect('hiding', this._updateTransparent.bind(this)),
            Main.overview.connect('hidden', this._updateTransparent.bind(this)),
        ]);

        this._actorSignalIds.set(Main.sessionMode, [
            Main.sessionMode.connect('updated', this._updateTransparent.bind(this)),
        ]);

        this._actorSignalIds.set(global.workspace_manager, [
            global.workspace_manager.connect('active-workspace-changed', this._updateTransparent.bind(this)),
        ]);

        this._actorSignalIds.set(global.display, [
            global.display.connect('restacked', this._updateTransparent.bind(this)),
        ]);

        for (const metaWindowActor of global.get_window_actors()) {
            this._onWindowActorAdded(metaWindowActor.get_parent(), metaWindowActor);
        }

        this._actorSignalIds.set(global.window_group, [
            global.window_group.connect('child-added', this._onWindowActorAdded.bind(this)),
            global.window_group.connect('child-removed', this._onWindowActorRemoved.bind(this)),
        ]);

        this._updateTransparent();
        // --- End transparency ---

        // Close notch panel when clicking outside
        this._stagePressId = global.stage.connect('captured-event', (_a, event) => {
            if (!this._expanded || event.type() !== Clutter.EventType.BUTTON_PRESS)
                return Clutter.EVENT_PROPAGATE;
            const source = event.get_source();
            if (source && this._notch.contains(source))
                return Clutter.EVENT_PROPAGATE;
            this._closePanel();
            return Clutter.EVENT_STOP;
        });

        // Keyboard shortcut to close
        this._stageKeyId = global.stage.connect('key-press-event', (_a, event) => {
            if (this._expanded && event.get_key_symbol() === Clutter.KEY_Escape) {
                this._closePanel();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
    }

    disable() {
        if (this._clockTimeoutId)
            GLib.source_remove(this._clockTimeoutId);
        this._settings.disconnect(this._settingsChangedId);
        Main.layoutManager.disconnect(this._monitorsChangedId);
        global.stage.disconnect(this._stagePressId);
        global.stage.disconnect(this._stageKeyId);

        // Cleanup transparency signals
        for (const actorSignalIds of [this._actorSignalIds, this._windowSignalIds]) {
            if (!actorSignalIds)
                continue;
            for (const [actor, signalIds] of actorSignalIds) {
                for (const signalId of signalIds)
                    actor.disconnect(signalId);
            }
        }
        this._actorSignalIds = null;
        this._windowSignalIds = null;

        this._setTransparent(false);

        Main.layoutManager.removeChrome(this._notch);
        this._notch.destroy();
        this._notch = null;
        this._ifaceSettings = null;
        this._settings = null;
    }

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
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._notch.add_child(this._notchBox);

        // Clock display (collapsed)
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
        this._notchBox.add_child(this._clockWidget);

        // Expanded clock (hidden by default)
        this._expandedClock = new St.Label({
            style_class: 'dn-expanded-clock',
            visible: false,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._notchBox.add_child(this._expandedClock);

        // Click to toggle
        this._clockWidget.connect('button-press-event', () => {
            this._togglePanel();
            return Clutter.EVENT_STOP;
        });
    }

    _updateClock() {
        const now = GLib.DateTime.new_now_local();
        const format = this._ifaceSettings.get_string('clock-format');
        const time = format === '12h' ? now.format('%I:%M %p') : now.format('%H:%M');
        this._clockTime.text = time;
        this._clockDate.text = now.format('%a, %e %B');
        this._expandedClock.text = now.format('%H:%M:%S');
    }

    _togglePanel() {
        if (this._expanded)
            this._closePanel();
        else
            this._openPanel();
    }

    _openPanel() {
        this._expanded = true;
        this._clockWidget.visible = false;
        this._expandedClock.visible = true;
        this._applySize();
    }

    _closePanel() {
        this._expanded = false;
        this._clockWidget.visible = true;
        this._expandedClock.visible = false;
        this._applySize();
    }

    _applyNotchStyle() {
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
    }

    _applySize(animate = true) {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;

        const style = this._settings.get_enum('notch-style');
        const position = this._settings.get_enum('pill-position');
        const w = this._settings.get_int('notch-width');
        const h = this._settings.get_int('notch-height');

        let x, y, notchW, notchH;
        const expandedW = this._expanded ? 300 : w;
        const expandedH = this._expanded ? 150 : h;

        if (style === 0) {
            x = Math.round(monitor.x + (monitor.width - expandedW) / 2);
            y = monitor.y;
            notchW = expandedW;
            notchH = expandedH;
            this._clockWidget.vertical = false;
        } else {
            switch (position) {
                case 0: // top
                    x = Math.round(monitor.x + (monitor.width - expandedW) / 2);
                    y = monitor.y + 6;
                    notchW = expandedW;
                    notchH = expandedH;
                    this._clockWidget.vertical = false;
                    break;
                case 1: // bottom
                    x = Math.round(monitor.x + (monitor.width - expandedW) / 2);
                    y = monitor.y + monitor.height - expandedH - 6;
                    notchW = expandedW;
                    notchH = expandedH;
                    this._clockWidget.vertical = false;
                    break;
                case 2: // left
                    x = monitor.x + 6;
                    y = Math.round(monitor.y + (monitor.height - expandedH) / 2);
                    notchW = expandedH;
                    notchH = expandedW;
                    this._clockWidget.vertical = true;
                    break;
                case 3: // right
                    x = monitor.x + monitor.width - expandedH - 6;
                    y = Math.round(monitor.y + (monitor.height - expandedW) / 2);
                    notchW = expandedH;
                    notchH = expandedW;
                    this._clockWidget.vertical = true;
                    break;
            }
        }

        const animations = this._ifaceSettings.get_boolean('enable-animations');
        if (animate && animations) {
            this._notch.ease({
                x, y, width: notchW, height: notchH,
                duration: 220,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            });
        } else {
            this._notch.set_position(x, y);
            this._notch.set_size(notchW, notchH);
        }
    }

    // --- Transparency: zhanghai transparent-top-bar exact logic ---

    _updateTransparent() {
        if (!this._settings.get_boolean('transparent-panel')) {
            this._setTransparent(false);
            return;
        }

        // Ketika di overview (klik Windows key / menu activities / swipe 3 jari) -> selalu transparent
        if (Main.overview.visibleTarget || Main.overview.visible ||
            Main.panel.has_style_pseudo_class('overview') || !Main.sessionMode.hasWindows) {
            this._setTransparent(true);
            return;
        }

        if (!Main.layoutManager.primaryMonitor)
            return;

        // Ambil semua window di workspace aktif pada primary monitor yang visible
        const workspaceManager = global.workspace_manager;
        const activeWorkspace = workspaceManager.get_active_workspace();
        const windows = activeWorkspace.list_windows().filter(metaWindow => {
            return metaWindow.is_on_primary_monitor() &&
                   metaWindow.showing_on_its_workspace() &&
                   !metaWindow.is_hidden() &&
                   metaWindow.get_window_type() !== Meta.WindowType.DESKTOP;
        });

        // Cek jika ada window yang dekat dengan top panel
        const panelTop = Main.panel.get_transformed_position()[1];
        const panelBottom = panelTop + Main.panel.get_height();
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const isNearEnough = windows.some(metaWindow => {
            const verticalPosition = metaWindow.get_frame_rect().y;
            return verticalPosition < panelBottom + 5 * scale;
        });

        this._setTransparent(!isNearEnough);
    }

    _setTransparent(transparent) {
        if (transparent) {
            Main.panel.add_style_class_name('transparent-top-bar');
            Main.panel.set_style(
                'background-color: transparent !important; ' +
                'background-image: none !important; ' +
                'box-shadow: none !important;'
            );
            for (const child of Main.panel.get_children()) {
                if (child.has_style_class_name('panel-corner')) {
                    child.set_style(
                        '-panel-corner-background-color: transparent !important; ' +
                        '-panel-corner-border-color: transparent !important;'
                    );
                }
            }
        } else {
            Main.panel.remove_style_class_name('transparent-top-bar');
            Main.panel.set_style(null);
            for (const child of Main.panel.get_children()) {
                if (child.has_style_class_name('panel-corner'))
                    child.set_style(null);
            }
        }
    }

    _onWindowActorAdded(_container, metaWindowActor) {
        this._windowSignalIds.set(metaWindowActor, [
            metaWindowActor.connect('notify::allocation', this._updateTransparent.bind(this)),
            metaWindowActor.connect('notify::visible', this._updateTransparent.bind(this)),
        ]);
        this._updateTransparent();
    }

    _onWindowActorRemoved(_container, metaWindowActor) {
        for (const signalId of this._windowSignalIds.get(metaWindowActor) ?? [])
            metaWindowActor.disconnect(signalId);
        this._windowSignalIds.delete(metaWindowActor);
        this._updateTransparent();
    }
}
