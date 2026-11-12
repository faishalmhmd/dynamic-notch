// Dynamic Notch — clock notch / Dynamic Island, GNOME Shell 51.

import Cairo from "cairo";
import Clutter from "gi://Clutter";
import GdkPixbuf from "gi://GdkPixbuf";
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
import { SystemEventsProvider } from "./lib/event.js";
import { ClipboardProvider } from "./lib/clipboard.js";
import { MusicProvider } from "./lib/musicProvider.js";
import { scanListeningPorts } from "./lib/portsProvider.js";

const EXPANDED_W = 700;
const EXPANDED_H = 440;
const PEEK_W = 480;
const PEEK_H = 78;
const ANIM_MS = 300;
const PANEL_DEBOUNCE_MS = 100;
const NOTIF_PEEK_MS = 4500;
const TIMER_PEEK_MS = 6000;
const EVENT_MS = 2800;
const MAX_APPS = 12;
const FILLET_R = 10;

// Spring curves after Ding (MIT, ding.yusufcengiz.dev): closed-form
// damped spring, 0 -> 1. Morph uses stiffness 340 / damping 27.
function _springPos(t, k, c, m) {
  const w0 = Math.sqrt(k / m);
  const z = c / (2 * Math.sqrt(k * m));
  if (z < 1) {
    const wd = w0 * Math.sqrt(1 - z * z);
    return (
      1 -
      Math.exp(-z * w0 * t) *
        (Math.cos(wd * t) + ((z * w0) / wd) * Math.sin(wd * t))
    );
  }
  if (z === 1) return 1 - Math.exp(-w0 * t) * (1 + w0 * t);
  const s = w0 * Math.sqrt(z * z - 1);
  const r1 = -z * w0 + s;
  const r2 = -z * w0 - s;
  return 1 - (r2 * Math.exp(r1 * t) - r1 * Math.exp(r2 * t)) / (r2 - r1);
}

// Morph spring duration: its settle time (last t >0.5% from rest).
const MORPH_SPRING_MS = (() => {
  let settle = 0.05;
  for (let t = 0; t <= 2; t += 1 / 120) {
    if (Math.abs(1 - _springPos(t, 340, 27, 1)) > 0.005) settle = t;
  }
  return Math.min(500, Math.round((settle + 1 / 120) * 1000));
})();

// Lateral shake offset (px): Ding's 520/13 shake spring, kicked
// gently (v = 70 px/s) so the first swing is only ~2 px.
function _shakePos(t) {
  const w0 = Math.sqrt(520);
  const z = 13 / (2 * w0);
  const wd = w0 * Math.sqrt(1 - z * z);
  return (70 / wd) * Math.exp(-z * w0 * t) * Math.sin(wd * t);
}

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
  ["clipboard", "edit-paste-symbolic", "Clipboard"],
  ["today", "x-office-calendar-symbolic", "Today"],
  ["clear", "edit-clear-symbolic", "Clear Notifications"],
  ["settings", "preferences-system-symbolic", "Extension Settings"],
];

const TAB_DEFS = [
  ["main", "Main", "x-office-calendar-symbolic"],
  ["timer", "Timer", "alarm-symbolic"],
  ["clipboard", "Clipboard", "edit-paste-symbolic"],
  ["media", "Media", "media-playback-start-symbolic"],
  ["ports", "Ports", "network-server-symbolic"],
];

const PLAYER_NAMES = {
  vlc: "VLC",
  spotify: "Spotify",
  firefox: "Firefox",
  chromium: "Chromium",
  "google-chrome": "Chrome",
  brave: "Brave",
  mpv: "mpv",
  rhythmbox: "Rhythmbox",
  lollypop: "Lollypop",
  strawberry: "Strawberry",
  audacious: "Audacious",
  deadbeef: "DeaDBeeF",
  celluloid: "Celluloid",
  totem: "Videos",
  clapper: "Clapper",
  amberol: "Amberol",
  gapless: "Gapless",
  plex: "Plex",
  kodi: "Kodi",
};

const ICON_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9-_.]*$/;

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

    // System event display (transient, centered icon + text)
    this._eventActive = false;
    this._eventTimeoutId = 0;
    this._eventNaturalW = 0;

    // Providers (created in _initProviders, failure-isolated)
    this._notifProvider = null;
    this._notifAvailable = false;
    this._calProvider = null;
    this._calAvailable = false;
    this._eventsProvider = null;
    this._clipProvider = null;
    this._musicProvider = null;
    this._music = null;
    this._eqAreas = [];
    this._eqTimerId = 0;
    this._eqPhase = 0;
    this._artColors = new Map();
    this._artPending = new Set();
    this._artLocal = new Map();
    this._gradientKey = "";
    this._timerRing = null;
    this._ringTimerId = 0;
    this._trayBoxes = [];
    this._traySignals = [];
    this._hiddenTray = new Set();
    this._trayGuardId = 0;
    this._dateMenu = null;
    this._dateMenuContainer = null;
    this._dateMenuOpenId = 0;
    this._dmGuardId = 0;
    this._portsTimerId = 0;

    this._page = "main";
    this._qaButtons = new Map();
    this._tabEntryBtns = [];
    this._scriptProcs = new Set();
    this._peekKind = "notification";
    this._peekNotification = null;
    this._filletColor = null;

    // Running apps (AppSystem signals, failure-isolated)
    this._appSystem = null;
    this._appStateId = 0;
    this._windowCreatedId = 0;
    this._appsDebounceId = 0;
    this._appsWindowIds = new Map();
    this._actorSignalIds = new Map();
    this._windowSignalIds = new Map();
    this._scopeApps = new Map();
    this._appUnits = new Map();
    this._sdUnitNewId = 0;
    this._sdUnitRemovedId = 0;

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
    Main.layoutManager.addChrome(this._notch, { trackFullscreen: true });
    Main.layoutManager.addChrome(this._filletL, { trackFullscreen: true });
    Main.layoutManager.addChrome(this._filletR, { trackFullscreen: true });
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
      if (key === "topbar-icons") this._buildQaButtons();
      if (key === "accent-color") this._applyAccent();
      if (key && key.startsWith("tab-icon-")) this._applyTabIcons();
    });
    this._monitorsChangedId = Main.layoutManager.connect(
      "monitors-changed",
      () => {
        this._applySize(false);
        this._updatePanelAppearance();
      },
    );
    // Re-evaluate fillet visibility the moment fullscreen starts
    // or ends, instead of at the next size pass.
    this._fullscreenChangedId = 0;
    try {
      this._fullscreenChangedId = Main.layoutManager.connect(
        "primary-fullscreen-changed",
        () => this._applySize(false),
      );
    } catch (_e) {}

    // --- Panel background tracking ---
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
    this._initDateMenuSuppression();
    this._initTrayIconHiding();
    this._initApps();
    this._refreshClipList();
    this._renderCalendar();
    this._renderTimer();
    this._syncDndButton();
  }

  disable() {
    // Synchronous, per the Shell 51 porting guide. Everything that
    // enable() installed is removed here, in dependency order.
    if (this._clockTimeoutId) GLib.source_remove(this._clockTimeoutId);
    this._clockTimeoutId = 0;
    if (this._panelDebounceId) GLib.source_remove(this._panelDebounceId);
    this._panelDebounceId = 0;
    if (this._overviewRecheckId) GLib.source_remove(this._overviewRecheckId);
    this._overviewRecheckId = 0;
    if (this._closeIdleId) GLib.source_remove(this._closeIdleId);
    this._closeIdleId = 0;
    if (this._peekTimeoutId) GLib.source_remove(this._peekTimeoutId);
    this._peekTimeoutId = 0;
    if (this._eventTimeoutId) GLib.source_remove(this._eventTimeoutId);
    this._eventTimeoutId = 0;
    if (this._timerTimeoutId) GLib.source_remove(this._timerTimeoutId);
    this._timerTimeoutId = 0;
    if (this._timerFinishTimeoutId)
      GLib.source_remove(this._timerFinishTimeoutId);
    this._timerFinishTimeoutId = 0;
    if (this._appsDebounceId) GLib.source_remove(this._appsDebounceId);
    this._appsDebounceId = 0;

    // Providers first: restore stock banners while our actors still exist.
    if (this._dmGuardId) GLib.source_remove(this._dmGuardId);
    this._dmGuardId = 0;
    if (this._portsTimerId) GLib.source_remove(this._portsTimerId);
    this._portsTimerId = 0;
    if (this._dateMenu && this._dateMenuOpenId) {
      try {
        this._dateMenu.menu.disconnect(this._dateMenuOpenId);
      } catch (_e) {}
    }
    this._dateMenuOpenId = 0;
    if (this._dateMenuContainer)
      this._dateMenuContainer.visible = this._dateMenuWasVisible ?? true;
    this._dateMenu = null;
    this._dateMenuContainer = null;
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
    if (this._eventsProvider) {
      try {
        this._eventsProvider.destroy();
      } catch (_e) {}
      this._eventsProvider = null;
    }
    if (this._clipProvider) {
      try {
        this._clipProvider.destroy();
      } catch (_e) {}
      this._clipProvider = null;
    }
    if (this._musicProvider) {
      try {
        this._musicProvider.destroy();
      } catch (_e) {}
      this._musicProvider = null;
    }
    if (this._eqTimerId) {
      GLib.source_remove(this._eqTimerId);
      this._eqTimerId = 0;
    }
    if (this._ringTimerId) {
      GLib.source_remove(this._ringTimerId);
      this._ringTimerId = 0;
    }
    if (this._trayGuardId) {
      GLib.source_remove(this._trayGuardId);
      this._trayGuardId = 0;
    }
    this._stopMorphSpring();
    this._stopShake();
    for (const [box, sigId] of this._traySignals ?? []) {
      try {
        box.disconnect(sigId);
      } catch (_e) {}
    }
    this._traySignals = [];
    for (const actor of this._hiddenTray ?? []) {
      try {
        actor.visible = true;
      } catch (_e) {}
    }
    this._hiddenTray?.clear();
    for (const proc of this._scriptProcs ?? []) {
      try {
        proc.force_exit();
      } catch (_e) {}
    }
    this._scriptProcs?.clear();
    this._scriptProcs = null;
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
      this._appsWindowIds = null;
    }
    if (this._sdUnitNewId)
      Gio.DBus.session.signal_unsubscribe(this._sdUnitNewId);
    this._sdUnitNewId = 0;
    if (this._sdUnitRemovedId)
      Gio.DBus.session.signal_unsubscribe(this._sdUnitRemovedId);
    this._sdUnitRemovedId = 0;
    try {
      Gio.DBus.session.call(
        "org.freedesktop.systemd1",
        "/org/freedesktop/systemd1",
        "org.freedesktop.systemd1.Manager",
        "Unsubscribe",
        null,
        null,
        Gio.DBusCallFlags.NONE,
        -1,
        null,
        null,
      );
    } catch (_e) {}
    this._scopeApps = null;
    this._appUnits = null;
    if (this._desktopNotifSettings && this._dndChangedId)
      this._desktopNotifSettings.disconnect(this._dndChangedId);
    this._dndChangedId = 0;
    this._desktopNotifSettings = null;

    // Signals connected on our own actors (ids stored at build time).
    if (this._clockWidget && this._clockPressId)
      this._clockWidget.disconnect(this._clockPressId);
    this._clockPressId = 0;
    if (this._peekCloseBtn && this._peekClosePressId)
      this._peekCloseBtn.disconnect(this._peekClosePressId);
    this._peekClosePressId = 0;
    if (this._peekCloseBtn && this._peekCloseClickedId)
      this._peekCloseBtn.disconnect(this._peekCloseClickedId);
    this._peekCloseClickedId = 0;
    if (this._peekView && this._peekPressId)
      this._peekView.disconnect(this._peekPressId);
    this._peekPressId = 0;
    if (this._clearButton && this._clearClickedId)
      this._clearButton.disconnect(this._clearClickedId);
    this._clearClickedId = 0;
    if (this._btnPlayPause && this._playPauseClickedId)
      this._btnPlayPause.disconnect(this._playPauseClickedId);
    this._playPauseClickedId = 0;
    if (this._btnReset && this._resetClickedId)
      this._btnReset.disconnect(this._resetClickedId);
    this._resetClickedId = 0;

    this._removeOutsideHandlers();
    this._grabHelper = null;
    this._grabbed = false;

    if (this._settings && this._settingsChangedId)
      this._settings.disconnect(this._settingsChangedId);
    this._settingsChangedId = 0;
    if (this._monitorsChangedId)
      Main.layoutManager.disconnect(this._monitorsChangedId);
    this._monitorsChangedId = 0;
    if (this._fullscreenChangedId)
      Main.layoutManager.disconnect(this._fullscreenChangedId);
    this._fullscreenChangedId = 0;

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

    // Destroy every owned actor explicitly, leaves first, so no
    // field keeps a reference into an already-destroyed tree.
    for (const cell of this._calCells ?? []) cell.button?.destroy();
    this._calCells = null;
    this._calWeekdayLabels?.forEach((label) => label.destroy());
    this._calWeekdayLabels = null;
    this._calEventLabels?.forEach((label) => label.destroy());
    this._calEventLabels = null;
    for (const btn of this._qaButtons?.values() ?? []) btn?.destroy();
    this._qaButtons?.clear();
    this._qaButtons = null;
    for (const btn of this._tabButtons?.values() ?? []) btn?.destroy();
    this._tabButtons?.clear();
    this._tabButtons = null;
    this._tabParts?.clear();
    this._tabParts = null;
    this._peekIcon?.destroy();
    this._peekTitle?.destroy();
    this._peekBody?.destroy();
    this._peekCloseBtn?.destroy();
    this._eventIcon?.destroy();
    this._eventLabel?.destroy();
    this._clockTime?.destroy();
    this._timerChipLabel?.destroy();
    this._timerProgressFill?.destroy();
    this._timerProgressTrack?.destroy();
    this._timerChip?.destroy();
    this._notifChipLabel?.destroy();
    this._notifChip?.destroy();
    this._expandedClock?.destroy();
    this._expandedDate?.destroy();
    this._calTitle?.destroy();
    this._notifCount?.destroy();
    this._notifEmpty?.destroy();
    this._clearButton?.destroy();
    this._playPauseIcon?.destroy();
    this._playPauseLabel?.destroy();
    this._timerLabel?.destroy();
    this._tabProgressFill?.destroy();
    this._tabProgressTrack?.destroy();
    this._tooltip?.destroy();
    this._timerTitleEntry?.destroy();
    this._btnPlayPause?.destroy();
    this._btnReset?.destroy();
    this._peekView?.destroy();
    this._eventView?.destroy();
    this._notifScroll?.destroy();
    this._clipScroll?.destroy();
    this._notifList?.destroy();
    this._appsRow?.destroy();
    this._tabBar?.destroy();
    this._topBar?.destroy();
    this._qaBar?.destroy();
    this._pageMain?.destroy();
    this._pageTimer?.destroy();
    this._pageClipboard?.destroy();
    this._pageMedia?.destroy();
    this._pagePorts?.destroy();
    this._clockWidget?.destroy();
    this._expandedView?.destroy();
    this._backdrop?.destroy();
    this._clipper?.destroy();
    this._peekIcon = null;
    this._peekTitle = null;
    this._peekBody = null;
    this._peekCloseBtn = null;
    this._peekView = null;
    this._eventIcon = null;
    this._eventLabel = null;
    this._eventView = null;
    this._clockTime = null;
    this._clockWidget = null;
    this._timerChip = null;
    this._timerChipLabel = null;
    this._timerProgressTrack = null;
    this._timerProgressFill = null;
    this._notifChip = null;
    this._notifChipLabel = null;
    this._expandedClock = null;
    this._expandedDate = null;
    this._calTitle = null;
    this._notifCount = null;
    this._notifEmpty = null;
    this._clearButton = null;
    this._notifList = null;
    this._notifScroll = null;
    this._clipList = null;
    this._clipScroll = null;
    this._clipEmpty = null;
    this._clipClearButton = null;
    this._playPauseIcon = null;
    this._playPauseLabel = null;
    this._timerLabel = null;
    this._btnPlayPause = null;
    this._btnReset = null;
    this._timerTitleEntry = null;
    this._tabProgressTrack = null;
    this._tabProgressFill = null;
    this._musicSection = null;
    this._pageMedia = null;
    this._pagePorts = null;
    this._mediaContent = null;
    this._mediaEmpty = null;
    this._musicSource = null;
    this._musicElapsed = null;
    this._musicTotal = null;
    this._musicArt = null;
    this._musicArtIcon = null;
    this._musicTitle = null;
    this._musicArtist = null;
    this._musicTrack = null;
    this._musicFill = null;
    this._musicPrevBtn = null;
    this._musicPlayBtn = null;
    this._musicNextBtn = null;
    this._musicChip = null;
    this._musicChipLabel = null;
    this._timerRing = null;
    this._eqAreas = null;
    this._tooltip = null;
    this._appsRow = null;
    this._tabBar = null;
    this._topBar = null;
    this._qaBar = null;
    this._pageMain = null;
    this._pageTimer = null;
    this._pageClipboard = null;
    this._expandedView = null;
    this._backdrop = null;
    this._clipper = null;
    this._peekNotification = null;

    for (const f of [this._filletL, this._filletR]) {
      if (f) {
        f.remove_all_transitions();
        Main.layoutManager.removeChrome(f);
        f.destroy();
      }
    }
    this._filletL = this._filletR = null;
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
      reactive: true,
      track_hover: true,
      layout_manager: new Clutter.FixedLayout(),
    });
    // Backdrop carries background + shadow; views live in a
    // separate clipped layer (clipping cut the shadow square).
    this._backdrop = new St.Widget({ style_class: "dn-notch" });
    this._notch.add_child(this._backdrop);
    this._clipper = new St.Widget({
      clip_to_allocation: true,
      layout_manager: new Clutter.FixedLayout(),
    });
    this._notch.add_child(this._clipper);
    this._filletL = this._makeFillet(true);
    this._filletR = this._makeFillet(false);

    // --- Compact view: time + date + live chips ---
    this._clockWidget = new St.BoxLayout({
      style_class: "dn-clock-widget",
      reactive: true,
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.CENTER,
    });
    this._clockTime = new St.Label({
      style_class: "dn-clock-time",
      x_expand: true,
      y_expand: true,
      y_align: Clutter.ActorAlign.CENTER,
      x_align: Clutter.ActorAlign.CENTER,
    });
    this._clockWidget.add_child(this._clockTime);
    this._applyTabular(this._clockTime);

    this._timerChip = new St.BoxLayout({
      style_class: "dn-chip",
      visible: false,
      x_expand: true,
      y_expand: true,
      y_align: Clutter.ActorAlign.CENTER,
    });
    // Symmetric spacers: the chip expands to the pill's full
    // length and its content stays centered within it.
    this._timerChip.add_child(
      new St.Widget({
        x_expand: true,
        y_expand: true,
      }),
    );
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
    this._timerProgressTrack = new St.Widget({
      layout_manager: new Clutter.FixedLayout(),
      style_class: "dn-progress-track",
      y_align: Clutter.ActorAlign.CENTER,
    });
    this._timerProgressTrack.set_size(56, 4);
    this._timerProgressFill = new St.Widget({
      style: this._progressStyle(),
    });
    this._timerProgressFill.set_size(0, 4);
    this._timerProgressTrack.add_child(this._timerProgressFill);
    this._timerChip.add_child(this._timerProgressTrack);
    this._timerChip.add_child(
      new St.Widget({
        x_expand: true,
        y_expand: true,
      }),
    );
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

    this._clockPressId = this._clockWidget.connect("button-press-event", () => {
      this._togglePanel();
      return Clutter.EVENT_STOP;
    });
    this._clipper.add_child(this._clockWidget);

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
    this._peekTitle.get_clutter_text().set_single_line_mode(true);
    this._peekBody = new St.Label({ style_class: "dn-peek-body" });
    this._peekBody.get_clutter_text().set_ellipsize(Pango.EllipsizeMode.END);
    this._peekBody.get_clutter_text().set_single_line_mode(true);
    peekText.add_child(this._peekTitle);
    peekText.add_child(this._peekBody);
    this._peekView.add_child(peekText);
    this._peekCloseBtn = new St.Button({
      style_class: "dn-qa-button dn-close-btn",
      child: new St.Icon({
        icon_name: "window-close-symbolic",
        icon_size: 16,
      }),
      y_align: Clutter.ActorAlign.CENTER,
      accessible_name: "Dismiss notification",
    });
    // Close on PRESS itself, not only 'clicked': St.Button's
    // clicked comes from a gesture a stopped press can starve.
    this._peekClosePressId = this._peekCloseBtn.connect(
      "button-press-event",
      () => {
        this._requestClose();
        return Clutter.EVENT_STOP;
      },
    );
    this._peekCloseClickedId = this._peekCloseBtn.connect("clicked", () =>
      this._requestClose(),
    );
    this._peekView.add_child(this._peekCloseBtn);
    this._peekPressId = this._peekView.connect(
      "button-press-event",
      (_a, event) => {
        if (event.get_source() === this._peekCloseBtn)
          return Clutter.EVENT_STOP;
        this._hidePeek();
        this._openPanel();
        return Clutter.EVENT_STOP;
      },
    );
    this._clipper.add_child(this._peekView);

    // --- Event view: system events, centered icon + text ---
    this._eventView = new St.BoxLayout({
      style_class: "dn-event",
      visible: false,
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.CENTER,
    });
    this._eventIcon = new St.Icon({
      icon_name: "dialog-information-symbolic",
      icon_size: 18,
      y_align: Clutter.ActorAlign.CENTER,
    });
    this._eventView.add_child(this._eventIcon);
    this._eventLabel = new St.Label({
      style_class: "dn-event-label",
      y_align: Clutter.ActorAlign.CENTER,
    });
    this._eventLabel.get_clutter_text().set_ellipsize(Pango.EllipsizeMode.END);
    this._eventView.add_child(this._eventLabel);
    this._clipper.add_child(this._eventView);

    // --- Expanded view: one fixed layout ---
    this._expandedView = new St.Widget({
      style_class: "dn-expanded",
      visible: false,
      opacity: 0,
      layout_manager: new Clutter.BinLayout(),
    });
    this._expandedView.add_child(this._buildExpanded());
    this._clipper.add_child(this._expandedView);

    // Floating helpers, positioned at show time (notch uses FixedLayout).
    this._tooltip = new St.Label({
      style_class: "dn-tooltip",
      visible: false,
    });
    this._clipper.add_child(this._tooltip);
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
    this._applyTabular(this._expandedClock);
    this._expandedDate = new St.Label({ style_class: "dn-corner-date" });
    corner.add_child(this._expandedClock);
    corner.add_child(this._expandedDate);
    corner.connect("button-press-event", () => {
      this._closePanel();
      return Clutter.EVENT_STOP;
    });
    topBar.add_child(corner);
    this._topBar = topBar;
    this._tabBar = new St.BoxLayout({
      style_class: "dn-tab-bar",
      y_align: Clutter.ActorAlign.CENTER,
    });
    this._tabButtons = new Map();
    this._tabParts = new Map();
    for (const [id, label, defIcon] of TAB_DEFS) {
      const icon = new St.Icon({
        icon_name: this._tabIcon(id, defIcon),
        icon_size: 16,
        y_align: Clutter.ActorAlign.CENTER,
      });
      const b = new St.Button({
        child: icon,
        style_class: "dn-tab",
        accessible_name: `${label} tab`,
      });
      b.connect("clicked", () => this._setTab(id));
      this._addTooltip(b, label);
      this._tabButtons.set(id, b);
      this._tabParts.set(id, { icon });
      this._tabBar.add_child(b);
    }
    topBar.add_child(this._tabBar);
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
      orientation: Clutter.Orientation.VERTICAL,
      y_expand: true,
    });
    const mainRow = new St.BoxLayout({
      style_class: "dn-page-row",
      y_expand: true,
    });
    const calArea = this._buildCalendarArea();
    calArea.set_width(252);
    mainRow.add_child(calArea);
    const notifArea = this._buildNotifArea();
    notifArea.x_expand = true;
    mainRow.add_child(notifArea);
    this._pageMain.add_child(mainRow);
    this._pageMain.add_child(this._buildAppsStrip());
    root.add_child(this._pageMain);

    this._pageTimer = new St.BoxLayout({
      style_class: "dn-page-timer",
      orientation: Clutter.Orientation.VERTICAL,
      y_expand: true,
      visible: false,
    });
    const timerStrip = this._buildTimerStrip();
    timerStrip.x_expand = true;
    timerStrip.y_expand = true;
    timerStrip.y_align = Clutter.ActorAlign.CENTER;
    this._pageTimer.add_child(timerStrip);
    this._tabProgressTrack = new St.Widget({
      layout_manager: new Clutter.FixedLayout(),
      style_class: "dn-progress-track",
      x_expand: true,
    });
    this._tabProgressTrack.set_height(4);
    this._tabProgressFill = new St.Widget({
      style: this._progressStyle(),
    });
    this._tabProgressFill.set_size(0, 4);
    this._tabProgressTrack.add_child(this._tabProgressFill);
    this._pageTimer.add_child(this._tabProgressTrack);
    root.add_child(this._pageTimer);
    this._pageMedia = this._buildMediaPage();
    root.add_child(this._pageMedia);
    this._pageClipboard = this._buildClipboardPage();
    root.add_child(this._pageClipboard);
    this._pagePorts = this._buildPortsPage();
    root.add_child(this._pagePorts);
    this._setTab("main");
    return root;
  }

  // Top-bar icon entries come from the 'topbar-icons' key: one
  // JSON object per icon — builtin action, tab switch, or script.
  _parseTopbarEntries() {
    const entries = [];
    let raw = [];
    try {
      raw = this._settings.get_strv("topbar-icons");
    } catch (_e) {}
    const qaIds = new Set(QA_DEFS.map((d) => d[0]));
    const tabIds = new Set(TAB_DEFS.map((d) => d[0]));
    for (const s of raw) {
      let e = null;
      try {
        e = JSON.parse(s);
      } catch (_err) {}
      if (!e || typeof e !== "object") continue;
      const icon =
        typeof e.icon === "string" && ICON_NAME_RE.test(e.icon) ? e.icon : null;
      if (e.mode === "builtin" && qaIds.has(e.id)) {
        const def = QA_DEFS.find((d) => d[0] === e.id);
        entries.push({
          mode: "builtin",
          id: e.id,
          icon: icon ?? def[1],
          label: def[2],
        });
      } else if (e.mode === "tab" && tabIds.has(e.tab)) {
        const def = TAB_DEFS.find((d) => d[0] === e.tab);
        entries.push({
          mode: "tab",
          tab: e.tab,
          icon: icon ?? def[2],
          label: `${def[1]} tab`,
        });
      } else if (
        e.mode === "script" &&
        typeof e.path === "string" &&
        e.path.startsWith("/")
      ) {
        entries.push({
          mode: "script",
          path: e.path,
          icon: icon ?? "utilities-terminal-symbolic",
          label: e.path.split("/").pop() || e.path,
        });
      }
    }
    return entries;
  }

  _buildQaButtons() {
    if (!this._qaBar) return;
    this._qaBar.destroy_all_children();
    this._qaButtons.clear();
    this._tabEntryBtns = [];
    for (const entry of this._parseTopbarEntries()) {
      const button = new St.Button({
        style_class: "dn-qa-button",
        accessible_name: entry.label,
      });
      button.child = new St.Icon({
        icon_name: entry.icon,
        icon_size: 18,
      });
      if (entry.mode === "builtin") {
        button.connect("clicked", () => this._qaActivate(entry.id));
        this._qaButtons.set(entry.id, button);
      } else if (entry.mode === "tab") {
        button.connect("clicked", () => this._setTab(entry.tab));
        this._tabEntryBtns.push({ tab: entry.tab, button });
      } else {
        button.connect("clicked", () => this._runScript(entry.path));
      }
      this._addTooltip(button, entry.label);
      this._qaBar.add_child(button);
    }
    this._syncQaStates();
  }

  _runScript(path) {
    const fail = (why) => {
      logError(new Error(why), "dynamic-notch: script action failed");
      this._showPeek(
        {
          iconName: "dialog-warning-symbolic",
          title: "Script failed",
          body: `${path} — ${why}`,
        },
        4000,
      );
    };
    let proc;
    try {
      const file = Gio.File.new_for_path(path);
      const info = file.query_info(
        "standard::type,access::can-execute",
        Gio.FileQueryInfoFlags.NONE,
        null,
      );
      if (info.get_file_type() !== Gio.FileType.REGULAR) {
        fail("not a regular file");
        return;
      }
      if (!info.get_attribute_boolean("access::can-execute")) {
        fail("file is not executable");
        return;
      }
      // Argv array only: the path is never joined into a shell string.
      proc = Gio.Subprocess.new([path], Gio.SubprocessFlags.NONE);
    } catch (e) {
      fail(e.message ?? "cannot start");
      return;
    }
    this._scriptProcs.add(proc);
    proc.wait_async(null, (p, res) => {
      this._scriptProcs.delete(p);
      try {
        p.wait_finish(res);
        if (!p.get_successful()) fail("exited with an error");
      } catch (e) {
        fail(e.message ?? "wait failed");
      }
    });
  }

  _qaActivate(id) {
    this._hideTooltip();
    if (id === "dnd") this._toggleDnd();
    else if (id === "timer")
      this._setTab(this._page === "timer" ? "main" : "timer");
    else if (id === "clipboard")
      this._setTab(this._page === "clipboard" ? "main" : "clipboard");
    else if (id === "today") {
      this._setTab("main");
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

  _tabIcon(id, defIcon) {
    const name = this._strSetting(`tab-icon-${id}`, defIcon);
    return ICON_NAME_RE.test(name) ? name : defIcon;
  }

  _applyTabIcons() {
    for (const [id, parts] of this._tabParts ?? []) {
      const def = TAB_DEFS.find((d) => d[0] === id);
      if (def) parts.icon.icon_name = this._tabIcon(id, def[2]);
    }
  }

  _setTab(name) {
    this._showPage(name);
    for (const [id, b] of this._tabButtons ?? []) {
      if (id === name) {
        b.add_style_class_name("dn-tab-active");
        b.set_style(`background-color: ${this._accentWithAlpha(0.32)};`);
      } else {
        b.remove_style_class_name("dn-tab-active");
        b.set_style("");
      }
    }
    // Switching tabs resizes the open panel to the tab's own size.
    if (this._state === State.EXPANDED || this._state === State.EXPANDING)
      this._applySize(true);
    this._syncQaStates();
    // The ports view is a live scan: refresh on entry, then
    // every few seconds while it stays open.
    if (name === "ports") {
      this._refreshPortsList();
      if (!this._portsTimerId) {
        this._portsTimerId = GLib.timeout_add(
          GLib.PRIORITY_DEFAULT,
          4000,
          () => {
            if (this._page === "ports" && this._state === State.EXPANDED) {
              this._refreshPortsList();
              return GLib.SOURCE_CONTINUE;
            }
            this._portsTimerId = 0;
            return GLib.SOURCE_REMOVE;
          },
        );
      }
    }
  }

  _showPage(name) {
    const prev = this._page;
    this._page = name;
    const pages = {
      main: this._pageMain,
      timer: this._pageTimer,
      clipboard: this._pageClipboard,
      media: this._pageMedia,
      ports: this._pagePorts,
    };
    const incoming = pages[name];
    const outgoing = prev && prev !== name ? pages[prev] : null;
    // Crossfade only while fully open; during the expand morph
    // the whole-view fade covers the swap.
    const animate =
      !!incoming &&
      !!outgoing &&
      this._state === State.EXPANDED &&
      this._animationsEnabled();
    for (const [id, page] of Object.entries(pages)) {
      if (!page) continue;
      if (id === name) {
        page.visible = true;
        if (!animate) {
          page.remove_all_transitions();
          page.opacity = 255;
          page.translation_y = 0;
          page.scale_x = 1;
          page.scale_y = 1;
        }
      } else if (page !== outgoing || !animate) {
        page.remove_all_transitions();
        page.visible = false;
        page.opacity = 255;
      }
    }
    if (animate) {
      outgoing.remove_all_transitions();
      outgoing.ease({
        opacity: 0,
        duration: 120,
        mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        onComplete: () => {
          if (this._page !== prev) {
            outgoing.visible = false;
            outgoing.opacity = 255;
          }
        },
      });
      this._animateContentIn(incoming, 8, 220);
    }
    this._hideTooltip();
    this._syncQaStates();
    this._syncEqTimer();
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
      dndBtn.style_class =
        "dn-qa-button" + (active ? " dn-qa-active dn-qa-dnd-on" : "");
      // State reads from the icon alone: prohibition disc
      // while off, slashed bell while Do Not Disturb is on.
      if (dndBtn.child)
        dndBtn.child.icon_name = active
          ? "notifications-disabled-symbolic"
          : "user-busy-symbolic";
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
    for (const { tab, button } of this._tabEntryBtns ?? []) {
      button.style_class =
        "dn-qa-button" + (this._page === tab ? " dn-qa-active" : "");
    }
  }

  // ------------------------------------------------------------ tooltip

  _addTooltip(actor, text) {
    const enterId = actor.connect("enter-event", () =>
      this._showTooltip(actor, text),
    );
    const leaveId = actor.connect("leave-event", () => this._hideTooltip());
    if (!this._actorSignalIds) this._actorSignalIds = new Map();
    const ids = this._actorSignalIds.get(actor) ?? [];
    ids.push(enterId, leaveId);
    this._actorSignalIds.set(actor, ids);
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
      this._startScopeTracking();
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

  // Windowless apps that AppSystem drops (Steam closed to the
  // background) stay alive in their systemd app scope — track those.
  _startScopeTracking() {
    try {
      const bus = Gio.DBus.session;
      bus.call(
        "org.freedesktop.systemd1",
        "/org/freedesktop/systemd1",
        "org.freedesktop.systemd1.Manager",
        "Subscribe",
        null,
        null,
        Gio.DBusCallFlags.NONE,
        -1,
        null,
        (conn, res) => {
          try {
            conn.call_finish(res);
          } catch (e) {
            logError(e, "dynamic-notch: systemd subscribe failed");
          }
        },
      );
      const onUnit = (_c, _s, _p, _i, _m, params) => {
        const [id] = params.deepUnpack();
        if (id?.startsWith("app-") && id.endsWith(".scope"))
          this._refreshScopes();
      };
      this._sdUnitNewId = bus.signal_subscribe(
        null,
        "org.freedesktop.systemd1.Manager",
        "UnitNew",
        "/org/freedesktop/systemd1",
        null,
        Gio.DBusSignalFlags.NONE,
        onUnit,
      );
      this._sdUnitRemovedId = bus.signal_subscribe(
        null,
        "org.freedesktop.systemd1.Manager",
        "UnitRemoved",
        "/org/freedesktop/systemd1",
        null,
        Gio.DBusSignalFlags.NONE,
        onUnit,
      );
      this._refreshScopes();
    } catch (e) {
      logError(e, "dynamic-notch: scope tracking unavailable");
    }
  }

  _refreshScopes() {
    Gio.DBus.session.call(
      "org.freedesktop.systemd1",
      "/org/freedesktop/systemd1",
      "org.freedesktop.systemd1.Manager",
      "ListUnits",
      null,
      new GLib.VariantType("(a(sssssouso))"),
      Gio.DBusCallFlags.NONE,
      -1,
      null,
      (conn, res) => {
        try {
          const out = conn.call_finish(res);
          const found = new Map();
          const list = out.get_child_value(0);
          for (let i = 0; i < list.n_children(); i++) {
            const unit = list.get_child_value(i);
            const name = unit.get_child_value(0).get_string()[0];
            const active = unit.get_child_value(3).get_string()[0];
            if (
              active !== "active" ||
              !name.startsWith("app-") ||
              !name.endsWith(".scope")
            )
              continue;
            const appId = this._desktopIdFromScope(name);
            if (!appId) continue;
            if (!found.has(appId)) found.set(appId, []);
            found.get(appId).push(name);
          }
          this._scopeApps = found;
          this._scheduleAppsRefresh();
        } catch (e) {
          logError(e, "dynamic-notch: listing systemd units failed");
        }
      },
    );
  }

  _desktopIdFromScope(unit) {
    // app[-<launcher>]-<ApplicationID>-<random>.scope (the systemd
    // desktop convention); dashes in the ID are escaped as \x2d.
    if (!this._appSystem) return null;
    const m = unit.match(/^app-(.+)-\d+\.scope$/);
    if (!m) return null;
    const rest = m[1].replace(/\\x2d/g, "-");
    const candidates = [];
    const dash = rest.indexOf("-");
    if (dash > 0) candidates.push(rest.slice(dash + 1));
    candidates.push(rest);
    for (const cand of candidates) {
      const app =
        this._appSystem.lookup_app(`${cand}.desktop`) ??
        this._appSystem.lookup_app(cand);
      // Only real user apps: should_show() hides session helpers
      // (SettingsDaemon autostart entries have scopes too).
      if (app?.get_app_info()?.should_show()) return app.get_id();
    }
    return null;
  }

  _refreshApps() {
    if (!this._appsRow) return;
    // Sources, deduped by app id: AppSystem's running list, the
    // window actors, and systemd app scopes (background apps).
    const byId = new Map();
    if (this._appSystem) {
      try {
        for (const app of this._appSystem.get_running()) {
          if (
            app.get_windows().length > 0 ||
            app.get_state() === Shell.AppState.RUNNING
          )
            byId.set(app.get_id(), app);
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
    // Scope-only apps: alive in systemd but windowless and gone
    // from AppSystem (Steam & co. after their window closes).
    this._appUnits = new Map();
    for (const [appId, units] of this._scopeApps ?? []) {
      if (byId.has(appId) || !this._appSystem) continue;
      const app = this._appSystem.lookup_app(appId);
      if (app && app.get_windows().length === 0) {
        byId.set(appId, app);
        this._appUnits.set(appId, units);
      }
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

  // Crash-safe display name: get_name() on a window-backed app
  // asserts once its last window is gone (the v34 Shell abort).
  _appDisplayName(app) {
    try {
      if (app.get_app_info()) return app.get_name() || "Application";
    } catch (_e) {}
    const win = app.get_windows()[0];
    return win?.get_wm_class() || win?.get_title() || "Application";
  }

  _makeAppEntry(app) {
    const name = this._appDisplayName(app);
    const background = app.get_windows().length === 0;
    const wrap = new St.Widget({
      layout_manager: new Clutter.BinLayout(),
      opacity: background ? 170 : 255,
    });
    const btn = new St.Button({
      style_class: "dn-app-button",
      accessible_name: name,
      x_expand: true,
      y_expand: true,
    });
    let iconActor = null;
    try {
      // The app's own icon, resolved by the Shell (never a bundled file).
      iconActor = app.create_icon_texture(36);
    } catch (_e) {}
    if (!iconActor) {
      iconActor = new St.Icon({
        icon_name: "application-x-executable-symbolic",
        icon_size: 36,
      });
    }
    btn.child = iconActor;
    btn.connect("clicked", () => {
      try {
        app.activate();
      } catch (e) {
        logError(e, "dynamic-notch: app activation failed");
      }
    });
    this._addTooltip(btn, background ? `${name} (background)` : name);
    wrap.add_child(btn);
    // Always-visible red close button on the icon's bottom-right
    // corner, nudged outward so it covers less of the icon.
    const badge = new St.Button({
      style_class: "dn-app-badge",
      accessible_name: `Close ${name}`,
      child: new St.Icon({
        icon_name: "window-close-symbolic",
        icon_size: 14,
      }),
      x_align: Clutter.ActorAlign.END,
      y_align: Clutter.ActorAlign.END,
    });
    badge.translation_x = 9;
    badge.translation_y = 11;
    badge.connect("clicked", () => this._closeOrKillApp(app));
    wrap.add_child(badge);
    return wrap;
  }

  _closeOrKillApp(app) {
    const pid = this._appPid(app);
    if (pid > 1) {
      this._killApp(app, pid);
      return;
    }
    if (app.get_windows().length > 0) {
      this._closeApp(app);
      return;
    }
    // Background app: quit over D-Bus, else stop its systemd
    // scope, else resolve the PID from its bus name and kill it.
    let quit = false;
    try {
      quit = app.request_quit();
    } catch (_e) {}
    if (!quit && !this._stopAppScope(app)) this._killBackgroundApp(app);
  }

  _stopAppScope(app) {
    const units =
      this._appUnits?.get(app.get_id()) ?? this._scopeApps?.get(app.get_id());
    if (!units?.length) return false;
    for (const unit of units) {
      Gio.DBus.session.call(
        "org.freedesktop.systemd1",
        "/org/freedesktop/systemd1",
        "org.freedesktop.systemd1.Manager",
        "StopUnit",
        new GLib.Variant("(ss)", [unit, "replace"]),
        null,
        Gio.DBusCallFlags.NONE,
        -1,
        null,
        (conn, res) => {
          try {
            conn.call_finish(res);
          } catch (e) {
            logError(e, "dynamic-notch: stopping app scope failed");
          }
          this._scheduleAppsRefresh();
        },
      );
    }
    return true;
  }

  _killBackgroundApp(app) {
    if (!app.get_app_info()) return; // no desktop id → no bus name to resolve a PID from
    const busName = app.get_id().replace(/\.desktop$/, "");
    Gio.DBus.session.call(
      "org.freedesktop.DBus",
      "/org/freedesktop/DBus",
      "org.freedesktop.DBus",
      "GetConnectionUnixProcessID",
      new GLib.Variant("(s)", [busName]),
      null,
      Gio.DBusCallFlags.NONE,
      -1,
      null,
      (conn, res) => {
        try {
          const pid = conn.call_finish(res).get_child_value(0).get_uint32();
          if (pid > 1) this._killApp(app, pid);
        } catch (e) {
          logError(e, "dynamic-notch: background app PID lookup failed");
        }
      },
    );
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
    if (app.get_id() === "org.gnome.Shell.desktop" || pid <= 1) {
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
      column_spacing: 1,
      row_spacing: 1,
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
    this._clearClickedId = this._clearButton.connect("clicked", () => {
      try {
        this._notifProvider?.clearAll();
      } catch (e) {
        logError(e, "dynamic-notch: clear notifications failed");
      }
    });
    header.add_child(this._clearButton);
    const notifClose = new St.Button({
      style_class: "dn-qa-button dn-close-btn",
      child: new St.Icon({
        icon_name: "window-close-symbolic",
        icon_size: 16,
      }),
      accessible_name: "Close panel",
      y_align: Clutter.ActorAlign.CENTER,
    });
    notifClose.connect("clicked", () => this._requestClose());
    header.add_child(notifClose);
    this._addTooltip(notifClose, "Close panel");
    box.add_child(header);

    this._notifEmpty = new St.Label({
      text: "No notifications",
      style_class: "dn-card-body",
    });
    box.add_child(this._notifEmpty);

    // The list scrolls inside its own viewport: however many
    // notifications pile up, the apps strip below stays put.
    this._notifList = new St.BoxLayout({
      style_class: "dn-notif-list",
      orientation: Clutter.Orientation.VERTICAL,
    });
    this._notifScroll = new St.ScrollView({
      style_class: "dn-notif-scroll",
      hscrollbar_policy: St.PolicyType.NEVER,
      vscrollbar_policy: St.PolicyType.AUTOMATIC,
      overlay_scrollbars: true,
      y_expand: true,
    });
    this._notifScroll.add_child(this._notifList);
    box.add_child(this._notifScroll);
    return box;
  }

  // --- Tab 3: clipboard history ---
  _buildClipboardPage() {
    const page = new St.BoxLayout({
      style_class: "dn-page-clipboard",
      orientation: Clutter.Orientation.VERTICAL,
      y_expand: true,
      visible: false,
    });
    const header = new St.BoxLayout({ style_class: "dn-notif-header" });
    header.add_child(
      new St.Icon({
        icon_name: "edit-paste-symbolic",
        icon_size: 16,
        y_align: Clutter.ActorAlign.CENTER,
      }),
    );
    header.add_child(
      new St.Label({
        text: "Clipboard History",
        style_class: "dn-card-title",
        y_align: Clutter.ActorAlign.CENTER,
      }),
    );
    header.add_child(new St.Widget({ x_expand: true }));
    this._clipClearButton = new St.Button({
      label: "Clear history",
      style_class: "dn-small-button",
    });
    this._clipClearButton.connect("clicked", () => {
      try {
        this._clipProvider?.clear();
      } catch (e) {
        logError(e, "dynamic-notch: clear clipboard history failed");
      }
    });
    header.add_child(this._clipClearButton);
    page.add_child(header);
    this._clipEmpty = new St.Label({
      text: "Nothing copied yet",
      style_class: "dn-card-body",
    });
    page.add_child(this._clipEmpty);
    this._clipList = new St.BoxLayout({
      style_class: "dn-notif-list",
      orientation: Clutter.Orientation.VERTICAL,
    });
    const scroll = new St.ScrollView({
      style_class: "dn-notif-scroll",
      hscrollbar_policy: St.PolicyType.NEVER,
      vscrollbar_policy: St.PolicyType.AUTOMATIC,
      overlay_scrollbars: true,
      y_expand: true,
    });
    scroll.add_child(this._clipList);
    this._clipScroll = scroll;
    page.add_child(scroll);
    return page;
  }

  _buildPortsPage() {
    const page = new St.BoxLayout({
      style_class: "dn-page-ports",
      orientation: Clutter.Orientation.VERTICAL,
      y_expand: true,
      visible: false,
    });
    const header = new St.BoxLayout({ style_class: "dn-notif-header" });
    header.add_child(
      new St.Icon({
        icon_name: "network-server-symbolic",
        icon_size: 16,
        y_align: Clutter.ActorAlign.CENTER,
      }),
    );
    header.add_child(
      new St.Label({
        text: "Listening Ports",
        style_class: "dn-card-title",
        y_align: Clutter.ActorAlign.CENTER,
      }),
    );
    this._portsCount = new St.Label({
      text: "",
      style_class: "dn-card-body",
      y_align: Clutter.ActorAlign.CENTER,
    });
    header.add_child(this._portsCount);
    header.add_child(new St.Widget({ x_expand: true }));
    const refreshBtn = new St.Button({
      label: "Refresh",
      style_class: "dn-small-button",
    });
    refreshBtn.connect("clicked", () => this._refreshPortsList());
    header.add_child(refreshBtn);
    page.add_child(header);
    this._portsEmpty = new St.Label({
      text: "No listening ports",
      style_class: "dn-card-body",
    });
    page.add_child(this._portsEmpty);
    this._portsList = new St.BoxLayout({
      style_class: "dn-notif-list",
      orientation: Clutter.Orientation.VERTICAL,
    });
    const scroll = new St.ScrollView({
      style_class: "dn-notif-scroll",
      hscrollbar_policy: St.PolicyType.NEVER,
      vscrollbar_policy: St.PolicyType.AUTOMATIC,
      overlay_scrollbars: true,
      y_expand: true,
    });
    scroll.add_child(this._portsList);
    page.add_child(scroll);
    return page;
  }

  // Rows are keyed by proto|addr|port and updated in place;
  // a full rebuild on every refresh made the list blink.
  _refreshPortsList() {
    if (!this._portsList) return;
    let rows = [];
    try {
      rows = scanListeningPorts();
    } catch (e) {
      logError(e, "dynamic-notch: port scan failed");
    }
    this._portsEmpty.visible = rows.length === 0;
    const countText = rows.length ? `· ${rows.length} open` : "";
    if (this._portsCount && this._portsCount.text !== countText)
      this._portsCount.text = countText;
    const stale = new Map();
    for (const child of this._portsList.get_children())
      stale.set(child._portKey, child);
    rows.forEach((r, i) => {
      const key = `${r.proto}|${r.addr}|${r.port}`;
      let row = stale.get(key);
      if (row) {
        stale.delete(key);
        if (row._procText !== (r.process || "")) {
          row._procLabel.text = r.process || "—";
          row._procText = r.process || "";
        }
      } else {
        row = this._makePortRow(r);
      }
      if (this._portsList.get_child_at_index(i) !== row) {
        if (row.get_parent()) this._portsList.remove_child(row);
        this._portsList.insert_child_at_index(row, i);
      }
    });
    for (const row of stale.values()) row.destroy();
  }

  _makePortRow(r) {
    const row = new St.BoxLayout({ style_class: "dn-port-row" });
    row.add_child(
      new St.Label({
        text: `${r.port}`,
        style_class: "dn-port-num",
        y_align: Clutter.ActorAlign.CENTER,
      }),
    );
    row.add_child(
      new St.Label({
        text: r.proto,
        style_class: "dn-port-proto",
        y_align: Clutter.ActorAlign.CENTER,
      }),
    );
    const addr = new St.Label({
      text: r.v6 ? `[${r.addr}]` : r.addr,
      style_class: "dn-port-addr",
      x_expand: true,
      y_align: Clutter.ActorAlign.CENTER,
    });
    addr.get_clutter_text().set_ellipsize(Pango.EllipsizeMode.END);
    row.add_child(addr);
    const proc = new St.Label({
      text: r.process || "—",
      style_class: "dn-port-proc",
      y_align: Clutter.ActorAlign.CENTER,
    });
    proc.get_clutter_text().set_ellipsize(Pango.EllipsizeMode.END);
    row.add_child(proc);
    row._portKey = `${r.proto}|${r.addr}|${r.port}`;
    row._procLabel = proc;
    row._procText = r.process || "";
    return row;
  }

  _refreshClipList() {
    if (!this._clipList) return;
    this._clipList.destroy_all_children();
    const items = this._clipProvider?.getAll() ?? [];
    this._clipEmpty.visible = items.length === 0;
    if (this._clipClearButton) {
      this._clipClearButton.reactive = items.length > 0;
      this._clipClearButton.opacity = items.length > 0 ? 255 : 120;
    }
    for (const item of items)
      this._clipList.add_child(this._makeClipItem(item));
  }

  _makeClipItem(item) {
    const button = new St.Button({
      style_class: "dn-notif-item",
      x_expand: true,
    });
    button.x_align = Clutter.ActorAlign.FILL;
    const texts = new St.BoxLayout({
      orientation: Clutter.Orientation.VERTICAL,
      style_class: "dn-notif-texts",
      x_expand: true,
    });
    // One-line preview: whitespace collapses, long text ellipsizes.
    const preview = new St.Label({
      text: item.text.replace(/\s+/g, " ").trim(),
      style_class: "dn-notif-item-title",
    });
    preview.get_clutter_text().set_ellipsize(Pango.EllipsizeMode.END);
    texts.add_child(preview);
    texts.add_child(
      new St.Label({
        text:
          `${this._fmtTimeJS(new Date(item.time))} · ` +
          `${item.text.length} chars`,
        style_class: "dn-notif-item-sub",
      }),
    );
    button.child = texts;
    button.connect("clicked", () => {
      try {
        this._clipProvider?.restore(item);
      } catch (e) {
        logError(e, "dynamic-notch: clipboard restore failed");
      }
    });
    this._addTooltip(button, "Copy back to clipboard");
    return button;
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
      x_expand: true,
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
        y_align: Clutter.ActorAlign.CENTER,
      });
      entry.set_height(24);
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
    this._btnPlayPause = new St.Button({
      style_class: "dn-timer-button",
      y_align: Clutter.ActorAlign.CENTER,
    });
    this._btnPlayPause.set_height(24);
    const ppBox = new St.BoxLayout({ style_class: "dn-qa-content" });
    this._playPauseIcon = new St.Icon({
      icon_name: "media-playback-start-symbolic",
      icon_size: 12,
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
    this._playPauseClickedId = this._btnPlayPause.connect("clicked", () =>
      this._timerPlayPause(),
    );
    controls.add_child(this._btnPlayPause);
    this._btnReset = new St.Button({
      label: "Reset",
      style_class: "dn-timer-button",
      y_align: Clutter.ActorAlign.CENTER,
    });
    this._btnReset.set_height(24);
    this._resetClickedId = this._btnReset.connect("clicked", () =>
      this._timerReset(),
    );
    controls.add_child(this._btnReset);
    durRow.add_child(controls);
    left.add_child(durRow);
    strip.add_child(left);

    this._timerRing = new St.DrawingArea({
      width: 56,
      height: 56,
      y_align: Clutter.ActorAlign.CENTER,
    });
    this._timerRing.connect("repaint", () => this._drawTimerRing());
    strip.add_child(this._timerRing);

    this._timerLabel = new St.Label({
      style_class: "dn-timer-count",
      x_expand: true,
      x_align: Clutter.ActorAlign.END,
      y_align: Clutter.ActorAlign.CENTER,
    });
    strip.add_child(this._timerLabel);
    const timerClose = new St.Button({
      style_class: "dn-qa-button dn-close-btn",
      child: new St.Icon({
        icon_name: "window-close-symbolic",
        icon_size: 16,
      }),
      accessible_name: "Close timer view",
      y_align: Clutter.ActorAlign.CENTER,
    });
    // Closes only the view — the timer itself keeps running.
    timerClose.connect("clicked", () => this._requestClose());
    strip.add_child(timerClose);
    this._addTooltip(timerClose, "Close (timer keeps running)");
    this._syncDurationEntries();
    return strip;
  }

  // Tabular figures: every digit the same width, so HH:MM never
  // changes width across minute changes and the pill's measured
  // length stays constant. Guarded: older Pango bindings may
  // not expose the font-features attribute.
  _applyTabular(label) {
    try {
      if (typeof Pango.attr_font_features_new !== "function") return;
      const attrs = new Pango.AttrList();
      attrs.insert(Pango.attr_font_features_new("tnum"));
      label.get_clutter_text().set_attributes(attrs);
    } catch (_e) {}
  }

  _updateClock() {
    if (!this._clockTime) return;
    const now = GLib.DateTime.new_now_local();
    const stamp = formatDateTime(now);
    this._clockTime.text = stamp;
    this._expandedClock.text = stamp;
    this._expandedDate.text = now.format("%A");
    // The collapsed pill sizes to this text; re-measure only
    // when the stamp actually changes, i.e. once a minute.
    // Snap, never ease: the correction is a few px of digit
    // width, and gliding it over ANIM_MS reads as a blink.
    if (stamp !== this._lastStamp) {
      this._lastStamp = stamp;
      if (this._state === State.COMPACT && !this._peekActive)
        this._applySize(false);
    }

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

    // The music progress bar rides this 1s tick while open.
    if (this._state === State.EXPANDED && this._page === "media")
      this._renderMusicProgress();
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
    const clockWasVisible = this._clockWidget.visible;
    this._syncViews();
    if (clockWasVisible) this._fadeClockOut();
    this._setTab("main");
    this._renderCalendar();
    this._refreshNotifList();
    this._refreshApps();
    this._expandedView.remove_all_transitions();
    if (this._animationsEnabled())
      this._animateContentIn(this._expandedView, 10, ANIM_MS);
    else this._expandedView.opacity = 255;
    this._animOnDone = () => {
      if (gen !== this._animGen) return;
      this._state = State.EXPANDED;
      this._syncViews();
    };
    this._applySize(true);
    this._installOutsideHandlers();
  }

  // The one close entry: every × button calls exactly what an
  // outside click calls, so close always minimizes the same way.
  _requestClose() {
    if (this._state === State.EXPANDED || this._state === State.EXPANDING) {
      this._closePanel();
      return;
    }
    if (this._peekActive) this._dismissPeek();
  }

  _closePanel() {
    if (this._state === State.COMPACT || this._state === State.COLLAPSING)
      return;
    this._state = State.COLLAPSING;
    const gen = ++this._animGen;

    this._hideTooltip();
    // Outside handlers are only needed while fully open / opening.
    this._removeOutsideHandlers();
    this._fadeClockIn();

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
          this._closePanel();
        },
      });
    } catch (e) {
      logError(e, "dynamic-notch: GrabHelper unavailable");
      this._grabbed = false;
    }

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

  // GSettings string read that tolerates a stale installed schema.
  _strSetting(key, fallback) {
    try {
      if (this._settings?.settings_schema?.has_key(key))
        return this._settings.get_string(key);
    } catch (_e) {}
    return fallback;
  }

  _animStyle() {
    return this._strSetting("animation-style", "default");
  }

  // Size transitions spring only in the spring style; other styles
  // keep the stock cubic and differ in the content animation.
  _easeMode() {
    return this._animStyle() === "spring"
      ? Clutter.AnimationMode.EASE_OUT_BACK
      : Clutter.AnimationMode.EASE_OUT_CUBIC;
  }

  _animationsEnabled() {
    const system =
      this._ifaceSettings?.get_boolean("enable-animations") ?? true;
    return system && this._animStyle() !== "none";
  }

  // Content entrance per animation style, used on expand and on
  // tab switches: every style fades (the smooth base, spanning
  // the caller's duration); slide/scale/spring add motion.
  _animateContentIn(actor, shift = 10, duration = 0) {
    if (!actor || !this._animationsEnabled()) return;
    const style = this._animStyle();
    if (style === "none") return;
    actor.remove_all_transitions();
    actor.set_pivot_point(0.5, 0);
    if (style === "slide") {
      actor.translation_y = shift;
      actor.opacity = 0;
      actor.ease({
        translation_y: 0,
        opacity: 255,
        duration: duration || 200,
        mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
      });
    } else if (style === "scale") {
      actor.scale_x = 0.97;
      actor.scale_y = 0.97;
      actor.opacity = 0;
      actor.ease({
        scale_x: 1,
        scale_y: 1,
        opacity: 255,
        duration: duration || 200,
        mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
      });
    } else if (style === "spring") {
      actor.translation_y = shift + 2;
      actor.opacity = 0;
      actor.ease({
        translation_y: 0,
        opacity: 255,
        duration: duration || 280,
        mode: Clutter.AnimationMode.EASE_OUT_BACK,
      });
    } else {
      actor.opacity = 0;
      actor.ease({
        opacity: 255,
        duration: duration || 200,
        mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
      });
    }
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

  // Natural length of the compact content: the visible children's
  // requisitions + CSS spacing 8px and horizontal padding 24px.
  _compactContentLength() {
    if (!this._clockWidget) return 0;
    const vertical =
      this._clockWidget.orientation === Clutter.Orientation.VERTICAL;
    let total = 0,
      count = 0;
    for (const child of this._clockWidget.get_children()) {
      if (!child.visible) continue;
      const [, nat] = vertical
        ? child.get_preferred_height(-1)
        : child.get_preferred_width(-1);
      total += nat;
      count++;
    }
    if (count === 0) return 0;
    return total + 8 * (count - 1) + (vertical ? 0 : 24);
  }

  _expandedDims(monitor) {
    if (this._page === "timer") return this._timerTabDims(monitor);
    if (this._page === "media") return this._mediaTabDims(monitor);
    return [
      Math.min(EXPANDED_W, Math.max(320, monitor.width - 16)),
      Math.min(EXPANDED_H, Math.max(240, monitor.height - 16)),
    ];
  }

  // The media tab sizes itself like the timer tab does.
  _mediaTabDims(monitor) {
    let w = 500,
      contentH = 130;
    if (this._pageMedia) {
      const [, natW] = this._pageMedia.get_preferred_width(-1);
      const [, natH] = this._pageMedia.get_preferred_height(-1);
      if (natW > 100) w = Math.min(620, Math.max(500, natW + 24));
      if (natH > 20) contentH = natH;
    }
    let topH = 40;
    if (this._topBar) {
      const [, natTop] = this._topBar.get_preferred_height(-1);
      if (natTop > 10) topH = natTop;
    }
    const h = contentH + topH + 24 + 8;
    return [
      Math.min(w, Math.max(340, monitor.width - 16)),
      Math.min(h, Math.max(150, monitor.height - 16)),
    ];
  }

  // The timer tab sizes itself: natural size of the timer content
  // plus the top bar and the expanded root's padding (12px/side).
  _timerTabDims(monitor) {
    let w = 480,
      contentH = 96;
    if (this._pageTimer) {
      const [, natW] = this._pageTimer.get_preferred_width(-1);
      const [, natH] = this._pageTimer.get_preferred_height(-1);
      if (natW > 100) w = natW + 24;
      if (natH > 20) contentH = natH;
    }
    let topH = 40;
    if (this._topBar) {
      const [, natTop] = this._topBar.get_preferred_height(-1);
      if (natTop > 10) topH = natTop;
    }
    const h = contentH + topH + 24 + 8;
    return [
      Math.min(w, Math.max(340, monitor.width - 16)),
      Math.min(h, Math.max(150, monitor.height - 16)),
    ];
  }

  _peekDims(monitor) {
    return [Math.min(PEEK_W, Math.max(280, monitor.width - 16)), PEEK_H];
  }

  _eventDims(monitor) {
    // Events share the notification peek's exact size, so every
    // transient surface (messages, system, music) is identical.
    return this._peekDims(monitor);
  }

  // Anchor for the wide modes (expanded / peek): same edge the pill
  // lives on, never swapped — the content is always landscape.
  _anchorFor(style, position, monitor, W, H) {
    let x, y;
    if (style === 0 || position === 0) {
      x = Math.round(monitor.x + (monitor.width - W) / 2);
      y = style === 0 ? monitor.y : monitor.y + 6;
    } else if (position === 1) {
      x = Math.round(monitor.x + (monitor.width - W) / 2);
      y = monitor.y + monitor.height - H - 6;
    } else if (position === 2) {
      x = monitor.x + 6;
      y = Math.round(monitor.y + (monitor.height - H) / 2);
    } else {
      x = monitor.x + monitor.width - W - 6;
      y = Math.round(monitor.y + (monitor.height - H) / 2);
    }
    // notch-margin-top: extra vertical offset; negative pushes the
    // notch past its screen edge, positive moves it inward/down.
    const margin = this._settings.get_int("notch-margin-top");
    y += position === 1 ? -margin : margin;
    return [x, y];
  }

  _syncViews() {
    if (!this._clockWidget) return;
    const open =
      this._state === State.EXPANDING ||
      this._state === State.EXPANDED ||
      this._state === State.COLLAPSING;
    this._expandedView.visible = open;
    this._peekView.visible = !open && this._peekActive;
    this._eventView.visible = !open && !this._peekActive && this._eventActive;
    this._clockWidget.visible =
      !open && !this._peekActive && !this._eventActive;
  }

  // The compact clock crossfades with the panel morph instead of
  // popping in and out at the state flips.
  _fadeClockOut() {
    const clock = this._clockWidget;
    if (!clock) return;
    clock.remove_all_transitions();
    if (!this._animationsEnabled()) {
      clock.visible = false;
      return;
    }
    clock.visible = true;
    clock.ease({
      opacity: 0,
      duration: 140,
      mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
      onComplete: () => {
        if (this._state === State.EXPANDING || this._state === State.EXPANDED) {
          clock.visible = false;
          clock.opacity = 255;
        }
      },
    });
  }

  _fadeClockIn() {
    const clock = this._clockWidget;
    if (!clock || this._peekActive || this._eventActive) return;
    clock.remove_all_transitions();
    clock.visible = true;
    if (!this._animationsEnabled()) {
      clock.opacity = 255;
      return;
    }
    clock.opacity = 0;
    clock.ease({
      opacity: 255,
      duration: Math.round(ANIM_MS * 0.7),
      mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
    });
  }

  // The layout manager tracks fullscreen per monitor; read it at
  // the point of decision so no cached flag can go stale.
  _primaryInFullscreen() {
    try {
      return Main.layoutManager.primaryMonitor?.inFullscreen === true;
    } catch (_e) {
      return false;
    }
  }

  _applySize(animate = true) {
    const monitor = Main.layoutManager.primaryMonitor;
    if (!monitor || !this._notch) return;

    const style = this._settings.get_enum("notch-style");
    // Style 2 (apple-plain) shares Apple's geometry exactly;
    // only the fillet check below uses the raw style value.
    const styleKey = style === 2 ? 0 : style;
    const position = this._settings.get_enum("pill-position");
    const w = this._settings.get_int("notch-width");
    const h = this._settings.get_int("notch-height");
    const expanded = this._targetExpanded();
    const peek = !expanded && this._peekActive && this._state === State.COMPACT;
    const evt =
      !expanded && !peek && this._eventActive && this._state === State.COMPACT;

    // Collapsed pill (not apple): configured width, raised to
    // the children's natural size when the content needs more.
    let dynLen = 0;
    if (!expanded && !peek && styleKey !== 0 && this._clockWidget) {
      const vertical = position === 2 || position === 3;
      this._clockWidget.orientation = vertical
        ? Clutter.Orientation.VERTICAL
        : Clutter.Orientation.HORIZONTAL;
      const nat = this._compactContentLength();
      if (nat > 0)
        dynLen = Math.min(Math.max(nat + 16, w, 120), monitor.width - 16);
    }

    let x, y, notchW, notchH;

    if (expanded) {
      [notchW, notchH] = this._expandedDims(monitor);
      [x, y] = this._anchorFor(styleKey, position, monitor, notchW, notchH);
      this._clockWidget.orientation = Clutter.Orientation.HORIZONTAL;
    } else if (peek) {
      [notchW, notchH] = this._peekDims(monitor);
      [x, y] = this._anchorFor(styleKey, position, monitor, notchW, notchH);
      this._clockWidget.orientation = Clutter.Orientation.HORIZONTAL;
    } else if (evt) {
      [notchW, notchH] = this._eventDims(monitor);
      [x, y] = this._anchorFor(styleKey, position, monitor, notchW, notchH);
      this._clockWidget.orientation = Clutter.Orientation.HORIZONTAL;
    } else {
      // Compact: size first, then position from the FINAL
      // size via the shared _anchorFor — always center-true.
      this._clockWidget.orientation =
        styleKey !== 0 && (position === 2 || position === 3)
          ? Clutter.Orientation.VERTICAL
          : Clutter.Orientation.HORIZONTAL;
      if (styleKey === 0) {
        notchW = w;
        notchH = h;
      } else if (position === 2 || position === 3) {
        notchW = h;
        notchH = dynLen > 0 ? dynLen : w;
      } else {
        notchW = dynLen > 0 ? dynLen : w;
        notchH = h;
      }
      // Live content (timer / notification count) may need
      // more room than the configured size, in any style.
      if (this._timerState !== "idle" || this._notifChip?.visible) {
        const nat = this._compactContentLength();
        if (nat > 0) {
          const verticalLen =
            this._clockWidget.orientation === Clutter.Orientation.VERTICAL;
          if (verticalLen)
            notchH = Math.max(notchH, Math.min(nat + 8, monitor.height - 16));
          else notchW = Math.max(notchW, Math.min(nat + 8, monitor.width - 16));
        }
      }
      [x, y] = this._anchorFor(styleKey, position, monitor, notchW, notchH);
    }

    // Pre-size every view to its final geometry, so layout stays frozen mid-animation.
    const [expW, expH] = this._expandedDims(monitor);
    this._expandedView.set_size(expW, expH);
    const [pkW, pkH] = this._peekDims(monitor);
    this._peekView.set_size(pkW, pkH);
    const [evW, evH] = this._eventDims(monitor);
    this._eventView.set_size(evW, evH);
    if (!expanded && !peek && !evt) this._clockWidget.set_size(notchW, notchH);

    // Fillets flare the Apple notch's TOP corners into the
    // screen's top edge (the junction in the reference). Never
    // force them visible while a fullscreen window owns the
    // monitor: this assignment runs on every size pass (the
    // clock re-measures once a minute), which used to resurrect
    // them over fullscreen apps.
    const showFillets = style === 0 && !this._primaryInFullscreen();
    for (const f of [this._filletL, this._filletR]) {
      if (f) f.visible = showFillets;
    }

    const onDone = this._animOnDone;
    const kind = expanded
      ? "expanded"
      : peek
        ? "peek"
        : evt
          ? "event"
          : "compact";
    const prevKind = this._morphKind ?? "compact";
    this._morphKind = kind;
    this._stopMorphSpring();
    // Morphs into/out of the peek/event surface ride the spring;
    // anything touching the expanded panel keeps the old ease.
    const springy =
      animate &&
      this._animationsEnabled() &&
      kind !== "expanded" &&
      prevKind !== "expanded" &&
      (kind === "peek" ||
        kind === "event" ||
        prevKind === "peek" ||
        prevKind === "event");
    if (springy) {
      this._runMorphSpring(x, y, notchW, notchH, showFillets, onDone);
    } else if (animate && this._animationsEnabled()) {
      // Kill any running ease first, so rapid toggling reverses instead of stacking.
      this._notch.remove_all_transitions();
      this._notch.ease({
        x,
        y,
        width: notchW,
        height: notchH,
        duration: ANIM_MS,
        mode: this._easeMode(),
        onComplete: () => onDone?.(),
      });
      for (const layer of [this._backdrop, this._clipper]) {
        layer.remove_all_transitions();
        layer.ease({
          width: notchW,
          height: notchH,
          duration: ANIM_MS,
          mode: this._easeMode(),
        });
      }
      if (showFillets) {
        this._filletL.ease({
          x: x - FILLET_R,
          y,
          duration: ANIM_MS,
          mode: this._easeMode(),
        });
        this._filletR.ease({
          x: x + notchW,
          y,
          duration: ANIM_MS,
          mode: this._easeMode(),
        });
      }
    } else {
      this._notch.remove_all_transitions();
      this._notch.set_position(x, y);
      this._notch.set_size(notchW, notchH);
      this._backdrop.set_size(notchW, notchH);
      this._clipper.set_size(notchW, notchH);
      if (showFillets) {
        this._filletL.set_position(x - FILLET_R, y);
        this._filletR.set_position(x + notchW, y);
      }
      onDone?.();
    }

    // Self-heal: in steady compact state the visible view must
    // match the flags; never leave a blank black box behind.
    if (this._state === State.COMPACT) this._syncViews();
  }

  _stopMorphSpring() {
    if (this._springSourceId) {
      GLib.source_remove(this._springSourceId);
      this._springSourceId = 0;
    }
  }

  _stopShake() {
    if (this._shakeSourceId) {
      GLib.source_remove(this._shakeSourceId);
      this._shakeSourceId = 0;
    }
  }

  // Peek/event morph on a real spring instead of a fixed easing.
  // Stepped from a GLib timer: a standalone Clutter.Timeline has
  // no frame clock without an actor and never advances (v77 bug).
  _runMorphSpring(x, y, w, h, showFillets, onDone) {
    const [sx, sy] = this._notch.get_position();
    const [sw, sh] = this._notch.get_size();
    this._notch.remove_all_transitions();
    for (const layer of [this._backdrop, this._clipper])
      layer.remove_all_transitions();
    if (
      Math.abs(sx - x) < 1 &&
      Math.abs(sy - y) < 1 &&
      Math.abs(sw - w) < 1 &&
      Math.abs(sh - h) < 1
    ) {
      onDone?.();
      return;
    }
    const startUs = GLib.get_monotonic_time();
    this._springSourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
      const t = (GLib.get_monotonic_time() - startUs) / 1e6;
      if (t * 1000 >= MORPH_SPRING_MS) {
        this._springSourceId = 0;
        this._notch.set_position(x, y);
        this._notch.set_size(w, h);
        this._backdrop.set_size(w, h);
        this._clipper.set_size(w, h);
        if (showFillets) {
          this._filletL.set_position(x - FILLET_R, y);
          this._filletR.set_position(x + w, y);
        }
        onDone?.();
        return GLib.SOURCE_REMOVE;
      }
      const f = _springPos(t, 340, 27, 1);
      const cw = sw + (w - sw) * f;
      const ch = sh + (h - sh) * f;
      const cx = sx + (x - sx) * f;
      const cy = sy + (y - sy) * f;
      this._notch.set_position(cx, cy);
      this._notch.set_size(cw, ch);
      this._backdrop.set_size(cw, ch);
      this._clipper.set_size(cw, ch);
      if (showFillets) {
        this._filletL.set_position(cx - FILLET_R, cy);
        this._filletR.set_position(cx + cw, cy);
      }
      return GLib.SOURCE_CONTINUE;
    });
  }

  // Small lateral shake when a peek/event lands: a kicked spring
  // (520/13, softened) on the notch's translation-x.
  _shakeNotch() {
    if (!this._animationsEnabled() || !this._notch) return;
    if (this._state !== State.COMPACT) return;
    this._stopShake();
    const startUs = GLib.get_monotonic_time();
    this._shakeSourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
      const t = (GLib.get_monotonic_time() - startUs) / 1e6;
      if (t >= 0.5) {
        this._shakeSourceId = 0;
        this._notch.set_translation(0, 0, 0);
        return GLib.SOURCE_REMOVE;
      }
      this._notch.set_translation(_shakePos(t), 0, 0);
      return GLib.SOURCE_CONTINUE;
    });
  }

  // One concave fillet: a notch-colored square with a quarter
  // disc cleared out, cairo-drawn on an St.DrawingArea.
  _makeFillet(left) {
    const area = new St.DrawingArea({
      width: FILLET_R,
      height: FILLET_R,
      visible: false,
    });
    area.connect("repaint", () => {
      const ctx = area.get_context();
      const col = this._filletColor ?? [0, 0, 0, 1];
      ctx.setSourceRGBA(col[0], col[1], col[2], col[3]);
      ctx.rectangle(0, 0, FILLET_R, FILLET_R);
      ctx.fill();
      ctx.setOperator(Cairo.Operator.CLEAR);
      ctx.arc(left ? 0 : FILLET_R, FILLET_R, FILLET_R, 0, 2 * Math.PI);
      ctx.fill();
      ctx.setOperator(Cairo.Operator.OVER);
      ctx.$dispose();
    });
    return area;
  }

  // -------------------------------------------------------- notch styling

  _applyNotchStyle() {
    if (!this._backdrop) return;
    const styleVal = this._settings.get_enum("notch-style");
    const apple = styleVal === 0 || styleVal === 2;
    const bg = this._settings.get_string("notch-bg");
    const r = this._settings.get_int("notch-radius");

    if (apple) {
      this._backdrop.set_style(
        `background-color: ${bg}; border-radius: 0 0 ${r}px ${r}px;`,
      );
      this._backdrop.remove_style_class_name("dn-notch-pill");
      this._backdrop.add_style_class_name("dn-notch-apple");
    } else {
      this._backdrop.set_style(
        `background-color: ${bg}; border-radius: ${r}px;`,
      );
      this._backdrop.remove_style_class_name("dn-notch-apple");
      this._backdrop.add_style_class_name("dn-notch-pill");
    }
    const pc = parseColor(bg);
    if (pc) {
      this._filletColor = [pc.r / 255, pc.g / 255, pc.b / 255, pc.a];
      this._filletL?.queue_repaint();
      this._filletR?.queue_repaint();
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
    // fg goes on the backdrop (border tint) and on the clipper
    // (the content inherits its text color from there).
    for (const layer of [this._backdrop, this._clipper]) {
      layer.remove_style_class_name("dn-fg-light");
      layer.remove_style_class_name("dn-fg-dark");
      layer.add_style_class_name(`dn-fg-${fg}`);
    }
  }

  // -------------------------------------------- providers / integration

  // The notch replaces the stock calendar: hide the dateMenu's
  // panel container, and reroute any programmatic open (Super+V
  // still toggles the stock menu) to the island instead.
  // The playing app's tray icon belongs inside the notch, not
  // in the panel: hide matching app indicators in the panel.
  // The tray host re-asserts button visibility whenever the
  // item's status flips (play/pause), so the hide is guarded
  // on a 1s interval — same pattern as bannerBlocked.
  _initTrayIconHiding() {
    try {
      this._trayBoxes = [
        Main.panel._leftBox,
        Main.panel._centerBox,
        Main.panel._rightBox,
      ].filter(Boolean);
      for (const box of this._trayBoxes) {
        const id = box.connect("actor-added", () => this._scanTrayIcons());
        this._traySignals.push([box, id]);
      }
      this._scanTrayIcons();
      this._trayGuardId = GLib.timeout_add_seconds(
        GLib.PRIORITY_DEFAULT,
        1,
        () => {
          this._guardTrayIcons();
          return GLib.SOURCE_CONTINUE;
        },
      );
      // One-shot evidence if nothing ever matches.
      GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 4, () => {
        if (!this._hiddenTray.size) {
          try {
            log(
              "DN-TRAY no match; statusArea roles: " +
                Object.keys(Main.panel.statusArea ?? {}).join(","),
            );
          } catch (_e) {}
        }
        return GLib.SOURCE_REMOVE;
      });
    } catch (_e) {}
  }

  _trayTargetNames() {
    const names = new Set(["vlc"]);
    if (this._music)
      names.add(
        this._music.busName
          .replace("org.mpris.MediaPlayer2.", "")
          .split(".")[0],
      );
    return names;
  }

  _trayNameHit(text, names) {
    if (!text) return false;
    return `${text}`
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .some((t) => names.has(t));
  }

  _scanTrayIcons() {
    if (!this._trayBoxes?.length) return;
    const names = this._trayTargetNames();
    try {
      for (const [role, ind] of Object.entries(Main.panel.statusArea ?? {})) {
        if (ind && this._trayNameHit(role, names)) this._hideTrayActor(ind);
      }
    } catch (_e) {}
    const walk = (actor) => {
      try {
        if (actor instanceof St.Icon) {
          let id = actor.icon_name ?? "";
          if (!id && actor.gicon instanceof Gio.ThemedIcon)
            id = actor.gicon.get_names().join(" ");
          if (!id) id = actor.gicon?.to_string?.() ?? "";
          if (this._trayNameHit(id, names)) this._hideTrayTop(actor);
        }
        if (
          actor instanceof St.Button &&
          this._trayNameHit(actor.accessible_name, names)
        )
          this._hideTrayTop(actor);
        for (const c of actor.get_children?.() ?? []) walk(c);
      } catch (_e) {}
    };
    for (const box of this._trayBoxes)
      for (const child of box.get_children()) walk(child);
  }

  _hideTrayActor(actor) {
    if (!actor) return;
    this._hiddenTray.add(actor);
    actor.visible = false;
  }

  _hideTrayTop(iconActor) {
    let top = iconActor;
    while (top.get_parent() && !this._trayBoxes.includes(top.get_parent()))
      top = top.get_parent();
    if (top.get_parent()) this._hideTrayActor(top);
  }

  _guardTrayIcons() {
    for (const actor of [...this._hiddenTray]) {
      try {
        if (!actor.get_parent()) {
          this._hiddenTray.delete(actor);
          continue;
        }
        if (actor.visible) actor.visible = false;
      } catch (_e) {
        this._hiddenTray.delete(actor);
      }
    }
    this._scanTrayIcons();
  }

  _initDateMenuSuppression() {
    this._applyDateMenuSuppression();
    // One-shot is not enough: the indicator can register
    // late or be recreated, losing the suppression.
    if (!this._dmGuardId) {
      this._dmGuardId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
        this._guardDateMenu();
        return GLib.SOURCE_CONTINUE;
      });
    }
  }

  _guardDateMenu() {
    this._applyDateMenuSuppression();
    if (this._dateMenuContainer && this._dateMenuContainer.visible)
      this._dateMenuContainer.visible = false;
  }

  _applyDateMenuSuppression() {
    try {
      const dm = Main.panel?.statusArea?.dateMenu;
      if (!dm || dm === this._dateMenu) return;
      // A recreated indicator: drop the stale connection.
      if (this._dateMenu && this._dateMenuOpenId) {
        try {
          this._dateMenu.menu.disconnect(this._dateMenuOpenId);
        } catch (_e) {}
        this._dateMenuOpenId = 0;
      }
      this._dateMenu = dm;
      const box = dm.container ?? dm;
      this._dateMenuContainer = box;
      this._dateMenuWasVisible = box.visible !== false;
      box.visible = false;
      if (dm.menu?.connect) {
        this._dateMenuOpenId = dm.menu.connect(
          "open-state-changed",
          (_menu, isOpen) => {
            if (!isOpen) {
              this._restoreBannerBlock();
              return;
            }
            try {
              dm.menu.close();
            } catch (_e) {}
            if (this._state === State.COMPACT) this._openPanel();
          },
        );
      }
    } catch (e) {
      logError(e, "dynamic-notch: dateMenu suppression unavailable");
      this._dateMenu = null;
      this._dateMenuContainer = null;
      this._dateMenuOpenId = 0;
    }
  }

  // dateMenu writes bannerBlocked=false when its menu closes;
  // put the notification provider's block back.
  _restoreBannerBlock() {
    if (!this._notifProvider) return;
    try {
      Main.messageTray.bannerBlocked = true;
    } catch (_e) {}
  }

  // ------------------------------------------------------------ music

  // Tiny vector equalizer: cairo bars riding a sine phase — the
  // smooth "now playing" motion, redrawn only while playing.
  _makeEqArea() {
    const area = new St.DrawingArea({
      width: 16,
      height: 12,
      y_align: Clutter.ActorAlign.CENTER,
    });
    area.connect("repaint", () => this._drawEq(area));
    this._eqAreas.push(area);
    return area;
  }

  _drawEq(area) {
    try {
      const ctx = area.get_context();
      const [w, h] = area.get_surface_size();
      const col = parseColor(this._settings.get_string("accent-color"));
      if (col) ctx.setSourceRGBA(col.r / 255, col.g / 255, col.b / 255, 1);
      else ctx.setSourceRGBA(1, 1, 1, 0.9);
      const bars = 4,
        bw = 2.4;
      const gap = (w - bars * bw) / (bars - 1);
      const playing = this._music?.status === "Playing";
      for (let i = 0; i < bars; i++) {
        const f = playing
          ? 0.3 + 0.7 * Math.abs(Math.sin(this._eqPhase + i * 1.35))
          : 0.3;
        const bh = Math.max(2, h * f);
        ctx.rectangle(i * (bw + gap), h - bh, bw, bh);
        ctx.fill();
      }
      ctx.$dispose();
    } catch (_e) {}
  }

  // The eq loop may run only while the Media tab is actually
  // on screen; before, it repainted at 30 fps for the whole
  // playback, panel closed and fullscreen video included.
  _eqShouldRun() {
    return (
      this._music?.status === "Playing" &&
      this._animationsEnabled() &&
      this._state === State.EXPANDED &&
      this._page === "media"
    );
  }

  _syncEqTimer() {
    const play = this._eqShouldRun();
    if (play && !this._eqTimerId) {
      this._eqTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 33, () => {
        if (!this._eqShouldRun()) {
          this._eqTimerId = 0;
          return GLib.SOURCE_REMOVE;
        }
        this._eqPhase += 0.16;
        for (const a of this._eqAreas ?? []) if (a.visible) a.queue_repaint();
        return GLib.SOURCE_CONTINUE;
      });
    } else if (!play && this._eqTimerId) {
      GLib.source_remove(this._eqTimerId);
      this._eqTimerId = 0;
      for (const a of this._eqAreas ?? []) a.queue_repaint();
    }
  }

  _buildMediaPage() {
    const page = new St.BoxLayout({
      style_class: "dn-page-media",
      orientation: Clutter.Orientation.VERTICAL,
      y_expand: true,
      visible: false,
    });
    this._pageMedia = page;
    // Empty state: the tab exists even with no player.
    this._mediaEmpty = new St.BoxLayout({
      orientation: Clutter.Orientation.VERTICAL,
      style_class: "dn-media-empty",
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.CENTER,
      y_expand: true,
    });
    this._mediaEmpty.add_child(
      new St.Icon({
        icon_name: "media-playback-start-symbolic",
        icon_size: 28,
        x_align: Clutter.ActorAlign.CENTER,
      }),
    );
    this._mediaEmpty.add_child(
      new St.Label({
        text: "Nothing playing",
        style_class: "dn-media-empty-title",
        x_align: Clutter.ActorAlign.CENTER,
      }),
    );
    this._mediaEmpty.add_child(
      new St.Label({
        text: "Media from any app will appear here",
        style_class: "dn-music-artist",
        x_align: Clutter.ActorAlign.CENTER,
      }),
    );
    page.add_child(this._mediaEmpty);
    // Content: art + info + progress, controls underneath.
    this._mediaContent = new St.BoxLayout({
      orientation: Clutter.Orientation.VERTICAL,
      style_class: "dn-media-content",
      visible: false,
    });
    const row = new St.BoxLayout({ style_class: "dn-media-row" });
    this._musicArt = new St.Widget({
      style_class: "dn-music-art",
      layout_manager: new Clutter.BinLayout(),
      width: 64,
      height: 64,
      y_align: Clutter.ActorAlign.CENTER,
    });
    this._musicArtIcon = new St.Icon({
      icon_name: "audio-x-generic-symbolic",
      icon_size: 26,
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.CENTER,
    });
    this._musicArt.add_child(this._musicArtIcon);
    row.add_child(this._musicArt);
    const mid = new St.BoxLayout({
      orientation: Clutter.Orientation.VERTICAL,
      style_class: "dn-music-mid",
      x_expand: true,
      y_align: Clutter.ActorAlign.CENTER,
    });
    this._musicSource = new St.Label({ style_class: "dn-music-source" });
    this._musicSource.get_clutter_text().set_ellipsize(Pango.EllipsizeMode.END);
    mid.add_child(this._musicSource);
    this._musicTitle = new St.Label({ style_class: "dn-music-title" });
    this._musicTitle.get_clutter_text().set_ellipsize(Pango.EllipsizeMode.END);
    mid.add_child(this._musicTitle);
    this._musicArtist = new St.Label({ style_class: "dn-music-artist" });
    this._musicArtist.get_clutter_text().set_ellipsize(Pango.EllipsizeMode.END);
    mid.add_child(this._musicArtist);
    // Scrolling over the progress/time area seeks ±5s.
    const seekArea = new St.BoxLayout({
      orientation: Clutter.Orientation.VERTICAL,
      reactive: true,
    });
    seekArea.connect("scroll-event", (_a, event) => this._onMusicScroll(event));
    seekArea.connect("button-press-event", (_a, event) =>
      this._onSeekPress(event),
    );
    seekArea.connect("motion-event", (_a, event) => this._onSeekMotion(event));
    seekArea.connect("button-release-event", () => {
      this._seekDrag = false;
      return Clutter.EVENT_STOP;
    });
    this._musicTrack = new St.Widget({
      layout_manager: new Clutter.FixedLayout(),
      style_class: "dn-progress-track",
      x_expand: true,
    });
    this._musicTrack.set_height(3);
    this._musicFill = new St.Widget({ style: this._progressStyle() });
    this._musicFill.set_size(0, 3);
    this._musicTrack.add_child(this._musicFill);
    seekArea.add_child(this._musicTrack);
    const times = new St.BoxLayout({ style_class: "dn-media-times" });
    this._musicElapsed = new St.Label({
      text: "0:00",
      style_class: "dn-music-time",
    });
    times.add_child(this._musicElapsed);
    times.add_child(new St.Widget({ x_expand: true }));
    this._musicTotal = new St.Label({
      text: "0:00",
      style_class: "dn-music-time",
    });
    times.add_child(this._musicTotal);
    seekArea.add_child(times);
    mid.add_child(seekArea);
    row.add_child(mid);
    this._mediaContent.add_child(row);
    const ctrls = new St.BoxLayout({
      style_class: "dn-music-controls",
      x_align: Clutter.ActorAlign.CENTER,
    });
    const mkBtn = (icon, name, fn) => {
      const b = new St.Button({
        style_class: "dn-qa-button",
        child: new St.Icon({ icon_name: icon, icon_size: 18 }),
        accessible_name: name,
        y_align: Clutter.ActorAlign.CENTER,
      });
      b.connect("clicked", fn);
      ctrls.add_child(b);
      return b;
    };
    this._musicPrevBtn = mkBtn(
      "media-skip-backward-symbolic",
      "Previous track",
      () => this._musicProvider?.previous(),
    );
    this._musicPlayBtn = mkBtn(
      "media-playback-start-symbolic",
      "Play or pause",
      () => this._musicProvider?.playPause(),
    );
    this._musicNextBtn = mkBtn(
      "media-skip-forward-symbolic",
      "Next track",
      () => this._musicProvider?.next(),
    );
    ctrls.add_child(this._makeEqArea());
    this._mediaContent.add_child(ctrls);
    page.add_child(this._mediaContent);
    return page;
  }

  // Click/drag on the progress area: seek to that fraction
  // of the track (SetPosition), throttled while scrubbing.
  _seekFraction(event) {
    if (!this._music?.lengthUs || !this._musicTrack) return -1;
    const [ex] = event.get_coords();
    const [tx] = this._musicTrack.get_transformed_position();
    const [tw] = this._musicTrack.get_size();
    if (tw <= 0) return -1;
    return Math.min(1, Math.max(0, (ex - tx) / tw));
  }

  _seekTo(fraction) {
    if (!this._musicProvider || !this._music) return;
    const targetUs = fraction * this._music.lengthUs;
    if (
      this._seekLastUs !== undefined &&
      Math.abs(targetUs - this._seekLastUs) < 250000
    )
      return;
    this._seekLastUs = targetUs;
    this._musicProvider.setPosition(targetUs);
  }

  _onSeekPress(event) {
    const f = this._seekFraction(event);
    if (f < 0) return Clutter.EVENT_PROPAGATE;
    this._seekDrag = true;
    this._seekLastUs = undefined;
    this._seekTo(f);
    return Clutter.EVENT_STOP;
  }

  _onSeekMotion(event) {
    if (!this._seekDrag) return Clutter.EVENT_PROPAGATE;
    if (!(event.get_state() & Clutter.ModifierType.BUTTON1_MASK)) {
      this._seekDrag = false;
      return Clutter.EVENT_PROPAGATE;
    }
    const f = this._seekFraction(event);
    if (f >= 0) this._seekTo(f);
    return Clutter.EVENT_STOP;
  }

  _onMusicScroll(event) {
    if (!this._musicProvider || !this._music) return Clutter.EVENT_PROPAGATE;
    let step = 0;
    const dir = event.get_scroll_direction();
    if (dir === Clutter.ScrollDirection.SMOOTH) {
      const [, dy] = event.get_scroll_delta();
      this._seekAcc = (this._seekAcc ?? 0) + dy;
      if (Math.abs(this._seekAcc) >= 1) {
        step = this._seekAcc > 0 ? -1 : 1;
        this._seekAcc = 0;
      }
    } else if (dir === Clutter.ScrollDirection.UP) step = 1;
    else if (dir === Clutter.ScrollDirection.DOWN) step = -1;
    if (step !== 0) this._musicProvider.seek(step * 5000000);
    return Clutter.EVENT_STOP;
  }

  _onMusicChanged(snap) {
    const prevId = this._music
      ? `${this._music.title}|${this._music.artist}`
      : "";
    const wasAvailable = !!this._music;
    this._music = snap;
    this._renderMusic();
    // The tray scan must never block media rendering.
    try {
      this._scanTrayIcons();
    } catch (_e) {}
    // A genuinely new track surfaces briefly in the notch.
    const nowId = snap ? `${snap.title}|${snap.artist}` : "";
    if (snap && snap.status === "Playing" && prevId && nowId !== prevId) {
      let gicon = null;
      try {
        if (snap.artUrl)
          gicon = new Gio.FileIcon({
            file: Gio.File.new_for_uri(snap.artUrl),
          });
      } catch (_e) {}
      this._showEvent({
        gicon,
        iconName: "audio-x-generic-symbolic",
        text: snap.artist ? `${snap.title} · ${snap.artist}` : snap.title,
      });
    }
    if (
      wasAvailable !== !!snap &&
      this._page === "media" &&
      (this._state === State.EXPANDED || this._state === State.EXPANDING)
    )
      this._applySize(true);
  }

  _renderMusic() {
    const snap = this._music;
    if (this._mediaContent) this._mediaContent.visible = !!snap;
    if (this._mediaEmpty) this._mediaEmpty.visible = !snap;
    this._syncEqTimer();
    this._updateMediaGradient(snap);
    if (!snap) return;
    if (this._musicSource) {
      const base = snap.busName
        .replace("org.mpris.MediaPlayer2.", "")
        .split(".")[0];
      const app = snap.identity
        ? snap.identity
        : (PLAYER_NAMES[base] ?? base.charAt(0).toUpperCase() + base.slice(1));
      this._musicSource.text =
        app + (snap.status === "Paused" ? " · Paused" : "");
    }
    if (this._musicTitle) this._musicTitle.text = snap.title || "Unknown title";
    if (this._musicArtist)
      this._musicArtist.text = snap.artist || snap.album || "";
    if (this._musicArt) {
      // St cannot load http(s) art (YouTube thumbnails):
      // those are served from the local cache copy instead.
      const raw = snap.artUrl ?? "";
      const artUri = raw.startsWith("http")
        ? (this._artLocal.get(raw) ?? "")
        : raw;
      if (artUri) {
        this._musicArt.set_style(
          `background-image: url("${artUri}");` + " background-size: cover;",
        );
        this._musicArtIcon.visible = false;
      } else {
        this._musicArt.set_style("");
        this._musicArtIcon.visible = true;
        this._musicArtIcon.gicon = this._playerGicon(snap);
        if (!this._musicArtIcon.gicon)
          this._musicArtIcon.icon_name = "audio-x-generic-symbolic";
      }
    }
    if (this._musicPlayBtn) {
      this._musicPlayBtn.child.icon_name =
        snap.status === "Playing"
          ? "media-playback-pause-symbolic"
          : "media-playback-start-symbolic";
      const canPlay = snap.canPlay || snap.canPause;
      this._musicPlayBtn.reactive = canPlay;
      this._musicPlayBtn.opacity = canPlay ? 255 : 110;
      this._musicPrevBtn.reactive = snap.canPrev;
      this._musicPrevBtn.opacity = snap.canPrev ? 255 : 110;
      this._musicNextBtn.reactive = snap.canNext;
      this._musicNextBtn.opacity = snap.canNext ? 255 : 110;
    }
    this._renderMusicProgress();
  }

  // Position is not signalled by MPRIS; project it locally from
  // the last snapshot while playing.
  _musicPositionUs() {
    const s = this._music;
    if (!s) return 0;
    if (s.status !== "Playing") return s.positionUs;
    const pos = s.positionUs + (GLib.get_monotonic_time() - s.stampUs);
    return s.lengthUs > 0 ? Math.min(pos, s.lengthUs) : pos;
  }

  _renderMusicProgress() {
    if (!this._music || !this._musicTrack) return;
    const s = this._music;
    const fmt = (us) => {
      const sec = Math.max(0, Math.floor(us / 1e6));
      return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
    };
    if (this._musicElapsed)
      this._musicElapsed.text = fmt(this._musicPositionUs());
    if (this._musicTotal)
      this._musicTotal.text = s.lengthUs > 0 ? fmt(s.lengthUs) : "—";
    if (!this._musicFill) return;
    const w = this._musicTrack.get_width();
    if (!(w > 0)) return;
    const frac =
      s.lengthUs > 0 ? Math.min(1, this._musicPositionUs() / s.lengthUs) : 0;
    this._musicFill.set_size(Math.round(frac * w), 3);
  }

  // The media content card wears a gradient of the playing
  // track's cover color; until the art is decoded (or when it
  // has none) the accent color stands in at a lower alpha.
  _updateMediaGradient(snap) {
    if (!this._pageMedia) return;
    if (!snap) {
      if (this._gradientKey !== "") {
        this._pageMedia.set_style("");
        this._gradientKey = "";
      }
      return;
    }
    const url = snap.artUrl ?? "";
    const artCol = url ? this._artColors.get(url) : null;
    if (artCol) {
      const key = `art:${url}`;
      if (this._gradientKey !== key) {
        this._gradientKey = key;
        this._applyMediaGradient(artCol, 0.34);
      }
      return;
    }
    if (url) this._loadArtColor(url);
    const acc = parseColor(this._settings.get_string("accent-color"));
    const key = `fb:${url}|${acc ? `${acc.r},${acc.g},${acc.b}` : "w"}`;
    if (this._gradientKey !== key) {
      this._gradientKey = key;
      if (acc) this._applyMediaGradient([acc.r, acc.g, acc.b], 0.16);
      else this._pageMedia.set_style("");
    }
  }

  _applyMediaGradient([r, g, b], alpha) {
    this._pageMedia.set_style(
      "background-gradient-direction: vertical;" +
        ` background-gradient-start: rgba(${r},${g},${b},${alpha});` +
        ` background-gradient-end: rgba(${r},${g},${b},0.02);`,
    );
  }

  // Decode the cover (local file synchronously, http async via
  // a pixbuf loader) and cache its average color per URL.
  _loadArtColor(url) {
    if (this._artColors.has(url) || this._artPending.has(url)) return;
    this._artPending.add(url);
    const done = (pb) => {
      this._artPending.delete(url);
      const col = pb ? this._averageColor(pb) : null;
      if (col) this._artColors.set(url, col);
      if (this._music?.artUrl === url) this._updateMediaGradient(this._music);
    };
    try {
      if (url.startsWith("file://")) {
        const path = Gio.File.new_for_uri(url).get_path();
        done(GdkPixbuf.Pixbuf.new_from_file_at_size(path, 32, 32));
      } else if (url.startsWith("http")) {
        Gio.File.new_for_uri(url).load_contents_async(null, (file, res) => {
          try {
            const [, bytes] = file.load_contents_finish(res);
            const loader = new GdkPixbuf.PixbufLoader();
            loader.write(bytes);
            loader.close();
            this._cacheArtFile(url, bytes);
            done(loader.get_pixbuf());
          } catch (_e) {
            done(null);
          }
        });
      } else {
        done(null);
      }
    } catch (_e) {
      done(null);
    }
  }

  // Mean RGB of the cover, near-black pixels skipped so
  // shadow-heavy art does not muddy the gradient.
  _averageColor(pixbuf) {
    try {
      let pb = pixbuf;
      if (pb.get_width() > 16 || pb.get_height() > 16)
        pb = pb.scale_simple(16, 16, GdkPixbuf.InterpType.BILINEAR);
      const w = pb.get_width(),
        h = pb.get_height();
      const ch = pb.get_n_channels();
      const rs = pb.get_rowstride();
      const px = pb.get_pixels();
      let r = 0,
        g = 0,
        b = 0,
        n = 0;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = y * rs + x * ch;
          const lum = 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
          if (lum < 12) continue;
          r += px[i];
          g += px[i + 1];
          b += px[i + 2];
          n++;
        }
      }
      if (!n) return null;
      return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
    } catch (_e) {
      return null;
    }
  }

  // Downloaded http art is kept as a local cache file so the
  // art box can show it (St only loads local background images).
  _cacheArtFile(url, bytes) {
    try {
      const dir = GLib.build_filenamev([
        GLib.get_user_cache_dir(),
        "dynamic-notch",
        "art",
      ]);
      try {
        Gio.File.new_for_path(dir).make_directory_with_parents(null);
      } catch (_e) {}
      const name =
        GLib.compute_checksum_for_string(GLib.ChecksumType.SHA1, url, -1) +
        (url.match(/\.(?:jpe?g|png|webp)/i)?.[0] ?? ".img");
      const file = Gio.File.new_for_path(GLib.build_filenamev([dir, name]));
      file.replace_contents_async(
        bytes,
        null,
        false,
        Gio.FileCreateFlags.REPLACE_DESTINATION,
        null,
        (f, res) => {
          try {
            f.replace_contents_finish(res);
            this._artLocal.set(url, f.get_uri());
            if (this._music?.artUrl === url) this._renderMusic();
          } catch (_e) {}
        },
      );
    } catch (_e) {}
  }

  // The playing app's own icon (e.g. the VLC cone), shown in
  // the art box when the track has no cover. The MPRIS
  // DesktopEntry is tried before the bus-name guess.
  _playerGicon(snap) {
    const busName = snap.busName;
    if (!this._playerIcons) this._playerIcons = new Map();
    if (this._playerIcons.has(busName)) return this._playerIcons.get(busName);
    let gicon = null;
    try {
      const base = busName.replace("org.mpris.MediaPlayer2.", "").split(".")[0];
      const appSys = Shell.AppSystem.get_default();
      const app =
        (snap.desktopEntry &&
          appSys.lookup_app(`${snap.desktopEntry}.desktop`)) ||
        appSys.lookup_app(`${base}.desktop`);
      gicon = app?.get_icon() ?? null;
    } catch (_e) {}
    this._playerIcons.set(busName, gicon);
    return gicon;
  }

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

    // System events (charger, bluetooth, volume, network, ...).
    try {
      this._eventsProvider = new SystemEventsProvider({
        onEvent: (e) => this._showEvent(e),
      });
      this._eventsProvider.start();
    } catch (e) {
      logError(e, "dynamic-notch: system events unavailable");
      this._eventsProvider = null;
    }

    // Clipboard history (Tab 3), captured silently.
    try {
      this._clipProvider = new ClipboardProvider({
        onChanged: () => this._refreshClipList(),
      });
      this._clipProvider.start();
    } catch (e) {
      logError(e, "dynamic-notch: clipboard history unavailable");
      this._clipProvider = null;
    }

    // Music (MPRIS): compact now-playing + Main-tab section.
    try {
      this._musicProvider = new MusicProvider({
        onChanged: (s) => this._onMusicChanged(s),
      });
      this._musicProvider.start();
    } catch (e) {
      logError(e, "dynamic-notch: music integration unavailable");
      this._musicProvider = null;
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
    kind = "notification",
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
    this._peekKind = kind;
    if (kind !== "notification") this._peekNotification = null;
    this._cancelEvent();
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
    // Content fades in as the box grows (and resets any fade-out
    // left over from a previous peek's close).
    this._peekView.remove_all_transitions();
    if (this._animationsEnabled() && this._state === State.COMPACT) {
      this._peekView.opacity = 0;
      this._peekView.ease({
        opacity: 255,
        duration: Math.round(ANIM_MS * 0.7),
        mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
      });
    } else {
      this._peekView.opacity = 255;
    }
    if (this._state === State.COLLAPSING) return; // collapse onDone re-applies size for the peek
    this._syncViews();
    this._applySize(true);
    this._shakeNotch();
  }

  _hidePeek() {
    if (this._peekTimeoutId) {
      GLib.source_remove(this._peekTimeoutId);
      this._peekTimeoutId = 0;
    }
    if (!this._peekActive) return;
    this._peekActive = false;
    this._peekNotification = null;
    this._updateCompactDisplay();
    if (this._state !== State.COMPACT) return;
    // Swap the compact content back NOW, not in the morph's
    // onDone: that callback lives in a single slot and an
    // interrupted morph drops it, leaving every view hidden
    // (a blank black notch) until some unrelated sync.
    this._peekView.remove_all_transitions();
    this._peekView.opacity = 0;
    this._animOnDone = null;
    this._syncViews();
    if (this._animationsEnabled()) this._fadeInCompact();
    this._applySize(true);
  }

  // ------------------------------------------------------ system events

  _cancelEvent() {
    if (this._eventTimeoutId) {
      GLib.source_remove(this._eventTimeoutId);
      this._eventTimeoutId = 0;
    }
    this._eventActive = false;
  }

  _showEvent({ iconName = null, gicon = null, text = "" }) {
    // Peeks (notification / timer) win; the expanded panel shows all.
    if (
      this._peekActive ||
      this._state === State.EXPANDED ||
      this._state === State.EXPANDING
    )
      return;
    if (gicon) {
      this._eventIcon.gicon = gicon;
      this._eventIcon.visible = true;
    } else if (iconName) {
      this._eventIcon.gicon = null;
      this._eventIcon.icon_name = iconName;
      this._eventIcon.visible = true;
    } else {
      this._eventIcon.visible = false;
    }
    this._eventLabel.text = text;
    const [, natW] = this._eventView.get_preferred_width(-1);
    this._eventNaturalW = natW;
    this._eventActive = true;
    if (this._eventTimeoutId) GLib.source_remove(this._eventTimeoutId);
    this._eventTimeoutId = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      EVENT_MS,
      () => {
        this._eventTimeoutId = 0;
        this._hideEvent();
        return GLib.SOURCE_REMOVE;
      },
    );
    this._eventView.remove_all_transitions();
    if (this._animationsEnabled() && this._state === State.COMPACT) {
      this._eventView.opacity = 0;
      this._eventView.ease({
        opacity: 255,
        duration: Math.round(ANIM_MS * 0.7),
        mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
      });
    } else {
      this._eventView.opacity = 255;
    }
    if (this._state === State.COLLAPSING) return; // collapse onDone re-applies size for the event
    this._syncViews();
    this._applySize(true);
    this._shakeNotch();
  }

  _hideEvent() {
    const was = this._eventActive;
    this._cancelEvent();
    if (!was || this._state !== State.COMPACT) return;
    this._eventView.remove_all_transitions();
    this._eventView.opacity = 0;
    this._animOnDone = null;
    this._syncViews();
    if (this._animationsEnabled()) this._fadeInCompact();
    this._applySize(true);
  }

  // Soften the compact view's pop-in at the end of a peek close.
  _fadeInCompact() {
    if (!this._clockWidget || !this._clockWidget.visible) return;
    this._clockWidget.remove_all_transitions();
    this._clockWidget.opacity = 0;
    this._clockWidget.ease({
      opacity: 255,
      duration: 120,
      mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
    });
  }

  // ------------------------------------------------------ notifications

  _notifFields(n) {
    const f = {
      app: "",
      title: "",
      body: "",
      time: "",
      gicon: null,
      urgency: null,
    };
    try {
      if (typeof n.urgency === "number") f.urgency = n.urgency;
    } catch (_e) {}
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

  // Peek close: notifications only minimize (see _hidePeek);
  // the timer-complete close also ends the finished display.
  _dismissPeek() {
    // Notification peeks only minimize, exactly like the
    // timeout does; the notification itself stays in the list.
    this._peekNotification = null;
    // Closing the "Time's up!" peek also ends the finished
    // state now; otherwise the chip stays until the timeout.
    if (
      this._peekKind === "timer-complete" &&
      this._timerState === "finished"
    ) {
      if (this._timerFinishTimeoutId) {
        GLib.source_remove(this._timerFinishTimeoutId);
        this._timerFinishTimeoutId = 0;
      }
      this._timerStop();
    }
    this._hidePeek();
  }

  _onLiveNotification(n) {
    this._peekNotification = n;
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
    if (this._notifAvailable) {
      this._notifCount.text = `${all.length}`;
      this._notifCount.visible = all.length > 0;
      this._notifCount.style_class = "dn-notif-badge";
    } else {
      this._notifCount.text = "n/a";
      this._notifCount.visible = true;
      this._notifCount.style_class = "dn-notif-count";
    }
    this._clearButton.reactive = all.length > 0;
    this._clearButton.opacity = all.length > 0 ? 255 : 120;
    this._notifEmpty.visible = all.length === 0;
    this._notifEmpty.text = this._notifAvailable
      ? "No notifications"
      : "Notifications unavailable";
    for (const n of all) this._notifList.add_child(this._makeNotifItem(n));
    this._syncQaStates();
  }

  _makeNotifItem(n) {
    const f = this._notifFields(n);
    const button = new St.Button({
      style_class: "dn-notif-item",
      x_expand: true,
    });
    button.x_align = Clutter.ActorAlign.FILL;
    const row = new St.BoxLayout({
      style_class: "dn-notif-row",
      x_expand: true,
    });
    const icon = f.gicon
      ? new St.Icon({ gicon: f.gicon, icon_size: 18 })
      : new St.Icon({
          icon_name: "dialog-information-symbolic",
          icon_size: 18,
        });
    icon.y_align = Clutter.ActorAlign.START;
    row.add_child(icon);
    const texts = new St.BoxLayout({
      orientation: Clutter.Orientation.VERTICAL,
      style_class: "dn-notif-texts",
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
      // One line, ellipsized by the layout itself: a long
      // body ends with "…" at the row's real width instead
      // of being hard-cut at a fixed character count.
      const body = new St.Label({
        text: f.body.replace(/\s+/g, " ").trim(),
        style_class: "dn-notif-item-sub",
      });
      body.get_clutter_text().set_ellipsize(Pango.EllipsizeMode.END);
      texts.add_child(body);
    }
    row.add_child(texts);
    // Urgency dot: only for states the source actually reports
    // (MessageTray urgency HIGH=2 / CRITICAL=3) — nothing invented.
    if (f.urgency !== null && f.urgency >= 2) {
      const dot = new St.Widget({
        style:
          "width: 7px; height: 7px; border-radius: 999px;" +
          `background-color: ${f.urgency >= 3 ? "#e01b24" : "#ff7800"};`,
        y_align: Clutter.ActorAlign.CENTER,
      });
      row.add_child(dot);
    }
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

  // The user's accent color with an alpha; GNOME blue on bad input.
  _accentWithAlpha(alpha) {
    const m = /(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(
      this._settings?.get_string("accent-color") ?? "",
    );
    const [r, g, b] = m ? m.slice(1, 4) : [53, 132, 228];
    return `rgba(${r},${g},${b},${alpha})`;
  }

  _applyAccent() {
    this._renderCalendar();
    for (const [id, b] of this._tabButtons ?? []) {
      b.set_style(
        id === (this._page ?? "main")
          ? `background-color: ${this._accentWithAlpha(0.32)};`
          : "",
      );
    }
    for (const f of [this._timerProgressFill, this._tabProgressFill])
      f?.set_style(this._progressStyle());
    if (this._musicFill) this._musicFill.set_style(this._progressStyle());
    this._updateMediaGradient(this._music);
    this._timerRing?.queue_repaint();
  }

  // Timer progress fills wear the accent color at full strength.
  _progressStyle() {
    return (
      `background-color: ${this._accentWithAlpha(1)};` +
      " border-radius: 999px;"
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
      const isToday = this._sameDay(d, now);
      const isSelected =
        this._calSelected && this._sameDay(d, this._calSelected);
      if (isToday) cls += " dn-cal-today";
      if (isSelected) cls += " dn-cal-selected";
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
      // Today/selected wear the accent color; the inline style
      // overrides the stylesheet's stock blue.
      let style = "";
      if (isToday) style += `background-color: ${this._accentWithAlpha(0.45)};`;
      if (isSelected)
        style += ` border: 1px solid ${this._accentWithAlpha(1)};`;
      cell.button.set_style(style);
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
      "timer-complete",
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
    this._timerLabel.style_class =
      "dn-timer-count" +
      (this._timerState === "running" ? " dn-timer-running" : "");
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

    this._timerChipLabel.text =
      state === "finished"
        ? "Time's up!"
        : `${this._timerTitle} — ${this._fmtTimerHMS(remain)}` +
          (state === "paused" ? " · Paused" : "");
    // Progress from the monotonic remaining time (never tick-counted).
    const frac =
      this._timerTotalSec > 0
        ? Math.min(
            1,
            Math.max(0, (this._timerTotalSec - remain) / this._timerTotalSec),
          )
        : 0;
    this._setProgress(this._timerProgressFill, frac, 56);
    if (this._tabProgressTrack) {
      // No stray empty track while idle: it only exists
      // once the timer is actually running/paused/finished.
      const showTrack = state !== "idle";
      if (this._tabProgressTrack.visible !== showTrack) {
        this._tabProgressTrack.visible = showTrack;
        // The page self-sizes: grow/shrink the open panel
        // by the track's height on the transition.
        if (this._state === State.EXPANDED || this._state === State.EXPANDING)
          this._applySize(true);
      }
      this._setProgress(
        this._tabProgressFill,
        frac,
        this._tabProgressTrack.get_width(),
      );
    }
    this._updateCompactDisplay();
    this._syncQaStates();
    this._timerRing?.queue_repaint();
    this._syncRingTimer();
  }

  // Smooth elapsed fraction from the monotonic deadline.
  _timerFrac() {
    if (this._timerTotalSec <= 0) return 0;
    let remain = this._timerRemainSec;
    if (this._timerState === "running")
      remain = Math.max(
        0,
        (this._timerDeadline - GLib.get_monotonic_time()) / 1e6,
      );
    else if (this._timerState === "idle") remain = this._timerTotalSec;
    return Math.min(
      1,
      Math.max(0, (this._timerTotalSec - remain) / this._timerTotalSec),
    );
  }

  _drawTimerRing() {
    const area = this._timerRing;
    if (!area) return;
    try {
      const ctx = area.get_context();
      const [w, h] = area.get_surface_size();
      const cx = w / 2,
        cy = h / 2;
      const radius = Math.min(w, h) / 2 - 3;
      const col = parseColor(this._settings.get_string("accent-color"));
      const [r, g, b] = col
        ? [col.r / 255, col.g / 255, col.b / 255]
        : [1, 1, 1];
      ctx.setLineWidth(5);
      ctx.setSourceRGBA(r, g, b, 0.18);
      ctx.arc(cx, cy, radius, 0, 2 * Math.PI);
      ctx.stroke();
      const frac = this._timerFrac();
      if (frac > 0.001) {
        ctx.setLineCap(1); // cairo LineCap.ROUND
        ctx.setSourceRGBA(r, g, b, 0.95);
        ctx.arc(
          cx,
          cy,
          radius,
          -Math.PI / 2,
          -Math.PI / 2 + frac * 2 * Math.PI,
        );
        ctx.stroke();
      }
      ctx.$dispose();
    } catch (_e) {}
  }

  // 33ms repaint loop while the timer runs, like the eq timer.
  _syncRingTimer() {
    const want = this._timerState === "running" && this._animationsEnabled();
    if (want && !this._ringTimerId) {
      this._ringTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 33, () => {
        this._timerRing?.queue_repaint();
        return GLib.SOURCE_CONTINUE;
      });
    } else if (!want && this._ringTimerId) {
      GLib.source_remove(this._ringTimerId);
      this._ringTimerId = 0;
      this._timerRing?.queue_repaint();
    }
  }

  // Compact display priority: notification peek > timer > date.
  _compactState() {
    if (this._peekActive) return this._peekKind ?? "notification";
    return this._timerState !== "idle" ? "timer" : "date";
  }

  _updateCompactDisplay() {
    if (!this._timerChip || !this._clockTime) return;
    const showTimer = this._timerState !== "idle";
    this._timerChip.visible = showTimer;
    this._clockTime.visible = !showTimer;
  }

  // Smooth fill while running (1s linear ease per tick); frozen
  // when paused/finished, instant when animations are disabled.
  _setProgress(fill, frac, trackW) {
    if (!fill || !(trackW > 0)) return;
    const target = Math.round(trackW * frac);
    fill.remove_all_transitions();
    if (
      this._timerState === "running" &&
      this._animationsEnabled() &&
      fill.width !== target
    ) {
      fill.ease({
        width: target,
        duration: 1000,
        mode: Clutter.AnimationMode.LINEAR,
      });
    } else {
      fill.set_size(target, 4);
    }
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
