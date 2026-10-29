// Preferences for Dynamic Notch.
import Adw from "gi://Adw";
import Gdk from "gi://Gdk";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Gtk from "gi://Gtk";

import { ExtensionPreferences } from "resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js";

const MONTH_ABBR = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

// Same formatter as the Shell side: HH:MM DD-MMM-YY.
function formatDateTime(now) {
  const pad = (v) => `${v}`.padStart(2, "0");
  return (
    `${pad(now.get_hour())}:${pad(now.get_minute())} ` +
    `${pad(now.get_day_of_month())}-${MONTH_ABBR[now.get_month() - 1]}-` +
    `${pad(now.get_year() % 100)}`
  );
}

const QA_TITLES = [
  ["dnd", "Do Not Disturb"],
  ["timer", "Timer"],
  ["today", "Today"],
  ["clear", "Clear Notifications"],
  ["settings", "Extension Settings"],
];

export default class DynamicNotchPreferences extends ExtensionPreferences {
  fillPreferencesWindow(window) {
    const settings = this.getSettings();
    const page = new Adw.PreferencesPage();
    window.add(page);

    const toggle = (title, key) => {
      const row = new Adw.SwitchRow({ title });
      settings.bind(key, row, "active", Gio.SettingsBindFlags.DEFAULT);
      return row;
    };
    const spin = (title, key, lower, upper, step = 1) => {
      const row = new Adw.SpinRow({
        title,
        adjustment: new Gtk.Adjustment({
          lower,
          upper,
          step_increment: step,
          page_increment: 4,
        }),
      });
      settings.bind(key, row, "value", Gio.SettingsBindFlags.DEFAULT);
      return row;
    };
    const enumRow = (title, key, nicks) => {
      const row = new Adw.ComboRow({
        title,
        model: new Gtk.StringList({ strings: nicks }),
      });
      row.selected = settings.get_enum(key);
      row.connect("notify::selected", () =>
        settings.set_enum(key, row.selected),
      );
      settings.connect(`changed::${key}`, () => {
        row.selected = settings.get_enum(key);
      });
      return row;
    };
    // useAlpha stores rgba(); alpha is forced in Solid mode, used as picked in Semi mode.
    const colorRow = (title, key, useAlpha) => {
      const row = new Adw.ActionRow({ title });
      const button = new Gtk.ColorButton({
        valign: Gtk.Align.CENTER,
        use_alpha: useAlpha,
      });
      const rgba = new Gdk.RGBA();
      if (rgba.parse(settings.get_string(key))) button.set_rgba(rgba);
      button.connect("color-set", () => {
        const c = button.get_rgba();
        const rgb = `${Math.round(c.red * 255)},${Math.round(c.green * 255)},${Math.round(c.blue * 255)}`;
        settings.set_string(
          key,
          useAlpha ? `rgba(${rgb},${c.alpha.toFixed(2)})` : `rgb(${rgb})`,
        );
      });
      row.add_suffix(button);
      return row;
    };
    // --- Top panel (GNOME panel itu sendiri) ---
    const panel = new Adw.PreferencesGroup({
      title: "Top Panel",
      description:
        "Background panel GNOME dan warna teks/ikonnya. " +
        "Berlaku langsung, tanpa restart Shell. Transparent Panel " +
        "adalah saklar bawaan: panel transparan selama tidak ada " +
        "jendela yang menyentuhnya, lalu kembali ke background " +
        "terpilih di bawah (Solid/Semi memakai warnanya, sisanya " +
        "kembali ke tampilan stock).",
    });
    panel.add(toggle("Transparent Panel", "transparent-panel"));
    panel.add(
      enumRow("Panel Background", "panel-bg-mode", [
        "Theme (GNOME default)",
        "Transparent",
        "Solid color",
        "Semi-transparent",
      ]),
    );
    panel.add(colorRow("Panel Color", "panel-color", true));
    panel.add(
      enumRow("Panel Text & Icons", "panel-text-mode", [
        "Auto (from panel color)",
        "Light",
        "Dark",
      ]),
    );
    page.add(panel);

    const style = new Adw.PreferencesGroup({ title: "Style" });
    style.add(
      enumRow("Notch Style", "notch-style", ["Apple (Mac Mode)", "Pill"]),
    );
    style.add(
      enumRow("Pill Position", "pill-position", [
        "Top",
        "Bottom",
        "Left",
        "Right",
      ]),
    );
    page.add(style);

    const dimensions = new Adw.PreferencesGroup({ title: "Dimensions" });
    dimensions.add(spin("Width (px)", "notch-width", 120, 600));
    dimensions.add(spin("Height (px)", "notch-height", 30, 100));
    dimensions.add(spin("Corner Radius (px)", "notch-radius", 0, 40));
    page.add(dimensions);

    const appearance = new Adw.PreferencesGroup({ title: "Notch Appearance" });
    appearance.add(colorRow("Notch Background Color", "notch-bg", false));
    appearance.add(
      enumRow("Notch Text", "notch-text-mode", [
        "Auto (from notch color)",
        "Light",
        "Dark",
      ]),
    );
    page.add(appearance);

    const qaGroup = new Adw.PreferencesGroup({
      title: "Quick Actions",
      description:
        "Ikon di top bar panel expanded (panel hanya " +
        "menampilkan ikonnya). Matikan untuk menyembunyikan; " +
        "urutan array menentukan urutan ikon.",
    });
    page.add(qaGroup);
    const qaRows = [];
    const qaKnown = QA_TITLES.map(([id]) => id);
    const qaOrder = () =>
      settings.get_strv("quick-actions").filter((id) => qaKnown.includes(id));
    const qaTitle = (id) => QA_TITLES.find(([x]) => x === id)?.[1] ?? id;
    const rebuildQaRows = () => {
      for (const row of qaRows) qaGroup.remove(row);
      qaRows.length = 0;
      const present = qaOrder();
      const all = [
        ...present,
        ...qaKnown.filter((id) => !present.includes(id)),
      ];
      for (const id of all) {
        const idx = present.indexOf(id);
        const row = new Adw.ActionRow({
          title: qaTitle(id),
          subtitle: idx >= 0 ? `Position ${idx + 1}` : "Hidden",
        });
        const mkBtn = (icon, sensitive, fn) => {
          const b = new Gtk.Button({
            icon_name: icon,
            valign: Gtk.Align.CENTER,
            sensitive,
          });
          b.add_css_class("flat");
          b.connect("clicked", fn);
          return b;
        };
        row.add_suffix(
          mkBtn("go-up-symbolic", idx > 0, () => {
            const arr = qaOrder();
            [arr[idx - 1], arr[idx]] = [arr[idx], arr[idx - 1]];
            settings.set_strv("quick-actions", arr);
            rebuildQaRows();
          }),
        );
        row.add_suffix(
          mkBtn(
            "go-down-symbolic",
            idx >= 0 && idx < present.length - 1,
            () => {
              const arr = qaOrder();
              [arr[idx + 1], arr[idx]] = [arr[idx], arr[idx + 1]];
              settings.set_strv("quick-actions", arr);
              rebuildQaRows();
            },
          ),
        );
        const sw = new Gtk.Switch({
          valign: Gtk.Align.CENTER,
          active: idx >= 0,
        });
        sw.connect("notify::active", () => {
          const arr = qaOrder();
          if (sw.active && !arr.includes(id))
            settings.set_strv("quick-actions", [...arr, id]);
          else if (!sw.active && arr.includes(id))
            settings.set_strv(
              "quick-actions",
              arr.filter((x) => x !== id),
            );
          rebuildQaRows();
        });
        row.add_suffix(sw);
        qaGroup.add(row);
        qaRows.push(row);
      }
    };
    rebuildQaRows();

    // ---------------- Timer & Clock page ----------------
    const timerPage = new Adw.PreferencesPage();
    window.add(timerPage);

    const timerGroup = new Adw.PreferencesGroup({
      title: "Timer Defaults",
      description:
        "Dimuat saat extension aktif sebagai nilai awal form timer. Countdown yang sedang berjalan tidak disimpan.",
    });
    const titleRow = new Adw.EntryRow({ title: "Default Timer Title" });
    settings.bind(
      "timer-title",
      titleRow,
      "text",
      Gio.SettingsBindFlags.DEFAULT,
    );
    timerGroup.add(titleRow);
    const durRow = new Adw.SpinRow({
      title: "Default Duration (minutes)",
      adjustment: new Gtk.Adjustment({
        lower: 1,
        upper: 5999,
        step_increment: 1,
        page_increment: 5,
      }),
    });
    let durGuard = false;
    durRow.value = Math.max(
      1,
      Math.round(settings.get_int("timer-duration") / 60),
    );
    durRow.connect("notify::value", () => {
      if (!durGuard)
        settings.set_int("timer-duration", Math.round(durRow.value) * 60);
    });
    settings.connect("changed::timer-duration", () => {
      durGuard = true;
      durRow.value = Math.max(
        1,
        Math.round(settings.get_int("timer-duration") / 60),
      );
      durGuard = false;
    });
    timerGroup.add(durRow);
    timerPage.add(timerGroup);

    const clockGroup = new Adw.PreferencesGroup({ title: "Date & Time" });
    clockGroup.add(
      new Adw.ActionRow({
        title: "Display Format",
        subtitle:
          "HH:MM DD-MMM-YY — 24-hour, two-digit day, English month abbreviation, two-digit year. Dipakai di compact island dan panel expanded.",
      }),
    );
    const previewRow = new Adw.ActionRow({ title: "Preview" });
    const previewLabel = new Gtk.Label({
      label: formatDateTime(GLib.DateTime.new_now_local()),
      valign: Gtk.Align.CENTER,
    });
    previewLabel.add_css_class("monospace");
    previewRow.add_suffix(previewLabel);
    clockGroup.add(previewRow);
    timerPage.add(clockGroup);

    let previewId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
      previewLabel.label = formatDateTime(GLib.DateTime.new_now_local());
      return GLib.SOURCE_CONTINUE;
    });
    window.connect("close-request", () => {
      if (previewId) GLib.source_remove(previewId);
      previewId = 0;
    });
  }
}
