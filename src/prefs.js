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
    const page = new Adw.PreferencesPage({
      title: "General",
      icon_name: "preferences-system-symbolic",
    });
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
    // --- Top panel (the GNOME panel itself) ---
    const panel = new Adw.PreferencesGroup({
      title: "Top Panel",
      description:
        "The GNOME panel background and its text/icon " +
        "color. Applies immediately, without restarting the " +
        "Shell. Transparent Panel is the stock dynamic switch: " +
        "the panel stays transparent while no window touches " +
        "it, then falls back to the background selected below " +
        "(Solid/Semi use their color, the others return to " +
        "the stock appearance).",
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
      enumRow("Notch Style", "notch-style", [
        "Apple (Mac Mode)",
        "Pill",
        "Apple (Mac, no outside rounded)",
      ]),
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
      title: "Top Bar Icons",
      description:
        "Icons in the expanded panel top bar. Each " +
        "icon can be a built-in action, a tab switch, or a " +
        "script (run directly as an executable file, without " +
        "a shell). Row order sets the icon order.",
    });
    page.add(qaGroup);
    const tbRows = [];
    const tbRead = () => {
      const out = [];
      for (const s of settings.get_strv("topbar-icons")) {
        try {
          const e = JSON.parse(s);
          if (e && typeof e === "object" && e.mode) out.push(e);
        } catch (_err) {}
      }
      return out;
    };
    const tbWrite = (arr) =>
      settings.set_strv(
        "topbar-icons",
        arr.map((e) => JSON.stringify(e)),
      );
    const tbTitle = (e) => {
      if (e.mode === "builtin")
        return `Built-in — ${QA_TITLES.find(([x]) => x === e.id)?.[1] ?? e.id}`;
      if (e.mode === "tab")
        return `Tab — ${e.tab === "timer" ? "Timer" : "Main"}`;
      return `Script — ${e.path ?? ""}`;
    };
    const rebuildTbRows = () => {
      for (const row of tbRows) qaGroup.remove(row);
      tbRows.length = 0;
      const entries = tbRead();
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
      entries.forEach((entry, idx) => {
        const row = new Adw.ExpanderRow({
          title: tbTitle(entry),
          subtitle: `Position ${idx + 1}`,
        });
        row.add_suffix(
          mkBtn("go-up-symbolic", idx > 0, () => {
            const arr = tbRead();
            [arr[idx - 1], arr[idx]] = [arr[idx], arr[idx - 1]];
            tbWrite(arr);
            rebuildTbRows();
          }),
        );
        row.add_suffix(
          mkBtn("go-down-symbolic", idx < entries.length - 1, () => {
            const arr = tbRead();
            [arr[idx + 1], arr[idx]] = [arr[idx], arr[idx + 1]];
            tbWrite(arr);
            rebuildTbRows();
          }),
        );
        row.add_suffix(
          mkBtn("user-trash-symbolic", true, () => {
            const arr = tbRead();
            arr.splice(idx, 1);
            tbWrite(arr);
            rebuildTbRows();
          }),
        );
        const iconRow = new Adw.EntryRow({
          title: "Icon Name (GNOME symbolic)",
        });
        iconRow.text = entry.icon ?? "";
        iconRow.connect("notify::text", () => {
          const arr = tbRead();
          if (arr[idx]) {
            arr[idx].icon = iconRow.text.trim();
            tbWrite(arr);
          }
        });
        row.add_row(iconRow);
        if (entry.mode === "script") {
          const pathRow = new Adw.EntryRow({
            title: "Script Path (absolute, executable)",
          });
          pathRow.text = entry.path ?? "";
          pathRow.connect("notify::text", () => {
            const arr = tbRead();
            if (arr[idx]) {
              arr[idx].path = pathRow.text.trim();
              tbWrite(arr);
            }
          });
          row.add_row(pathRow);
        } else {
          const options =
            entry.mode === "builtin"
              ? QA_TITLES
              : [
                  ["main", "Main"],
                  ["timer", "Timer"],
                ];
          const targetRow = new Adw.ComboRow({
            title: entry.mode === "builtin" ? "Built-in Action" : "Target Tab",
            model: Gtk.StringList.new(options.map(([, t]) => t)),
          });
          const curVal = entry.mode === "builtin" ? entry.id : entry.tab;
          targetRow.selected = Math.max(
            0,
            options.findIndex(([v]) => v === curVal),
          );
          targetRow.connect("notify::selected", () => {
            const arr = tbRead();
            if (!arr[idx]) return;
            const val = options[targetRow.selected]?.[0];
            if (entry.mode === "builtin") arr[idx].id = val;
            else arr[idx].tab = val;
            tbWrite(arr);
            rebuildTbRows();
          });
          row.add_row(targetRow);
        }
        qaGroup.add(row);
        tbRows.push(row);
      });
      const addRow = new Adw.ActionRow({
        title: "Add Icon",
        subtitle: "Restore resets all icons to the defaults",
      });
      const mkAdd = (label, entry) => {
        const b = new Gtk.Button({
          label,
          valign: Gtk.Align.CENTER,
        });
        b.add_css_class("flat");
        b.connect("clicked", () => {
          tbWrite([...tbRead(), entry]);
          rebuildTbRows();
        });
        return b;
      };
      addRow.add_suffix(
        mkAdd("Built-in", {
          mode: "builtin",
          id: "today",
          icon: "x-office-calendar-symbolic",
        }),
      );
      addRow.add_suffix(
        mkAdd("Tab", { mode: "tab", tab: "timer", icon: "alarm-symbolic" }),
      );
      addRow.add_suffix(
        mkAdd("Script", {
          mode: "script",
          path: "",
          icon: "utilities-terminal-symbolic",
        }),
      );
      addRow.add_suffix(
        mkBtn("edit-undo-symbolic", true, () => {
          settings.reset("topbar-icons");
          rebuildTbRows();
        }),
      );
      qaGroup.add(addRow);
      tbRows.push(addRow);
    };
    rebuildTbRows();

    // ---------------- Timer & Clock page ----------------
    const timerPage = new Adw.PreferencesPage({
      title: "Timer & Clock",
      icon_name: "alarm-symbolic",
    });
    window.add(timerPage);

    const timerGroup = new Adw.PreferencesGroup({
      title: "Timer Defaults",
      description:
        "Loaded when the extension starts, as the timer form\u2019s initial values. A running countdown is not saved.",
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
          "HH:MM DD-MMM-YY — 24-hour, two-digit day, English month abbreviation, two-digit year. Used in the compact island and the expanded panel.",
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
