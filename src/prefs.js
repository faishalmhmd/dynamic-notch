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
        const colorRow = (title, key) => {
            const row = new Adw.ActionRow({title});
            const button = new Gtk.ColorButton({valign: Gtk.Align.CENTER});
            const rgba = new Gdk.RGBA();
            if (rgba.parse(settings.get_string(key)))
                button.set_rgba(rgba);
            button.connect('color-set', () => {
                const c = button.get_rgba();
                settings.set_string(key, `rgb(${Math.round(c.red * 255)},${Math.round(c.green * 255)},${Math.round(c.blue * 255)})`);
            });
            row.add_suffix(button);
            return row;
        };

        const style = new Adw.PreferencesGroup({title: 'Style'});
        style.add(enumRow('Notch Style', 'notch-style', ['Apple (Mac Mode)', 'Pill']));
        style.add(enumRow('Pill Position', 'pill-position', ['Top', 'Bottom', 'Left', 'Right']));
        page.add(style);

        const dimensions = new Adw.PreferencesGroup({title: 'Dimensions'});
        dimensions.add(spin('Width (px)', 'notch-width', 120, 600));
        dimensions.add(spin('Height (px)', 'notch-height', 30, 100));
        dimensions.add(spin('Corner Radius (px)', 'notch-radius', 0, 40));
        page.add(dimensions);

        const appearance = new Adw.PreferencesGroup({title: 'Appearance'});
        appearance.add(colorRow('Background Color', 'notch-bg'));
        appearance.add(toggle('Transparent Panel', 'transparent-panel'));
        page.add(appearance);
    }
}
