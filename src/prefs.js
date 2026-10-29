// Preferences for Dynamic Notch.
import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

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
        const spin = (title, key, lower, upper) => {
            const row = new Adw.SpinRow({
                title,
                adjustment: new Gtk.Adjustment({
                    lower, upper, step_increment: 1, page_increment: 4,
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
        // With useAlpha, the chosen color is stored as an rgba() string;
        // the Shell side forces alpha to 1 in Solid mode and uses the
        // picked alpha in Semi-transparent mode.
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
    }
}
