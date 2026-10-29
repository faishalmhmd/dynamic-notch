// Dynamic Notch — clock notch / Dynamic Island, GNOME Shell 51.

import Clutter from "gi://Clutter";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Meta from "gi://Meta";
import Pango from "gi://Pango";
import Shell from "gi://Shell";
import St from "gi://St";

import * as Main from "resource:///org/gnome/shell/ui/main.js";
import { GrabHelper } from "resource:///org/gnome/shell/ui/grabHelper.js";
import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";

import { NotificationsProvider } from "./lib/notification.js";
import { CalendarProvider } from "./lib/calendarProvider.js";

const EXPANDED_W = 1024;
const EXPANDED_H = 600;
const PEEK_W = 480;
const PEEK_H = 78;
const ANIM_MS = 260;
const PANEL_DEBOUNCE_MS = 100;
const NOTIF_PEEK_MS = 4500;
const TIMER_PEEK_MS = 6000;
const MAX_NOTIF_ITEMS = 5;
const MAX_APPS = 12;

const State = {
  COMPACT: "compact",
  EXPANDING: "expanding",
  EXPANDED: "expanded",
  COLLAPSING: "collapsing",
};

// Parse 'rgb(r,g,b)', 'rgba(r,g,b,a)' or '#rrggbb' into {r,g,b,a} or null.
function parseColor(str) {
  if (!str) return null;
  const s = str.trim();
  let m = s.match(
    /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/,
  );
  if (m) {
    return {
      r: Number(m[1]),
      g: Number(m[2]),
      b: Number(m[3]),
      a: m[4] === undefined ? 1 : Number(m[4]),
    };
  }
  m = s.match(/^#([0-9a-fA-F]{6})$/);
  if (m) {
    const v = parseInt(m[1], 16);
    return { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255, a: 1 };
  }
  return null;
}

function rgbaString({ r, g, b }, a) {
  return `rgba(${r},${g},${b},${a})`;
}

// Perceived luminance 0..1 of an opaque color.
function luminance({ r, g, b }) {
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

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

// Exact display format everywhere: HH:MM DD-MMM-YY (24h, English month).
function formatDateTime(now) {
  const pad = (v) => `${v}`.padStart(2, "0");
  return (
    `${pad(now.get_hour())}:${pad(now.get_minute())} ` +
    `${pad(now.get_day_of_month())}-${MONTH_ABBR[now.get_month() - 1]}-` +
    `${pad(now.get_year() % 100)}`
  );
}

// The only customisable part of the fixed layout: which quick
// action icons appear in the top bar, and in which order.
const QA_DEFS = [
  ["dnd", "notifications-disabled-symbolic", "Do Not Disturb"],
  ["timer", "alarm-symbolic", "Timer"],
  ["today", "x-office-calendar-symbolic", "Today"],
  ["clear", "edit-clear-symbolic", "Clear Notifications"],
  ["settings", "preferences-system-symbolic", "Extension Settings"],
];

export default class DynamicNotchExtension extends Extension {
  enable() {
    this._settings = this.getSettings();
    this._ifaceSettings = new Gio.Settings({
      schema_id: "org.gnome.desktop.interface",
    });

    this._state = State.COMPACT;
    this._animGen = 0;
    this._animOnDone = null;

    // Notification peek (transient mode on top of the compact state)
    this._peekActive = false;
    this._peekTimeoutId = 0;

    // Providers (created in _initProviders, failure-isolated)
    this._notifProvider = null;
    this._notifAvailable = false;
    this._calProvider = null;
    this._calAvailable = false;

    this._page = "main";
    this._qaButtons = new Map();

    // Running apps (AppSystem signals, failure-isolated)
    this._appSystem = null;
    this._appStateId = 0;
    this._windowCreatedId = 0;
    this._appsDebounceId = 0;
    this._appsWindowIds = new Map();
    this._killArm = null;
    this._killArmTimeoutId = 0;

    // Do Not Disturb via org.gnome.desktop.notifications show-banners
    this._desktopNotifSettings = null;
    this._dndChangedId = 0;

    // Calendar view state
    this._calCursor = null; // GLib.DateTime, first of displayed month
    this._calSelected = null; // GLib.DateTime, selected day
    this._calCells = [];
    this._calWeekdayLabels = [];
    this._weekStart = 1; // 0 = Sunday … 6 = Saturday
    this._lastDayKey = "";

    // Timer state machine: idle / running / paused / finished
    this._timerState = "idle";
    this._timerTitle =
      this._settings.get_string("timer-title") || "Focus Timer";
    this._timerTotalSec = this._settings.get_int("timer-duration") || 1500;
    this._timerRemainSec = this._timerTotalSec;
    this._timerDeadline = 0; // GLib monotonic time, microseconds
    this._timerTimeoutId = 0;
    this._timerFinishTimeoutId = 0;

    // Panel appearance currently applied (null = nothing applied yet).
    this._appliedPanelBg = null; // 'theme' | 'transparent' | 'solid' | 'semi'
    this._appliedPanelStyle = null; // inline style string currently set
    this._appliedPanelFg = null; // 'light' | 'dark' | null

    this._panelDebounceId = 0;
    this._overviewRecheckId = 0;
    this._closeIdleId = 0;
    this._clockTimeoutId = 0;
    this._stagePressId = 0;
    this._stageKeyId = 0;
    this._focusWindowId = 0;
    this._grabOpId = 0;
    this._grabHelper = null;
    this._grabbed = false;
    this._settingsChangedId = 0;
    this._monitorsChangedId = 0;

    this._buildNotch();
    Main.layoutManager.addChrome(this._notch);
    this._applyNotchStyle();
    this._applySize(false);

    this._clockTimeoutId = GLib.timeout_add_seconds(
      GLib.PRIORITY_DEFAULT,
      1,
      () => {
        this._updateClock();
        return GLib.SOURCE_CONTINUE;
      },
    );
    this._updateClock();

    this._settingsChangedId = this._settings.connect("changed", (_s, key) => {
      this._applyNotchStyle();
      this._refreshGeometry();
      this._updatePanelAppearance();
      if (key === "quick-actions") this._buildQaButtons();
    });
    this._monitorsChangedId = Main.layoutManager.connect(
      "monitors-changed",
      () => {
        this._applySize(false);
        this._updatePanelAppearance();
      },
    );

    // --- Panel background tracking ---
    this._actorSignalIds = new Map();
    this._windowSignalIds = new Map();

    this._actorSignalIds.set(Main.overview, [
      Main.overview.connect("showing", () => {
        // Opening the Overview counts as interacting outside the
        // notch: collapse it, then follow the Overview styling.
        if (this._state === State.EXPANDED || this._state === State.EXPANDING)
          this._closePanel();
        this._updatePanelAppearance();
      }),
      Main.overview.connect("shown", () => this._updatePanelAppearance()),
      Main.overview.connect("hiding", () => this._updatePanelAppearance()),
      Main.overview.connect("hidden", () => {
        this._updatePanelAppearance();
        this._scheduleOverviewRecheck();
      }),
    ]);

    this._actorSignalIds.set(Main.sessionMode, [
      Main.sessionMode.connect("updated", () => this._updatePanelAppearance()),
    ]);

    this._actorSignalIds.set(global.workspace_manager, [
      global.workspace_manager.connect("active-workspace-changed", () => {
        // Switching workspace is an outside interaction too.
        this._closePanel();
        this._schedulePanelUpdate();
      }),
    ]);

    this._actorSignalIds.set(global.display, [
      global.display.connect("restacked", () => this._schedulePanelUpdate()),
    ]);

    for (const metaWindowActor of global.get_window_actors())
      this._onWindowActorAdded(metaWindowActor.get_parent(), metaWindowActor);

    this._actorSignalIds.set(global.window_group, [
      global.window_group.connect(
        "child-added",
        this._onWindowActorAdded.bind(this),
      ),
      global.window_group.connect(
        "child-removed",
        this._onWindowActorRemoved.bind(this),
      ),
    ]);

    this._updatePanelAppearance();
    this._initProviders();
    this._initApps();
    this._renderCalendar();
    this._renderTimer();
    this._syncDndButton();
  }

  disable() {
    // Synchronous, per the Shell 51 porting guide. Everything that
    // enable() installed is removed here, in dependency order.
    for (const id of [
      this._clockTimeoutId,
      this._panelDebounceId,
      this._overviewRecheckId,
      this._closeIdleId,
      this._peekTimeoutId,
      this._timerTimeoutId,
      this._timerFinishTimeoutId,
      this._appsDebounceId,
      this._killArmTimeoutId,
    ]) {
      if (id) GLib.source_remove(id);
    }
    this._clockTimeoutId = this._panelDebounceId = 0;
    this._overviewRecheckId = this._closeIdleId = 0;
    this._peekTimeoutId = this._timerTimeoutId = 0;
    this._timerFinishTimeoutId = 0;
    this._appsDebounceId = this._killArmTimeoutId = 0;

    // Providers first: restore stock banners while our actors still exist.
    if (this._notifProvider) {
      try {
        this._notifProvider.destroy();
      } catch (_e) {}
      this._notifProvider = null;
    }
    if (this._calProvider) {
      try {
        this._calProvider.destroy();
      } catch (_e) {}
      this._calProvider = null;
    }
    if (this._appSystem && this._appStateId) {
      try {
        this._appSystem.disconnect(this._appStateId);
      } catch (_e) {}
    }
    this._appStateId = 0;
    this._appSystem = null;
    if (this._windowCreatedId) {
      global.display.disconnect(this._windowCreatedId);
      this._windowCreatedId = 0;
    }
    if (this._appsWindowIds) {
      for (const [app, id] of this._appsWindowIds) {
        try {
          app.disconnect(id);
        } catch (_e) {}
      }
      this._appsWindowIds.clear();
    }
    this._killArm = null;
    if (this._desktopNotifSettings && this._dndChangedId)
      this._desktopNotifSettings.disconnect(this._dndChangedId);
    this._dndChangedId = 0;
    this._desktopNotifSettings = null;

    this._removeOutsideHandlers();

    if (this._settings && this._settingsChangedId)
      this._settings.disconnect(this._settingsChangedId);
    this._settingsChangedId = 0;
    if (this._monitorsChangedId)
      Main.layoutManager.disconnect(this._monitorsChangedId);
    this._monitorsChangedId = 0;

    for (const map of [this._actorSignalIds, this._windowSignalIds]) {
      if (!map) continue;
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
    // FixedLayout: only the notch animates; every view keeps its final size.
    this._notch = new St.Widget({
      name: "dynamic-notch",
      style_class: "dn-notch",
      reactive: true,
      track_hover: true,
      clip_to_allocation: true,
      layout_manager: new Clutter.FixedLayout(),
    });

    // --- Compact view: time + date + live chips ---
    this._clockWidget = new St.BoxLayout({
      style_class: "dn-clock-widget",
      reactive: true,
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.CENTER,
    });
    this._clockTime = new St.Label({
      style_class: "dn-clock-time",
      y_align: Clutter.ActorAlign.CENTER,
      x_align: Clutter.ActorAlign.CENTER,
    });
    this._clockWidget.add_child(this._clockTime);

    this._timerChip = new St.BoxLayout({
      style_class: "dn-chip",
      visible: false,
      y_align: Clutter.ActorAlign.CENTER,
    });
    this._timerChip.add_child(
      new St.Icon({
        icon_name: "alarm-symbolic",
        icon_size: 12,
        y_align: Clutter.ActorAlign.CENTER,
      }),
    );
    this._timerChipLabel = new St.Label({
      style_class: "dn-chip-label",
      y_align: Clutter.ActorAlign.CENTER,
    });
    this._timerChip.add_child(this._timerChipLabel);
    this._clockWidget.add_child(this._timerChip);

    this._notifChip = new St.BoxLayout({
      style_class: "dn-chip",
      visible: false,
      y_align: Clutter.ActorAlign.CENTER,
    });
    this._notifChip.add_child(
      new St.Icon({
        icon_name: "mail-unread-symbolic",
        icon_size: 12,
        y_align: Clutter.ActorAlign.CENTER,
      }),
    );
    this._notifChipLabel = new St.Label({
      style_class: "dn-chip-label",
      y_align: Clutter.ActorAlign.CENTER,
    });
    this._notifChip.add_child(this._notifChipLabel);
    this._clockWidget.add_child(this._notifChip);

    this._clockWidget.connect("button-press-event", () => {
      this._togglePanel();
      return Clutter.EVENT_STOP;
    });
    this._notch.add_child(this._clockWidget);

    // --- Peek view: notification / timer-finished banner ---
    this._peekView = new St.BoxLayout({
      style_class: "dn-peek",
      reactive: true,
      visible: false,
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.CENTER,
    });
    this._peekIcon = new St.Icon({
      icon_name: "dialog-information-symbolic",
      icon_size: 28,
      y_align: Clutter.ActorAlign.CENTER,
    });
    this._peekView.add_child(this._peekIcon);
    const peekText = new St.BoxLayout({
      orientation: Clutter.Orientation.VERTICAL,
      x_expand: true,
      y_align: Clutter.ActorAlign.CENTER,
    });
    this._peekTitle = new St.Label({ style_class: "dn-peek-title" });
    this._peekTitle.get_clutter_text().set_ellipsize(Pango.EllipsizeMode.END);
    this._peekBody = new St.Label({ style_class: "dn-peek-body" });
    this._peekBody.get_clutter_text().set_ellipsize(Pango.EllipsizeMode.END);
    peekText.add_child(this._peekTitle);
    peekText.add_child(this._peekBody);
    this._peekView.add_child(peekText);
    this._peekView.connect("button-press-event", () => {
      this._hidePeek();
      this._openPanel();
      return Clutter.EVENT_STOP;
    });
    this._notch.add_child(this._peekView);

    // --- Expanded view: one fixed layout ---
    this._expandedView = new St.Widget({
      style_class: "dn-expanded",
      visible: false,
      opacity: 0,
      layout_manager: new Clutter.BinLayout(),
    });
    this._expandedView.add_child(this._buildExpanded());
    this._notch.add_child(this._expandedView);

    // Floating helpers, positioned at show time (notch uses FixedLayout).
    this._tooltip = new St.Label({
      style_class: "dn-tooltip",
      visible: false,
    });
    this._notch.add_child(this._tooltip);
    this._appMenu = new St.BoxLayout({
      orientation: Clutter.Orientation.VERTICAL,
      style_class: "dn-menu",
      visible: false,
    });
    this._notch.add_child(this._appMenu);
  }

  // One fixed layout: top bar, calendar + notifications, apps row.
  _buildExpanded() {
    const root = new St.BoxLayout({
      style_class: "dn-expanded-root",
      orientation: Clutter.Orientation.VERTICAL,
      x_expand: true,
      y_expand: true,
    });

    const topBar = new St.BoxLayout({ style_class: "dn-topbar" });
    const corner = new St.BoxLayout({
      style_class: "dn-corner",
      orientation: Clutter.Orientation.VERTICAL,
      reactive: true,
      y_align: Clutter.ActorAlign.CENTER,
    });
    this._expandedClock = new St.Label({ style_class: "dn-corner-clock" });
    this._expandedDate = new St.Label({ style_class: "dn-corner-date" });
    corner.add_child(this._expandedClock);
    corner.add_child(this._expandedDate);
    corner.connect("button-press-event", () => {
      this._closePanel();
      return Clutter.EVENT_STOP;
    });
    topBar.add_child(corner);
    this._qaBar = new St.BoxLayout({
      style_class: "dn-qa-row",
      x_expand: true,
      x_align: Clutter.ActorAlign.END,
      y_align: Clutter.ActorAlign.CENTER,
    });
    topBar.add_child(this._qaBar);
    this._buildQaButtons();
    root.add_child(topBar);

    this._pageMain = new St.BoxLayout({
      style_class: "dn-page-main",
      y_expand: true,
    });
    const calArea = this._buildCalendarArea();
    calArea.set_width(356);
    this._pageMain.add_child(calArea);
    const notifArea = this._buildNotifArea();
    notifArea.x_expand = true;
    this._pageMain.add_child(notifArea);
    root.add_child(this._pageMain);

    this._pageTimer = new St.BoxLayout({
      style_class: "dn-page-timer",
      y_expand: true,
      visible: false,
    });
    const timerStrip = this._buildTimerStrip();
    timerStrip.x_expand = true;
    timerStrip.y_align = Clutter.ActorAlign.CENTER;
    this._pageTimer.add_child(timerStrip);
    root.add_child(this._pageTimer);

    root.add_child(this._buildAppsStrip());
    return root;
  }

  _buildQaButtons() {
    if (!this._qaBar) return;
    this._qaBar.destroy_all_children();
    this._qaButtons.clear();
    const known = new Map(QA_DEFS.map((d) => [d[0], d]));
    let ids = [];
    try {
      ids = this._settings
        .get_strv("quick-actions")
        .filter((id) => known.has(id));
    } catch (_e) {}
    for (const id of ids) {
      const [, iconName, title] = known.get(id);
      const button = new St.Button({
        style_class: "dn-qa-button",
        accessible_name: title,
      });
      button.child = new St.Icon({ icon_name: iconName, icon_size: 18 });
      button.connect("clicked", () => this._qaActivate(id));
      this._addTooltip(button, title);
      this._qaBar.add_child(button);
      this._qaButtons.set(id, button);
    }
    this._syncQaStates();
  }

  _qaActivate(id) {
    this._hideTooltip();
    if (id === "dnd") this._toggleDnd();
    else if (id === "timer")
      this._showPage(this._page === "timer" ? "main" : "timer");
    else if (id === "today") {
      this._showPage("main");
      this._qaCalendarToday();
    } else if (id === "clear") {
      if (this._notifProvider) this._notifProvider.clearAll();
      this._refreshNotifList();
    } else if (id === "settings") {
      try {
        this.openPreferences();
      } catch (e) {
        logError(e, "dynamic-notch: opening preferences failed");
      }
    }
  }

  _showPage(name) {
    this._page = name;
    if (this._pageMain) this._pageMain.visible = name === "main";
    if (this._pageTimer) this._pageTimer.visible = name === "timer";
    this._closeAppMenu();
    this._hideTooltip();
    this._syncQaStates();
  }

  _syncQaStates() {
    if (!this._qaButtons) return;
    const dndBtn = this._qaButtons.get("dnd");
    if (dndBtn) {
      let active = false;
      let usable = !!this._desktopNotifSettings;
      if (usable) {
        active = !this._desktopNotifSettings.get_boolean("show-banners");
      }
      dndBtn.reactive = usable;
      dndBtn.opacity = usable ? 255 : 110;
      dndBtn.style_class = "dn-qa-button" + (active ? " dn-qa-active" : "");
    }
    const timerBtn = this._qaButtons.get("timer");
    if (timerBtn) {
      const active =
        this._page === "timer" ||
        this._timerState === "running" ||
        this._timerState === "paused";
      timerBtn.style_class = "dn-qa-button" + (active ? " dn-qa-active" : "");
    }
    const clearBtn = this._qaButtons.get("clear");
    if (clearBtn) {
      const has = this._notifProvider?.getAll().length > 0;
      clearBtn.reactive = has;
      clearBtn.opacity = has ? 255 : 110;
    }
  }

  // ------------------------------------------------------------ tooltip

  _addTooltip(actor, text) {
    actor.connect("enter-event", () => this._showTooltip(actor, text));
    actor.connect("leave-event", () => this._hideTooltip());
  }

  _showTooltip(actor, text) {
    if (!this._tooltip || !this._targetExpanded()) return;
    const [ax, ay] = actor.get_transformed_position();
    const [nx, ny] = this._notch.get_transformed_position();
    this._tooltip.text = text;
    const [, tw] = this._tooltip.get_preferred_width(-1);
    const x = Math.round(ax - nx + actor.width / 2 - tw / 2);
    const y = Math.round(ay - ny - 30);
    this._tooltip.set_position(Math.max(2, x), Math.max(2, y));
    this._tooltip.show();
  }

  _hideTooltip() {
    if (this._tooltip) this._tooltip.hide();
  }

  // ------------------------------------------------------ running apps

  _buildAppsStrip() {
    const strip = new St.BoxLayout({ style_class: "dn-apps-strip" });
    this._appsRow = new St.BoxLayout({
      style_class: "dn-apps-row",
      x_expand: true,
    });
    strip.add_child(this._appsRow);
    const overviewBtn = new St.Button({
      style_class: "dn-apps-overview",
      accessible_name: "Open Activities Overview",
    });
    overviewBtn.child = new St.Icon({
      icon_name: "view-app-grid-symbolic",
      icon_size: 22,
    });
    overviewBtn.connect("clicked", () => Main.overview.show());
    this._addTooltip(overviewBtn, "Activities Overview");
    strip.add_child(overviewBtn);
    return strip;
  }

  _initApps() {
    try {
      this._appSystem = Shell.AppSystem.get_default();
      this._appStateId = this._appSystem.connect("app-state-changed", () =>
        this._scheduleAppsRefresh(),
      );
      this._windowCreatedId = global.display.connect("window-created", () =>
        this._scheduleAppsRefresh(),
      );
      this._refreshApps();
    } catch (e) {
      logError(e, "dynamic-notch: running-apps unavailable");
      this._appSystem = null;
    }
  }

  _scheduleAppsRefresh() {
    if (this._appsDebounceId) return;
    this._appsDebounceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
      this._appsDebounceId = 0;
      this._refreshApps();
      return GLib.SOURCE_REMOVE;
    });
  }

  _refreshApps() {
    if (!this._appsRow) return;
    // Two sources, deduped by app id: AppSystem's running list and
    // the apps behind the actual window actors (ground truth).
    const byId = new Map();
    if (this._appSystem) {
      try {
        for (const app of this._appSystem.get_running()) {
          if (app.get_windows().length > 0) byId.set(app.get_id(), app);
        }
      } catch (e) {
        logError(e, "dynamic-notch: reading running apps failed");
      }
    }
    try {
      const tracker = Shell.WindowTracker.get_default();
      for (const actor of global.get_window_actors()) {
        const win = actor.meta_window;
        if (!win || win.is_skip_taskbar()) continue;
        const app = tracker.get_window_app(win);
        if (app && !byId.has(app.get_id())) byId.set(app.get_id(), app);
      }
    } catch (e) {
      logError(e, "dynamic-notch: window scan for apps failed");
    }
    const apps = [...byId.values()];
    // Most recently used first, from each app's newest window.
    const mru = (a) => {
      const wins = a.get_windows();
      return wins.length
        ? Math.max(0, ...wins.map((w) => w.get_user_time()))
        : 0;
    };
    apps.sort((x, y) => mru(y) - mru(x));

    // Keep a windows-changed watch only on apps currently running.
    const seen = new Set(apps);
    for (const [app, id] of this._appsWindowIds) {
      if (!seen.has(app)) {
        try {
          app.disconnect(id);
        } catch (_e) {}
        this._appsWindowIds.delete(app);
      }
    }
    for (const app of apps) {
      if (!this._appsWindowIds.has(app)) {
        try {
          this._appsWindowIds.set(
            app,
            app.connect("windows-changed", () => this._scheduleAppsRefresh()),
          );
        } catch (_e) {}
      }
    }

    if (this._killArm && GLib.get_monotonic_time() > this._killArm.until)
      this._killArm = null;

    this._appsRow.destroy_all_children();
    if (apps.length === 0) {
      this._appsRow.add_child(
        new St.Label({
          text: "No running apps",
          style_class: "dn-card-body",
          y_align: Clutter.ActorAlign.CENTER,
        }),
      );
      return;
    }
    for (const app of apps.slice(0, MAX_APPS))
      this._appsRow.add_child(this._makeAppEntry(app));
    if (apps.length > MAX_APPS) {
      this._appsRow.add_child(
        new St.Label({
          text: `+${apps.length - MAX_APPS} more`,
          style_class: "dn-apps-more",
          y_align: Clutter.ActorAlign.CENTER,
        }),
      );
    }
  }

  _makeAppEntry(app) {
    const name = app.get_name() || "Application";
    const btn = new St.Button({
      style_class: "dn-app-button",
      accessible_name: name,
    });
    let iconActor = null;
    try {
      // The app's own icon, resolved by the Shell (never a bundled file).
      iconActor = app.create_icon_texture(28);
    } catch (_e) {}
    if (!iconActor) {
      iconActor = new St.Icon({
        icon_name: "application-x-executable-symbolic",
        icon_size: 28,
      });
    }
    btn.child = iconActor;
    btn.connect("clicked", () => {
      this._closeAppMenu();
      try {
        app.activate();
      } catch (e) {
        logError(e, "dynamic-notch: app activation failed");
      }
    });
    btn.connect("button-press-event", (_a, event) => {
      if (event.get_button() === 3) {
        this._openAppMenu(app, btn);
        return Clutter.EVENT_STOP;
      }
      return Clutter.EVENT_PROPAGATE;
    });
    this._addTooltip(btn, name);
    return btn;
  }

  _openAppMenu(app, anchor) {
    const menu = this._appMenu;
    if (!menu) return;
    this._hideTooltip();
    menu.destroy_all_children();
    const pid = this._appPid(app);
    const armed =
      pid > 1 &&
      this._killArm?.id === app.get_id() &&
      GLib.get_monotonic_time() <= this._killArm.until;
    const item = (label, danger, fn) => {
      const b = new St.Button({
        label,
        style_class: "dn-menu-item" + (danger ? " dn-menu-danger" : ""),
      });
      b.connect("clicked", fn);
      menu.add_child(b);
    };
    item("Activate", false, () => {
      this._closeAppMenu();
      try {
        app.activate();
      } catch (e) {
        logError(e, "dynamic-notch: app activation failed");
      }
    });
    item("Close", false, () => {
      this._closeAppMenu();
      this._closeApp(app);
    });
    if (pid > 1) {
      item(armed ? "Confirm Force Kill" : "Force Kill…", armed, () => {
        if (armed) {
          this._closeAppMenu();
          this._killApp(app, pid);
        } else {
          this._killApp(app, pid);
          this._openAppMenu(app, anchor);
        }
      });
    }
    const [ax, ay] = anchor.get_transformed_position();
    const [nx, ny] = this._notch.get_transformed_position();
    menu.show();
    const [, mh] = menu.get_preferred_height(-1);
    menu.set_position(
      Math.max(2, Math.round(ax - nx)),
      Math.max(2, Math.round(ay - ny - mh - 6)),
    );
  }

  _closeAppMenu() {
    if (this._appMenu) this._appMenu.hide();
  }

  _appPid(app) {
    try {
      const pids = app.get_pids();
      return pids.find((p) => Number.isInteger(p) && p > 1) ?? 0;
    } catch (_e) {
      return 0;
    }
  }

  _closeApp(app) {
    try {
      // request_quit() asks the app to quit via its windows (supported path).
      if (!app.request_quit()) {
        for (const win of app.get_windows())
          win.delete(Clutter.get_current_event_time());
      }
    } catch (e) {
      logError(e, "dynamic-notch: closing app failed");
    }
    this._scheduleAppsRefresh();
  }

  _killApp(app, pid) {
    const now = GLib.get_monotonic_time();
    if (this._killArm?.id !== app.get_id() || now > this._killArm.until) {
      // First click only arms the action; it expires after three seconds.
      this._killArm = { id: app.get_id(), until: now + 3e6 };
      if (this._killArmTimeoutId) GLib.source_remove(this._killArmTimeoutId);
      this._killArmTimeoutId = GLib.timeout_add(
        GLib.PRIORITY_DEFAULT,
        3100,
        () => {
          this._killArmTimeoutId = 0;
          this._killArm = null;
          this._refreshApps();
          return GLib.SOURCE_REMOVE;
        },
      );
      this._refreshApps();
      return;
    }
    this._killArm = null;
    if (this._killArmTimeoutId) {
      GLib.source_remove(this._killArmTimeoutId);
      this._killArmTimeoutId = 0;
    }
    if (app.get_id() === "org.gnome.Shell.desktop" || pid <= 1) {
      log("dynamic-notch: refusing to force kill a protected app");
      this._refreshApps();
      return;
    }
    try {
      // SIGKILL to the app PID Shell itself reports for that app.
      const proc = Gio.Subprocess.new(
        ["kill", "-9", `${pid}`],
        Gio.SubprocessFlags.NONE,
      );
      proc.wait_async(null, (p, res) => {
        try {
          p.wait_finish(res);
        } catch (e) {
          logError(e, "dynamic-notch: force kill failed");
        }
        this._scheduleAppsRefresh();
      });
    } catch (e) {
      logError(e, "dynamic-notch: force kill failed");
      this._scheduleAppsRefresh();
    }
  }

  // --- Calendar ---
  _buildCalendarArea() {
    const box = new St.BoxLayout({
      style_class: "dn-cal-area",
      orientation: Clutter.Orientation.VERTICAL,
    });

    const header = new St.BoxLayout({ style_class: "dn-cal-header" });
    const prev = new St.Button({
      style_class: "dn-small-button",
      child: new St.Icon({ icon_name: "go-previous-symbolic", icon_size: 14 }),
    });
    prev.connect("clicked", () => this._calMoveMonth(-1));
    header.add_child(prev);
    this._calTitle = new St.Label({
      style_class: "dn-card-title",
      x_expand: true,
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.CENTER,
    });
    header.add_child(this._calTitle);
    const next = new St.Button({
      style_class: "dn-small-button",
      child: new St.Icon({ icon_name: "go-next-symbolic", icon_size: 14 }),
    });
    next.connect("clicked", () => this._calMoveMonth(1));
    header.add_child(next);
    box.add_child(header);

    const weekdayRow = new St.BoxLayout({ style_class: "dn-cal-weekdays" });
    this._calWeekdayLabels = [];
    for (let i = 0; i < 7; i++) {
      const label = new St.Label({
        style_class: "dn-cal-weekday",
        x_expand: true,
        x_align: Clutter.ActorAlign.CENTER,
      });
      this._calWeekdayLabels.push(label);
      weekdayRow.add_child(label);
    }
    box.add_child(weekdayRow);

    // 42 cells, created once and only re-labelled on render, so
    // switching months can never change the layout's size.
    const cellLayout = new Clutter.GridLayout({
      column_spacing: 2,
      row_spacing: 2,
      column_homogeneous: true,
      row_homogeneous: true,
    });
    const cellGrid = new St.Widget({
      layout_manager: cellLayout,
      x_expand: true,
    });
    this._calCells = [];
    for (let i = 0; i < 42; i++) {
      const label = new St.Label({
        style_class: "dn-cal-cell-label",
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
      });
      const cell = new St.Button({
        style_class: "dn-cal-cell",
        child: label,
        x_expand: true,
        y_expand: true,
      });
      cell.connect("clicked", () => {
        if (cell._dnDate) this._calSelectDay(cell._dnDate);
      });
      this._calCells.push({ button: cell, label });
      cellLayout.attach(cell, i % 7, Math.floor(i / 7), 1, 1);
    }
    box.add_child(cellGrid);

    const eventsTitle = new St.Label({
      text: "Events",
      style_class: "dn-cal-events-title",
    });
    box.add_child(eventsTitle);
    this._calEventLabels = [];
    for (let i = 0; i < 3; i++) {
      const label = new St.Label({ style_class: "dn-cal-event" });
      label.get_clutter_text().set_ellipsize(Pango.EllipsizeMode.END);
      this._calEventLabels.push(label);
      box.add_child(label);
    }
    return box;
  }

  // --- Area 3: notifications ---
  _buildNotifArea() {
    const box = new St.BoxLayout({
      style_class: "dn-notif-area",
      orientation: Clutter.Orientation.VERTICAL,
    });
    const header = new St.BoxLayout({ style_class: "dn-notif-header" });
    header.add_child(
      new St.Icon({
        icon_name: "preferences-system-notifications-symbolic",
        icon_size: 16,
        y_align: Clutter.ActorAlign.CENTER,
      }),
    );
    header.add_child(
      new St.Label({
        text: "Notifications",
        style_class: "dn-card-title",
        y_align: Clutter.ActorAlign.CENTER,
      }),
    );
    this._notifCount = new St.Label({
      style_class: "dn-notif-count",
      y_align: Clutter.ActorAlign.CENTER,
    });
    header.add_child(this._notifCount);
    const spacer = new St.Widget({ x_expand: true });
    header.add_child(spacer);
    this._clearButton = new St.Button({
      label: "Clear notifications",
      style_class: "dn-small-button",
    });
    this._clearButton.connect("clicked", () => {
      try {
        this._notifProvider?.clearAll();
      } catch (e) {
        logError(e, "dynamic-notch: clear notifications failed");
      }
    });
    header.add_child(this._clearButton);
    box.add_child(header);

    this._notifEmpty = new St.Label({
      text: "No notifications",
      style_class: "dn-card-body",
    });
    box.add_child(this._notifEmpty);

    // Plain box, capped at MAX_NOTIF_ITEMS rows — deliberately no
    // ScrollView, so no scrollbar can ever appear mid-animation.
    this._notifList = new St.BoxLayout({
      style_class: "dn-notif-list",
      orientation: Clutter.Orientation.VERTICAL,
    });
    box.add_child(this._notifList);
    return box;
  }

  // --- Timer strip (bottom, cols 2-5 of row 5) ---
  _buildTimerStrip() {
    const strip = new St.BoxLayout({
      style_class: "dn-timer-strip",
      y_align: Clutter.ActorAlign.CENTER,
    });

    const left = new St.BoxLayout({
      orientation: Clutter.Orientation.VERTICAL,
      style_class: "dn-timer-left",
    });
    const titleRow = new St.BoxLayout({ style_class: "dn-card-head" });
    titleRow.add_child(
      new St.Icon({
        icon_name: "alarm-symbolic",
        icon_size: 16,
        y_align: Clutter.ActorAlign.CENTER,
      }),
    );
    this._timerTitleEntry = new St.Entry({
      style_class: "dn-timer-entry",
      text: this._timerTitle,
      hint_text: "Timer title",
      can_focus: true,
    });
    // 'text-changed' lives on the inner ClutterText, not on St.Entry itself.
    this._timerTitleEntry.get_clutter_text().connect("text-changed", () => {
      if (this._timerState === "idle" || this._timerState === "finished")
        this._timerTitle = this._timerTitleEntry.text.trim() || "Focus Timer";
    });
    titleRow.add_child(this._timerTitleEntry);
    left.add_child(titleRow);

    const durRow = new St.BoxLayout({ style_class: "dn-preset-row" });
    const mkDurEntry = (hint) => {
      const entry = new St.Entry({
        style_class: "dn-time-entry",
        hint_text: hint,
        can_focus: true,
      });
      entry
        .get_clutter_text()
        .connect("text-changed", () => this._sanitizeDurEntry(entry));
      durRow.add_child(entry);
      return entry;
    };
    const durSep = () =>
      new St.Label({
        text: ":",
        style_class: "dn-chip-label",
        y_align: Clutter.ActorAlign.CENTER,
      });
    this._durH = mkDurEntry("HH");
    durRow.add_child(durSep());
    this._durM = mkDurEntry("MM");

    const controls = new St.BoxLayout({ style_class: "dn-timer-controls" });
    this._btnPlayPause = new St.Button({ style_class: "dn-timer-button" });
    const ppBox = new St.BoxLayout({ style_class: "dn-qa-content" });
    this._playPauseIcon = new St.Icon({
      icon_name: "media-playback-start-symbolic",
      icon_size: 14,
      y_align: Clutter.ActorAlign.CENTER,
    });
    this._playPauseLabel = new St.Label({
      text: "Play",
      style_class: "dn-qa-label",
      y_align: Clutter.ActorAlign.CENTER,
    });
    ppBox.add_child(this._playPauseIcon);
    ppBox.add_child(this._playPauseLabel);
    this._btnPlayPause.child = ppBox;
    this._btnPlayPause.connect("clicked", () => this._timerPlayPause());
    controls.add_child(this._btnPlayPause);
    this._btnReset = new St.Button({
      label: "Reset",
      style_class: "dn-timer-button",
    });
    this._btnReset.connect("clicked", () => this._timerReset());
    controls.add_child(this._btnReset);
    durRow.add_child(controls);
    left.add_child(durRow);
    strip.add_child(left);

    this._timerLabel = new St.Label({
      style_class: "dn-timer-count",
      x_expand: true,
      x_align: Clutter.ActorAlign.END,
      y_align: Clutter.ActorAlign.CENTER,
    });
    strip.add_child(this._timerLabel);
    this._syncDurationEntries();
    return strip;
  }

  _updateClock() {
    if (!this._clockTime) return;
    const now = GLib.DateTime.new_now_local();
    const stamp = formatDateTime(now);
    this._clockTime.text = stamp;
    this._expandedClock.text = stamp;
    this._expandedDate.text = now.format("%A");

    // Day rollover while the Shell keeps running: keep the
    // calendar's "today" honest without a separate timer.
    const dayKey = now.format("%Y-%m-%d");
    if (this._lastDayKey && dayKey !== this._lastDayKey) {
      const today = GLib.DateTime.new_now_local();
      if (
        this._calCursor &&
        this._calCursor.get_year() === today.get_year() &&
        this._calCursor.get_month() === today.get_month()
      ) {
        this._calCursor = today;
        this._calSelected = today;
      }
      this._renderCalendar();
    }
    this._lastDayKey = dayKey;
  }

  // ------------------------------------------------------- open / close

  _togglePanel() {
    if (this._state === State.COMPACT || this._state === State.COLLAPSING)
      this._openPanel();
    else this._closePanel();
  }

  _openPanel() {
    if (this._state === State.EXPANDED || this._state === State.EXPANDING)
      return;
    this._state = State.EXPANDING;
    const gen = ++this._animGen;

    // A user expansion supersedes any notification peek.
    this._peekActive = false;
    if (this._peekTimeoutId) {
      GLib.source_remove(this._peekTimeoutId);
      this._peekTimeoutId = 0;
    }
    this._syncViews();
    this._showPage("main");
    this._renderCalendar();
    this._refreshNotifList();
    this._refreshApps();
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
      if (gen !== this._animGen) return;
      this._state = State.EXPANDED;
      this._syncViews();
    };
    this._applySize(true);
    this._installOutsideHandlers();
  }

  _closePanel() {
    if (this._state === State.COMPACT || this._state === State.COLLAPSING)
      return;
    this._state = State.COLLAPSING;
    const gen = ++this._animGen;

    this._closeAppMenu();
    this._hideTooltip();
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
      if (gen !== this._animGen) return;
      this._state = State.COMPACT;
      this._syncViews();
      // A notification peek may have been queued while the
      // panel was collapsing; show it now that we are compact.
      if (this._peekActive) this._applySize(true);
    };
    this._applySize(true);

    // Without animation the ease never fires; finish synchronously.
    if (!this._animationsEnabled() && gen === this._animGen) this._animOnDone();
  }

  // GrabHelper while open: the Shell menus' own outside-click mechanism (details in README).
  _installOutsideHandlers() {
    if (this._stagePressId) return; // already installed — never stack duplicates

    try {
      this._grabHelper ??= new GrabHelper(this._notch);
      this._grabbed = this._grabHelper.grab({
        actor: this._notch,
        onUngrab: () => {
          log("dynamic-notch: grab released by outside interaction");
          this._closePanel();
        },
      });
    } catch (e) {
      logError(e, "dynamic-notch: GrabHelper unavailable");
      this._grabbed = false;
    }
    log(`dynamic-notch: panel open, modal grab = ${this._grabbed}`);

    this._focusWindowId = global.display.connect("notify::focus-window", () => {
      if (this._state === State.EXPANDED || this._state === State.EXPANDING)
        this._closePanel();
    });
    this._grabOpId = global.display.connect("grab-op-begin", () => {
      if (this._state === State.EXPANDED || this._state === State.EXPANDING)
        this._closePanel();
    });

    this._stagePressId = global.stage.connect("captured-event", (_a, event) => {
      const type = event.type();
      if (
        type !== Clutter.EventType.BUTTON_PRESS &&
        type !== Clutter.EventType.TOUCH_BEGIN
      )
        return Clutter.EVENT_PROPAGATE;
      if (this._state !== State.EXPANDED && this._state !== State.EXPANDING)
        return Clutter.EVENT_PROPAGATE;

      if (this._eventInsideNotch(event)) return Clutter.EVENT_PROPAGATE;

      // Shell-UI click outside the notch: schedule close, still propagate the click.
      this._scheduleClose();
      return Clutter.EVENT_PROPAGATE;
    });

    this._stageKeyId = global.stage.connect("key-press-event", (_a, event) => {
      if (event.get_key_symbol() !== Clutter.KEY_Escape)
        return Clutter.EVENT_PROPAGATE;
      if (this._state !== State.EXPANDED && this._state !== State.EXPANDING)
        return Clutter.EVENT_PROPAGATE;
      // If keyboard focus is inside the panel (e.g. the notes
      // entry), Escape belongs to that control first.
      const focus = global.stage.get_key_focus();
      if (focus && this._isInsideNotch(focus)) return Clutter.EVENT_PROPAGATE;
      this._closePanel();
      return Clutter.EVENT_STOP;
    });
  }

  _removeOutsideHandlers() {
    if (this._grabbed) {
      try {
        this._grabHelper.ungrab();
      } catch (_e) {
        // grab already released
      }
      this._grabbed = false;
    }
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
    if (this._closeIdleId) return;
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
    return this._ifaceSettings?.get_boolean("enable-animations") ?? true;
  }

  _refreshGeometry() {
    // Settings / monitor changes during an animation re-target the
    // running ease; otherwise they snap (same as the old behaviour).
    if (this._state === State.EXPANDING || this._state === State.COLLAPSING)
      this._applySize(true);
    else this._applySize(false);
  }

  _targetExpanded() {
    return this._state === State.EXPANDING || this._state === State.EXPANDED;
  }

  _expandedDims(monitor) {
    return [
      Math.min(EXPANDED_W, Math.max(320, monitor.width - 16)),
      Math.min(EXPANDED_H, Math.max(240, monitor.height - 16)),
    ];
  }

  _peekDims(monitor) {
    return [Math.min(PEEK_W, Math.max(280, monitor.width - 16)), PEEK_H];
  }

  // Anchor for the wide modes (expanded / peek): same edge the pill
  // lives on, never swapped — the content is always landscape.
  _anchorFor(style, position, monitor, W, H) {
    if (style === 0 || position === 0)
      return [
        Math.round(monitor.x + (monitor.width - W) / 2),
        style === 0 ? monitor.y : monitor.y + 6,
      ];
    if (position === 1)
      return [
        Math.round(monitor.x + (monitor.width - W) / 2),
        monitor.y + monitor.height - H - 6,
      ];
    if (position === 2)
      return [monitor.x + 6, Math.round(monitor.y + (monitor.height - H) / 2)];
    return [
      monitor.x + monitor.width - W - 6,
      Math.round(monitor.y + (monitor.height - H) / 2),
    ];
  }

  _syncViews() {
    if (!this._clockWidget) return;
    const open =
      this._state === State.EXPANDING ||
      this._state === State.EXPANDED ||
      this._state === State.COLLAPSING;
    this._expandedView.visible = open;
    this._peekView.visible = !open && this._peekActive;
    this._clockWidget.visible = !open && !this._peekActive;
  }

  _applySize(animate = true) {
    const monitor = Main.layoutManager.primaryMonitor;
    if (!monitor || !this._notch) return;

    const style = this._settings.get_enum("notch-style");
    const position = this._settings.get_enum("pill-position");
    const w = this._settings.get_int("notch-width");
    const h = this._settings.get_int("notch-height");
    const expanded = this._targetExpanded();
    const peek = !expanded && this._peekActive && this._state === State.COMPACT;

    let x, y, notchW, notchH;

    if (expanded) {
      [notchW, notchH] = this._expandedDims(monitor);
      [x, y] = this._anchorFor(style, position, monitor, notchW, notchH);
      this._clockWidget.orientation = Clutter.Orientation.HORIZONTAL;
    } else if (peek) {
      [notchW, notchH] = this._peekDims(monitor);
      [x, y] = this._anchorFor(style, position, monitor, notchW, notchH);
      this._clockWidget.orientation = Clutter.Orientation.HORIZONTAL;
    } else if (style === 0) {
      // apple, compact
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
          notchW = w;
          notchH = h;
          this._clockWidget.orientation = Clutter.Orientation.HORIZONTAL;
          break;
        case 1:
          x = Math.round(monitor.x + (monitor.width - w) / 2);
          y = monitor.y + monitor.height - h - 6;
          notchW = w;
          notchH = h;
          this._clockWidget.orientation = Clutter.Orientation.HORIZONTAL;
          break;
        case 2:
          x = monitor.x + 6;
          y = Math.round(monitor.y + (monitor.height - w) / 2);
          notchW = h;
          notchH = w;
          this._clockWidget.orientation = Clutter.Orientation.VERTICAL;
          break;
        default:
          x = monitor.x + monitor.width - h - 6;
          y = Math.round(monitor.y + (monitor.height - w) / 2);
          notchW = h;
          notchH = w;
          this._clockWidget.orientation = Clutter.Orientation.VERTICAL;
          break;
      }
    }

    // Live chips widen the compact pill to the content's natural
    // width, measured before the animation starts.
    if (
      !expanded &&
      !peek &&
      (this._timerChip?.visible || this._notifChip?.visible)
    ) {
      const [, nat] = this._clockWidget.get_preferred_width(-1);
      if (nat > 0)
        notchW = Math.max(notchW, Math.min(nat + 8, monitor.width - 16));
    }

    // Pre-size every view to its final geometry, so layout stays frozen mid-animation.
    const [expW, expH] = this._expandedDims(monitor);
    this._expandedView.set_size(expW, expH);
    const [pkW, pkH] = this._peekDims(monitor);
    this._peekView.set_size(pkW, pkH);
    if (!expanded && !peek) this._clockWidget.set_size(notchW, notchH);

    const onDone = this._animOnDone;
    if (animate && this._animationsEnabled()) {
      // Kill any running ease first, so rapid toggling reverses instead of stacking.
      this._notch.remove_all_transitions();
      this._notch.ease({
        x,
        y,
        width: notchW,
        height: notchH,
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
    if (!this._notch) return;
    const apple = this._settings.get_enum("notch-style") === 0;
    const bg = this._settings.get_string("notch-bg");
    const r = this._settings.get_int("notch-radius");

    if (apple) {
      this._notch.set_style(
        `background-color: ${bg}; border-radius: 0 0 ${r}px ${r}px;`,
      );
      this._notch.remove_style_class_name("dn-notch-pill");
      this._notch.add_style_class_name("dn-notch-apple");
    } else {
      this._notch.set_style(`background-color: ${bg}; border-radius: ${r}px;`);
      this._notch.remove_style_class_name("dn-notch-apple");
      this._notch.add_style_class_name("dn-notch-pill");
    }

    // Foreground: explicit light/dark, or auto from the notch's own
    // known background color.
    const fgMode = this._settings.get_enum("notch-text-mode");
    let fg = null;
    if (fgMode === 1) fg = "light";
    else if (fgMode === 2) fg = "dark";
    else {
      const c = parseColor(bg);
      fg = c && luminance(c) > 0.6 ? "dark" : "light";
    }
    this._notch.remove_style_class_name("dn-fg-light");
    this._notch.remove_style_class_name("dn-fg-dark");
    this._notch.add_style_class_name(`dn-fg-${fg}`);
  }

  // -------------------------------------------- providers / integration

  _initProviders() {
    // Failure-isolated: if the tray API differs, everything else keeps working.
    try {
      this._notifProvider = new NotificationsProvider({
        onLive: (n) => this._onLiveNotification(n),
        onChanged: () => {
          this._refreshNotifList();
          this._updateNotifChip();
        },
      });
      this._notifProvider.start();
      this._notifAvailable = true;
    } catch (e) {
      logError(e, "dynamic-notch: notifications integration unavailable");
      this._notifProvider = null;
      this._notifAvailable = false;
      try {
        Main.messageTray.bannerBlocked = false;
      } catch (_e) {}
    }

    // Calendar events: the month grid never depends on this.
    try {
      this._calProvider = new CalendarProvider({
        onChanged: () => {
          this._renderCalendar();
        },
      });
      this._calAvailable = true;
    } catch (e) {
      logError(e, "dynamic-notch: calendar events unavailable");
      this._calProvider = null;
      this._calAvailable = false;
    }

    // Do Not Disturb quick action (desktop notifications schema).
    try {
      this._desktopNotifSettings = new Gio.Settings({
        schema_id: "org.gnome.desktop.notifications",
      });
      this._dndChangedId = this._desktopNotifSettings.connect(
        "changed::show-banners",
        () => this._syncDndButton(),
      );
    } catch (_e) {
      this._desktopNotifSettings = null;
    }

    const now = GLib.DateTime.new_now_local();
    this._calCursor = now;
    this._calSelected = now;
    this._lastDayKey = now.format("%Y-%m-%d");
    this._weekStart = this._detectWeekStart();
    if (this._calProvider) {
      try {
        this._calProvider.ensureMonth(
          new Date(now.get_year(), now.get_month() - 1, 1),
        );
        this._calProvider.selectDay(
          new Date(now.get_year(), now.get_month() - 1, now.get_day_of_month()),
        );
      } catch (_e) {}
    }
    this._refreshNotifList();
    this._updateNotifChip();
  }

  _detectWeekStart() {
    // Week start from the gtk40 'calendar:week_start:0' translation; fallback Monday.
    try {
      const s = GLib.dgettext("gtk40", "calendar:week_start:0");
      const m = s.match(/week_start:([0-6])/);
      if (m) return Number(m[1]);
    } catch (_e) {}
    return 1;
  }

  // ------------------------------------------------------------ peek

  _showPeek(
    {
      gicon = null,
      iconName = "dialog-information-symbolic",
      title = "",
      body = "",
    },
    durationMs,
  ) {
    if (gicon) {
      this._peekIcon.gicon = gicon;
    } else {
      this._peekIcon.gicon = null;
      this._peekIcon.icon_name = iconName;
    }
    this._peekTitle.text = title;
    this._peekBody.text = body;

    // The expanded panel already shows everything; no peek needed.
    if (this._state === State.EXPANDED || this._state === State.EXPANDING)
      return;
    this._peekActive = true;
    // Arm the timeout in every state so a queued peek cannot get stuck.
    if (this._peekTimeoutId) GLib.source_remove(this._peekTimeoutId);
    this._peekTimeoutId = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      durationMs,
      () => {
        this._peekTimeoutId = 0;
        this._hidePeek();
        return GLib.SOURCE_REMOVE;
      },
    );
    if (this._state === State.COLLAPSING) return; // collapse onDone re-applies size for the peek
    this._syncViews();
    this._applySize(true);
  }

  _hidePeek() {
    if (this._peekTimeoutId) {
      GLib.source_remove(this._peekTimeoutId);
      this._peekTimeoutId = 0;
    }
    if (!this._peekActive) return;
    this._peekActive = false;
    if (this._state !== State.COMPACT) return;
    this._animOnDone = () => this._syncViews();
    this._applySize(true);
  }

  // ------------------------------------------------------ notifications

  _notifFields(n) {
    const f = { app: "", title: "", body: "", time: "", gicon: null };
    try {
      f.app = n.source?.title ?? "";
    } catch (_e) {}
    try {
      f.title = n.title ?? "";
    } catch (_e) {}
    try {
      f.body = n.body ?? "";
    } catch (_e) {}
    try {
      f.time = n.datetime.format("%H:%M");
    } catch (_e) {}
    try {
      f.gicon = n.icon ?? n.gicon ?? n.source?.icon ?? null;
    } catch (_e) {}
    return f;
  }

  _onLiveNotification(n) {
    const f = this._notifFields(n);
    const message =
      f.title && f.body ? `${f.title}: ${f.body}` : f.title || f.body;
    this._showPeek(
      {
        gicon: f.gicon,
        title: f.app || "Notification",
        body: message,
      },
      NOTIF_PEEK_MS,
    );
    this._refreshNotifList();
    this._updateNotifChip();
  }

  _updateNotifChip() {
    if (!this._notifChip) return;
    let count = 0;
    try {
      count = this._notifProvider?.badge ?? 0;
    } catch (_e) {}
    this._notifChip.visible = count > 0;
    this._notifChipLabel.text = `${count}`;
    if (this._state === State.COMPACT && !this._peekActive)
      this._refreshGeometry();
  }

  _refreshNotifList() {
    if (!this._notifList) return;
    this._notifList.destroy_all_children();
    let all = [];
    if (this._notifAvailable && this._notifProvider) {
      try {
        all = this._notifProvider.getAll();
      } catch (e) {
        logError(e, "dynamic-notch: reading notifications failed");
        all = [];
      }
    }
    this._notifCount.text = this._notifAvailable ? ` ${all.length}` : " n/a";
    this._clearButton.reactive = all.length > 0;
    this._clearButton.opacity = all.length > 0 ? 255 : 120;
    this._notifEmpty.visible = all.length === 0;
    this._notifEmpty.text = this._notifAvailable
      ? "No notifications"
      : "Notifications unavailable";
    for (const n of all.slice(0, MAX_NOTIF_ITEMS))
      this._notifList.add_child(this._makeNotifItem(n));
    if (all.length > MAX_NOTIF_ITEMS) {
      this._notifList.add_child(
        new St.Label({
          text: `+${all.length - MAX_NOTIF_ITEMS} more…`,
          style_class: "dn-card-body",
        }),
      );
    }
    this._syncQaStates();
  }

  _makeNotifItem(n) {
    const f = this._notifFields(n);
    const button = new St.Button({
      style_class: "dn-notif-item",
      x_expand: true,
    });
    const row = new St.BoxLayout({ style_class: "dn-notif-row" });
    const icon = f.gicon
      ? new St.Icon({ gicon: f.gicon, icon_size: 20 })
      : new St.Icon({
          icon_name: "dialog-information-symbolic",
          icon_size: 20,
        });
    icon.y_align = Clutter.ActorAlign.CENTER;
    row.add_child(icon);
    const texts = new St.BoxLayout({
      orientation: Clutter.Orientation.VERTICAL,
      x_expand: true,
    });
    const title = new St.Label({
      text: f.title || f.app || "(no title)",
      style_class: "dn-notif-item-title",
    });
    title.get_clutter_text().set_ellipsize(Pango.EllipsizeMode.END);
    texts.add_child(title);
    const sub = new St.Label({
      text: [f.app, f.time].filter((s) => s).join(" • "),
      style_class: "dn-notif-item-sub",
    });
    sub.get_clutter_text().set_ellipsize(Pango.EllipsizeMode.END);
    texts.add_child(sub);
    if (f.body && f.body !== f.title) {
      const body = new St.Label({
        text: f.body,
        style_class: "dn-notif-item-sub",
      });
      body.get_clutter_text().set_ellipsize(Pango.EllipsizeMode.END);
      texts.add_child(body);
    }
    row.add_child(texts);
    button.child = row;
    button.connect("clicked", () => {
      // Activate the real notification (opens its app / action)
      // when the object offers it, then tidy up our own state.
      try {
        n.activate();
      } catch (_e) {
        // Some notifications have no activation; not an error
        // worth logging on every click.
      }
      try {
        n.acknowledged = true;
      } catch (_e) {}
      this._hidePeek();
      this._closePanel();
    });
    return button;
  }

  // ---------------------------------------------------------- calendar

  _calFirstOfMonth(dt) {
    return GLib.DateTime.new_local(dt.get_year(), dt.get_month(), 1, 0, 0, 0);
  }

  _sameDay(a, b) {
    return (
      a.get_year() === b.get_year() &&
      a.get_month() === b.get_month() &&
      a.get_day_of_month() === b.get_day_of_month()
    );
  }

  _renderCalendar() {
    if (!this._calTitle || !this._calCursor) return;
    const cursor = this._calFirstOfMonth(this._calCursor);
    this._calTitle.text = cursor.format("%B %Y");

    // Weekday headers in locale order, starting at _weekStart.
    // 2023-01-01 was a Sunday, so +N days gives weekday N (0=Sun).
    const sunday = GLib.DateTime.new_local(2023, 1, 1, 0, 0, 0);
    for (let i = 0; i < 7; i++)
      this._calWeekdayLabels[i].text = sunday
        .add_days((this._weekStart + i) % 7)
        .format("%a");

    const firstIdx = cursor.get_day_of_week() % 7; // Sunday = 0
    const offset = (firstIdx - this._weekStart + 7) % 7;
    const firstCell = cursor.add_days(-offset);
    const now = GLib.DateTime.new_now_local();

    for (let i = 0; i < 42; i++) {
      const d = firstCell.add_days(i);
      const cell = this._calCells[i];
      cell.button._dnDate = d;
      cell.label.text = `${d.get_day_of_month()}`;
      let cls = "dn-cal-cell";
      if (d.get_month() !== cursor.get_month()) cls += " dn-cal-dim";
      if (this._sameDay(d, now)) cls += " dn-cal-today";
      if (this._calSelected && this._sameDay(d, this._calSelected))
        cls += " dn-cal-selected";
      if (this._calProvider) {
        try {
          if (
            this._calProvider.hasEvents(
              new Date(d.get_year(), d.get_month() - 1, d.get_day_of_month()),
            )
          )
            cls += " dn-cal-has-events";
        } catch (_e) {}
      }
      cell.button.style_class = cls;
    }
    this._renderCalEvents();
  }

  _renderCalEvents() {
    if (!this._calEventLabels?.length || !this._calSelected) return;
    let lines;
    if (!this._calAvailable || !this._calProvider) {
      lines = ["Calendar source unavailable"];
    } else {
      try {
        const sel = this._calSelected;
        const evs = this._calProvider.getEventsForDay(
          new Date(sel.get_year(), sel.get_month() - 1, sel.get_day_of_month()),
        );
        lines = evs
          .slice(0, 3)
          .map((ev) =>
            `${this._fmtTimeJS(ev.date)} ${ev.summary ?? ""}`.trim(),
          );
        if (!lines.length) lines = ["No events"];
      } catch (_e) {
        lines = ["Calendar source unavailable"];
      }
    }
    this._calEventLabels.forEach((label, i) => {
      label.text = lines[i] ?? "";
    });
  }

  _fmtTimeJS(date) {
    const pad = (v) => `${v}`.padStart(2, "0");
    return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  _calMoveMonth(delta) {
    if (!this._calCursor) return;
    const c = this._calFirstOfMonth(this._calCursor).add_months(delta);
    this._calCursor = c;
    if (this._calProvider) {
      try {
        this._calProvider.ensureMonth(
          new Date(c.get_year(), c.get_month() - 1, 1),
        );
      } catch (_e) {}
    }
    this._renderCalendar();
  }

  _calSelectDay(dt) {
    this._calSelected = dt;
    if (this._calProvider) {
      try {
        this._calProvider.selectDay(
          new Date(dt.get_year(), dt.get_month() - 1, dt.get_day_of_month()),
        );
      } catch (_e) {}
    }
    this._renderCalendar();
  }

  // ------------------------------------------------------------- timer

  _fmtTimer(sec) {
    const s = Math.max(0, Math.round(sec));
    const pad = (v) => `${v}`.padStart(2, "0");
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    return h > 0 ? `${h}:${pad(m)}:${pad(r)}` : `${pad(m)}:${pad(r)}`;
  }

  _fmtTimerHMS(sec) {
    const s = Math.max(0, Math.round(sec));
    const pad = (v) => `${v}`.padStart(2, "0");
    return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
  }

  _timerRemaining() {
    if (this._timerState === "running") {
      return Math.max(
        0,
        Math.ceil((this._timerDeadline - GLib.get_monotonic_time()) / 1e6),
      );
    }
    if (this._timerState === "paused" || this._timerState === "finished")
      return this._timerRemainSec;
    return this._timerTotalSec;
  }

  _syncTimerTimeout() {
    if (this._timerState === "running" && !this._timerTimeoutId) {
      this._timerTimeoutId = GLib.timeout_add_seconds(
        GLib.PRIORITY_DEFAULT,
        1,
        () => {
          if (this._timerState !== "running") {
            this._timerTimeoutId = 0;
            return GLib.SOURCE_REMOVE;
          }
          this._timerTick();
          return GLib.SOURCE_CONTINUE;
        },
      );
    } else if (this._timerState !== "running" && this._timerTimeoutId) {
      GLib.source_remove(this._timerTimeoutId);
      this._timerTimeoutId = 0;
    }
  }

  _persistTimerDefaults() {
    try {
      this._settings.set_string("timer-title", this._timerTitle);
      this._settings.set_int("timer-duration", this._timerTotalSec);
    } catch (_e) {}
  }

  _sanitizeDurEntry(entry) {
    const clean = entry.text.replace(/[^0-9]/g, "").slice(0, 2);
    if (clean !== entry.text) entry.text = clean;
  }

  _readDurationEntries() {
    const num = (e) => parseInt(e.text, 10) || 0;
    return num(this._durH) * 3600 + num(this._durM) * 60;
  }

  _syncDurationEntries() {
    if (!this._durH) return;
    // The form is hours+minutes only: at rest the total snaps to whole minutes.
    if (this._timerState === "idle" || this._timerState === "finished") {
      this._timerTotalSec =
        Math.floor(this._timerTotalSec / 3600) * 3600 +
        Math.floor((this._timerTotalSec % 3600) / 60) * 60;
      if (this._timerState === "idle")
        this._timerRemainSec = this._timerTotalSec;
    }
    const pad = (v) => `${v}`.padStart(2, "0");
    this._durH.text = pad(Math.floor(this._timerTotalSec / 3600));
    this._durM.text = pad(Math.floor((this._timerTotalSec % 3600) / 60));
  }

  _timerStart() {
    if (this._timerState === "running") return;
    if (this._timerState === "paused") {
      this._timerResume();
      return;
    }
    this._timerTitle = this._timerTitleEntry.text.trim() || "Focus Timer";
    const fromEntries = this._readDurationEntries();
    if (fromEntries <= 0) {
      this._syncDurationEntries();
      return;
    }
    this._timerTotalSec = fromEntries;
    this._syncDurationEntries();
    this._persistTimerDefaults();
    this._timerRemainSec = this._timerTotalSec;
    this._timerDeadline =
      GLib.get_monotonic_time() + this._timerRemainSec * 1e6;
    this._timerState = "running";
    this._syncTimerTimeout();
    this._renderTimer();
    if (this._state === State.COMPACT && !this._peekActive)
      this._applySize(false);
  }

  _timerPause() {
    if (this._timerState !== "running") return;
    this._timerRemainSec = this._timerRemaining();
    this._timerState = "paused";
    this._syncTimerTimeout();
    this._renderTimer();
    if (this._state === State.COMPACT && !this._peekActive)
      this._applySize(false);
  }

  _timerResume() {
    if (this._timerState !== "paused") return;
    this._timerDeadline =
      GLib.get_monotonic_time() + this._timerRemainSec * 1e6;
    this._timerState = "running";
    this._syncTimerTimeout();
    this._renderTimer();
    if (this._state === State.COMPACT && !this._peekActive)
      this._applySize(false);
  }

  _timerStop() {
    this._timerState = "idle";
    this._timerRemainSec = this._timerTotalSec;
    this._syncTimerTimeout();
    if (this._timerFinishTimeoutId) {
      GLib.source_remove(this._timerFinishTimeoutId);
      this._timerFinishTimeoutId = 0;
    }
    this._renderTimer();
    this._syncDurationEntries();
    if (this._state === State.COMPACT && !this._peekActive)
      this._applySize(false);
  }

  _timerPlayPause() {
    if (this._timerState === "running") this._timerPause();
    else if (this._timerState === "paused") this._timerResume();
    else this._timerStart();
  }

  // Reset stops the countdown and restores the configured (form) duration.
  _timerReset() {
    const configured = this._readDurationEntries();
    this._timerStop();
    if (configured > 0 && configured !== this._timerTotalSec) {
      this._timerTotalSec = configured;
      this._timerRemainSec = configured;
      this._syncDurationEntries();
      this._renderTimer();
    }
  }

  _timerTick() {
    if (this._timerRemaining() > 0) {
      this._renderTimer();
      return;
    }
    this._timerFinish();
  }

  _timerFinish() {
    this._timerRemainSec = 0;
    this._timerState = "finished";
    this._syncTimerTimeout();
    this._renderTimer();
    this._showPeek(
      {
        iconName: "alarm-symbolic",
        title: "Time's up!",
        body: this._timerTitle,
      },
      TIMER_PEEK_MS,
    );
    if (this._timerFinishTimeoutId)
      GLib.source_remove(this._timerFinishTimeoutId);
    this._timerFinishTimeoutId = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      TIMER_PEEK_MS + ANIM_MS,
      () => {
        this._timerFinishTimeoutId = 0;
        if (this._timerState === "finished") this._timerStop();
        return GLib.SOURCE_REMOVE;
      },
    );
  }

  _renderTimer() {
    if (!this._timerLabel) return;
    const state = this._timerState;
    const remain = this._timerRemaining();
    const countText =
      state === "finished"
        ? "Time's up!"
        : this._fmtTimerHMS(state === "idle" ? this._timerTotalSec : remain);
    this._timerLabel.text = countText;

    const running = state === "running";
    this._playPauseIcon.icon_name = running
      ? "media-playback-pause-symbolic"
      : "media-playback-start-symbolic";
    this._playPauseLabel.text = running ? "Pause" : "Play";
    this._btnReset.reactive = state !== "idle";
    this._btnReset.opacity = state !== "idle" ? 255 : 110;
    const editable = state === "idle" || state === "finished";
    this._timerTitleEntry.reactive = editable;
    this._timerTitleEntry.opacity = editable ? 255 : 140;
    for (const entry of [this._durH, this._durM]) {
      entry.reactive = editable;
      entry.opacity = editable ? 255 : 140;
    }

    // An active timer takes over the compact island; the clock
    // stays in the expanded corner instead.
    this._timerChip.visible = state !== "idle";
    this._timerChipLabel.text =
      state === "finished"
        ? "Time's up!"
        : `${this._timerTitle} — ${this._fmtTimer(remain)}` +
          (state === "paused" ? " · Paused" : "");
    if (this._clockTime) this._clockTime.visible = state === "idle";
    this._syncQaStates();
  }

  // ------------------------------------------------------- quick actions

  _syncDndButton() {
    this._syncQaStates();
  }

  _toggleDnd() {
    if (!this._desktopNotifSettings) return;
    const s = this._desktopNotifSettings;
    s.set_boolean("show-banners", !s.get_boolean("show-banners"));
    this._syncDndButton();
  }

  _qaCalendarToday() {
    const now = GLib.DateTime.new_now_local();
    this._calCursor = now;
    this._calSelected = now;
    if (this._calProvider) {
      try {
        this._calProvider.ensureMonth(
          new Date(now.get_year(), now.get_month() - 1, 1),
        );
        this._calProvider.selectDay(
          new Date(now.get_year(), now.get_month() - 1, now.get_day_of_month()),
        );
      } catch (_e) {}
    }
    this._renderCalendar();
    if (this._state === State.COMPACT) this._openPanel();
  }

  // ------------------------------------------------- panel background

  _schedulePanelUpdate() {
    if (this._panelDebounceId) return;
    this._panelDebounceId = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      PANEL_DEBOUNCE_MS,
      () => {
        this._panelDebounceId = 0;
        this._updatePanelAppearance();
        return GLib.SOURCE_REMOVE;
      },
    );
  }

  _scheduleOverviewRecheck() {
    // Re-check after the Overview's own panel restyle has settled.
    if (this._overviewRecheckId) GLib.source_remove(this._overviewRecheckId);
    this._overviewRecheckId = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      350,
      () => {
        this._overviewRecheckId = 0;
        this._updatePanelAppearance();
        return GLib.SOURCE_REMOVE;
      },
    );
  }

  // Returns 'theme' | 'transparent' | 'solid' | 'semi'
  _desiredPanelBg() {
    const mode = this._settings.get_enum("panel-bg-mode"); // theme, transparent, solid, semi-transparent

    // Lock / login screens and the Overview always get the stock
    // transparent overview look, whatever the configured mode.
    if (
      !Main.sessionMode.hasWindows ||
      Main.overview.visible ||
      Main.overview.visibleTarget ||
      Main.panel.has_style_pseudo_class("overview")
    )
      return "transparent";

    // 'transparent-panel' stays the dynamic switch (details in README).
    if (this._settings.get_boolean("transparent-panel")) {
      if (!Main.layoutManager.primaryMonitor) return "transparent";
      const activeWorkspace = global.workspace_manager.get_active_workspace();
      const windows = activeWorkspace.list_windows().filter((metaWindow) => {
        return (
          metaWindow.is_on_primary_monitor() &&
          metaWindow.showing_on_its_workspace() &&
          !metaWindow.is_hidden() &&
          metaWindow.get_window_type() !== Meta.WindowType.DESKTOP
        );
      });
      const panelTop = Main.panel.get_transformed_position()[1];
      const panelBottom = panelTop + Main.panel.get_height();
      const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
      const near = windows.some(
        (metaWindow) => metaWindow.get_frame_rect().y < panelBottom + 5 * scale,
      );
      if (!near) return "transparent";
      if (mode === 2) return "solid";
      if (mode === 3) return "semi";
      return "theme";
    }

    switch (mode) {
      case 1:
        return "transparent";
      case 2:
        return "solid";
      case 3:
        return "semi";
      case 0:
      default:
        return "theme";
    }
  }

  _desiredPanelFg(bg) {
    const fgMode = this._settings.get_enum("panel-text-mode"); // auto, light, dark
    if (fgMode === 1) return "light";
    if (fgMode === 2) return "dark";
    // Auto: only computed from a color we actually know.
    if (bg === "solid" || bg === "semi") {
      const c = parseColor(this._settings.get_string("panel-color"));
      return c && luminance(c) > 0.6 ? "dark" : "light";
    }
    if (bg === "transparent") return "light"; // documented fallback — wallpaper is NOT read
    return null; // theme: leave the theme's own foreground alone
  }

  _updatePanelAppearance() {
    if (!this._settings) return;
    const bg = this._desiredPanelBg();
    const fg = this._desiredPanelFg(bg);

    let style = null;
    if (bg === "solid" || bg === "semi") {
      const c = parseColor(this._settings.get_string("panel-color"));
      if (c)
        style = `background-color: ${rgbaString(c, bg === "solid" ? 1 : c.a)};`;
    }

    // The whole point of the rework: if nothing changed, touch
    // nothing. Re-setting the same style restarts the transition.
    if (
      bg === this._appliedPanelBg &&
      style === this._appliedPanelStyle &&
      fg === this._appliedPanelFg
    )
      return;

    const panel = Main.panel;
    panel.remove_style_class_name("dn-panel-transparent");
    if (bg === "transparent")
      panel.add_style_class_name("dn-panel-transparent");

    if (style !== this._appliedPanelStyle) {
      // Plain inline background-color only, so the #panel CSS transition can animate it.
      panel.set_style(style);
      const cornerStyle =
        bg === "solid" || bg === "semi"
          ? `-panel-corner-background-color: ${style.slice("background-color: ".length, -1)};`
          : null;
      for (const child of panel.get_children()) {
        if (child.has_style_class_name("panel-corner"))
          child.set_style(cornerStyle);
      }
    }

    panel.remove_style_class_name("dn-fg-light");
    panel.remove_style_class_name("dn-fg-dark");
    if (fg) panel.add_style_class_name(`dn-fg-${fg}`);

    this._appliedPanelBg = bg;
    this._appliedPanelStyle = style;
    this._appliedPanelFg = fg;
  }

  _restorePanel() {
    const panel = Main.panel;
    panel.remove_style_class_name("dn-panel-transparent");
    panel.remove_style_class_name("dn-fg-light");
    panel.remove_style_class_name("dn-fg-dark");
    // Also clears the legacy 'transparent-top-bar' class + inline
    // styles an older build of this extension may have left behind.
    panel.remove_style_class_name("transparent-top-bar");
    panel.set_style(null);
    for (const child of panel.get_children()) {
      if (child.has_style_class_name("panel-corner")) child.set_style(null);
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
      metaWindowActor.connect("notify::allocation", () =>
        this._schedulePanelUpdate(),
      ),
      metaWindowActor.connect("notify::visible", () =>
        this._schedulePanelUpdate(),
      ),
    ]);
    this._schedulePanelUpdate();
  }

  _onWindowActorRemoved(_container, metaWindowActor) {
    if (!this._windowSignalIds) return;
    for (const signalId of this._windowSignalIds.get(metaWindowActor) ?? []) {
      try {
        metaWindowActor.disconnect(signalId);
      } catch (_e) {}
    }
    this._windowSignalIds.delete(metaWindowActor);
    this._schedulePanelUpdate();
  }
}
