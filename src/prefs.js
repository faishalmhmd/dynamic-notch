// Preferences for Dynamic Notch.
import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Same formatter as the Shell side: HH:MM DD-MMM-YY.
function formatDateTime(now) {
    const pad = v => `${v}`.padStart(2, '0');
    return `${pad(now.get_hour())}:${pad(now.get_minute())} ` +
        `${pad(now.get_day_of_month())}-${MONTH_ABBR[now.get_month() - 1]}-` +
        `${pad(now.get_year() % 100)}`;
}

const AREA_WIDGETS = [
    ['actions', 'Quick Actions'],
    ['calendar', 'Calendar'],
    ['notifications', 'Notifications'],
    ['timer', 'Timer Strip'],
];
const CARD_WIDGETS = [
    ['notes', 'Quick Notes'],
    ['timer-summary', 'Timer Summary'],
    ['activity', 'Recent Activity'],
    ['clipboard', 'Clipboard'],
    ['status', 'System Status'],
    ['upcoming', 'Upcoming Events'],
    ['shortcuts', 'Shortcuts'],
    ['focus', 'Focus Session'],
    ['media', 'Media'],
];
const LAYOUT_KEYS = ['layout-mode', 'grid-gap', 'expanded-width',
    'expanded-height', 'enabled-widgets', 'widget-order', 'wide-widgets'];

export default class DynamicNotchPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage();
        window.add(page);

        const toggle = (title, key) => {
            const row = new Adw.SwitchRow({title});
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            return row;
        };
        const spin = (title, key, lower, upper, step = 1) => {
            const row = new Adw.SpinRow({
                title,
                adjustment: new Gtk.Adjustment({
                    lower, upper, step_increment: step, page_increment: 4,
                }),
            });
            settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
            return row;
        };
        const enumRow = (title, key, nicks) => {
            const row = new Adw.ComboRow({
                title,
                model: new Gtk.StringList({strings: nicks}),
            });
            row.selected = settings.get_enum(key);
            row.connect('notify::selected', () => settings.set_enum(key, row.selected));
            settings.connect(`changed::${key}`, () => {
                row.selected = settings.get_enum(key);
            });
            return row;
        };
        // useAlpha stores rgba(); alpha is forced in Solid mode, used as picked in Semi mode.
        const colorRow = (title, key, useAlpha) => {
            const row = new Adw.ActionRow({title});
            const button = new Gtk.ColorButton({
                valign: Gtk.Align.CENTER,
                use_alpha: useAlpha,
            });
            const rgba = new Gdk.RGBA();
            if (rgba.parse(settings.get_string(key)))
                button.set_rgba(rgba);
            button.connect('color-set', () => {
                const c = button.get_rgba();
                const rgb = `${Math.round(c.red * 255)},${Math.round(c.green * 255)},${Math.round(c.blue * 255)}`;
                settings.set_string(key, useAlpha
                    ? `rgba(${rgb},${c.alpha.toFixed(2)})`
                    : `rgb(${rgb})`);
            });
            row.add_suffix(button);
            return row;
        };
        // Switch bound manually to membership of id in a string-array key.
        const arraySwitches = [];
        const arraySwitch = (title, key, id) => {
            const row = new Adw.SwitchRow({title});
            row.active = settings.get_strv(key).includes(id);
            row.connect('notify::active', () => {
                const arr = settings.get_strv(key);
                const has = arr.includes(id);
                if (row.active && !has)
                    settings.set_strv(key, [...arr, id]);
                else if (!row.active && has)
                    settings.set_strv(key, arr.filter(x => x !== id));
            });
            arraySwitches.push({row, key, id});
            return row;
        };
        const refreshArraySwitches = () => {
            for (const {row, key, id} of arraySwitches)
                row.active = settings.get_strv(key).includes(id);
        };

        // --- Top panel (GNOME panel itu sendiri) ---
        const panel = new Adw.PreferencesGroup({
            title: 'Top Panel',
            description: 'Background panel GNOME dan warna teks/ikonnya. ' +
                'Berlaku langsung, tanpa restart Shell. Transparent Panel ' +
                'adalah saklar bawaan: panel transparan selama tidak ada ' +
                'jendela yang menyentuhnya, lalu kembali ke background ' +
                'terpilih di bawah (Solid/Semi memakai warnanya, sisanya ' +
                'kembali ke tampilan stock).',
        });
        panel.add(toggle('Transparent Panel', 'transparent-panel'));
        panel.add(enumRow('Panel Background', 'panel-bg-mode',
            ['Theme (GNOME default)', 'Transparent', 'Solid color',
                'Semi-transparent']));
        panel.add(colorRow('Panel Color', 'panel-color', true));
        panel.add(enumRow('Panel Text & Icons', 'panel-text-mode',
            ['Auto (from panel color)', 'Light', 'Dark']));
        page.add(panel);

        const style = new Adw.PreferencesGroup({title: 'Style'});
        style.add(enumRow('Notch Style', 'notch-style', ['Apple (Mac Mode)', 'Pill']));
        style.add(enumRow('Pill Position', 'pill-position', ['Top', 'Bottom', 'Left', 'Right']));
        page.add(style);

        const dimensions = new Adw.PreferencesGroup({title: 'Dimensions'});
        dimensions.add(spin('Width (px)', 'notch-width', 120, 600));
        dimensions.add(spin('Height (px)', 'notch-height', 30, 100));
        dimensions.add(spin('Corner Radius (px)', 'notch-radius', 0, 40));
        page.add(dimensions);

        const appearance = new Adw.PreferencesGroup({title: 'Notch Appearance'});
        appearance.add(colorRow('Notch Background Color', 'notch-bg', false));
        appearance.add(enumRow('Notch Text', 'notch-text-mode',
            ['Auto (from notch color)', 'Light', 'Dark']));
        page.add(appearance);

        // ---------------- Layout page ----------------
        const layoutPage = new Adw.PreferencesPage();
        window.add(layoutPage);

        const modeGroup = new Adw.PreferencesGroup({
            title: 'Layout Mode',
            description: 'Berlaku langsung ke island (panel yang sedang ' +
                'terbuka akan ditutup dulu). Full dan Split adalah preset ' +
                'tetap; pengaturan widget di bawah hanya berlaku di Custom.',
        });
        const modeRow = enumRow('Expanded Layout', 'layout-mode',
            ['Full', 'Split', 'Custom']);
        modeGroup.add(modeRow);
        layoutPage.add(modeGroup);

        const gridGroup = new Adw.PreferencesGroup({title: 'Grid & Panel Size'});
        gridGroup.add(spin('Grid Gap (px)', 'grid-gap', 2, 24));
        gridGroup.add(spin('Expanded Width (px)', 'expanded-width', 640, 1600, 10));
        gridGroup.add(spin('Expanded Height (px)', 'expanded-height', 400, 900, 10));
        layoutPage.add(gridGroup);

        const widgetGroup = new Adw.PreferencesGroup({
            title: 'Widgets (Custom Mode)',
            description: 'Widget yang dimatikan tidak ditampilkan di mode Custom.',
        });
        for (const [id, title] of [...AREA_WIDGETS, ...CARD_WIDGETS])
            widgetGroup.add(arraySwitch(title, 'enabled-widgets', id));
        layoutPage.add(widgetGroup);

        const orderGroup = new Adw.PreferencesGroup({
            title: 'Card Order (Custom Mode)',
            description: 'Urutan kartu kecil mengisi slot grid dari kiri ke kanan, atas ke bawah.',
        });
        layoutPage.add(orderGroup);
        const orderRows = [];
        const cardTitle = id => CARD_WIDGETS.find(([x]) => x === id)?.[1] ?? id;
        const currentOrder = () => {
            const known = CARD_WIDGETS.map(([id]) => id);
            const order = settings.get_strv('widget-order')
                .filter(id => known.includes(id));
            for (const id of known) {
                if (!order.includes(id))
                    order.push(id);
            }
            return order;
        };
        const rebuildOrderRows = () => {
            for (const row of orderRows)
                orderGroup.remove(row);
            orderRows.length = 0;
            const order = currentOrder();
            order.forEach((id, i) => {
                const row = new Adw.ActionRow({
                    title: cardTitle(id),
                    subtitle: `Position ${i + 1}`,
                });
                const up = new Gtk.Button({
                    icon_name: 'go-up-symbolic',
                    valign: Gtk.Align.CENTER,
                    sensitive: i > 0,
                });
                up.add_css_class('flat');
                up.connect('clicked', () => {
                    const arr = currentOrder();
                    [arr[i - 1], arr[i]] = [arr[i], arr[i - 1]];
                    settings.set_strv('widget-order', arr);
                    rebuildOrderRows();
                });
                const down = new Gtk.Button({
                    icon_name: 'go-down-symbolic',
                    valign: Gtk.Align.CENTER,
                    sensitive: i < order.length - 1,
                });
                down.add_css_class('flat');
                down.connect('clicked', () => {
                    const arr = currentOrder();
                    [arr[i + 1], arr[i]] = [arr[i], arr[i + 1]];
                    settings.set_strv('widget-order', arr);
                    rebuildOrderRows();
                });
                row.add_suffix(up);
                row.add_suffix(down);
                orderGroup.add(row);
                orderRows.push(row);
            });
        };
        rebuildOrderRows();

        const wideGroup = new Adw.PreferencesGroup({
            title: 'Wide Cards (Custom Mode)',
            description: 'Kartu wide memakai dua kolom grid. Bila tidak muat di sisa baris, kartu pindah ke baris berikutnya.',
        });
        for (const [id, title] of CARD_WIDGETS)
            wideGroup.add(arraySwitch(title, 'wide-widgets', id));
        layoutPage.add(wideGroup);

        const defaultsGroup = new Adw.PreferencesGroup({title: 'Defaults'});
        const resetRow = new Adw.ActionRow({
            title: 'Restore Layout Defaults',
            subtitle: 'Mode Full, gap 8, ukuran 1024×560, semua widget aktif, urutan bawaan.',
        });
        const resetButton = new Gtk.Button({
            label: 'Restore',
            valign: Gtk.Align.CENTER,
        });
        resetButton.add_css_class('destructive-action');
        resetButton.connect('clicked', () => {
            for (const key of LAYOUT_KEYS)
                settings.reset(key);
            modeRow.selected = settings.get_enum('layout-mode');
            refreshArraySwitches();
            rebuildOrderRows();
        });
        resetRow.add_suffix(resetButton);
        defaultsGroup.add(resetRow);
        layoutPage.add(defaultsGroup);

        // ---------------- Timer & Clock page ----------------
        const timerPage = new Adw.PreferencesPage();
        window.add(timerPage);

        const timerGroup = new Adw.PreferencesGroup({
            title: 'Timer Defaults',
            description: 'Dipakai saat extension dimuat dan oleh tombol Reset di strip timer. Countdown yang sedang berjalan tidak disimpan.',
        });
        const titleRow = new Adw.EntryRow({title: 'Default Timer Title'});
        settings.bind('timer-title', titleRow, 'text',
            Gio.SettingsBindFlags.DEFAULT);
        timerGroup.add(titleRow);
        const durRow = new Adw.SpinRow({
            title: 'Default Duration (minutes)',
            adjustment: new Gtk.Adjustment({
                lower: 1, upper: 5999, step_increment: 1, page_increment: 5,
            }),
        });
        let durGuard = false;
        durRow.value = Math.max(1, Math.round(settings.get_int('timer-duration') / 60));
        durRow.connect('notify::value', () => {
            if (!durGuard)
                settings.set_int('timer-duration', Math.round(durRow.value) * 60);
        });
        settings.connect('changed::timer-duration', () => {
            durGuard = true;
            durRow.value = Math.max(1, Math.round(settings.get_int('timer-duration') / 60));
            durGuard = false;
        });
        timerGroup.add(durRow);
        timerPage.add(timerGroup);

        const clockGroup = new Adw.PreferencesGroup({title: 'Date & Time'});
        clockGroup.add(new Adw.ActionRow({
            title: 'Display Format',
            subtitle: 'HH:MM DD-MMM-YY — 24-hour, two-digit day, English month abbreviation, two-digit year. Dipakai di compact island dan panel expanded.',
        }));
        const previewRow = new Adw.ActionRow({title: 'Preview'});
        const previewLabel = new Gtk.Label({
            label: formatDateTime(GLib.DateTime.new_now_local()),
            valign: Gtk.Align.CENTER,
        });
        previewLabel.add_css_class('monospace');
        previewRow.add_suffix(previewLabel);
        clockGroup.add(previewRow);
        timerPage.add(clockGroup);

        let previewId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            previewLabel.label = formatDateTime(GLib.DateTime.new_now_local());
            return GLib.SOURCE_CONTINUE;
        });
        window.connect('close-request', () => {
            if (previewId)
                GLib.source_remove(previewId);
            previewId = 0;
        });
    }
}
