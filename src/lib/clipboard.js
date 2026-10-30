import GLib from "gi://GLib";
import Meta from "gi://Meta";
import St from "gi://St";

const MAX_ITEMS = 15;
const MAX_TEXT = 8000;
const TEXT_MIMES = [
  "text/plain;charset=utf-8",
  "text/plain",
  "UTF8_STRING",
  "STRING",
];

// In-memory text clipboard history. On Wayland the only copy signal
// is MetaSelection owner-changed, visible inside the compositor.
export class ClipboardProvider {
  constructor({ onChanged, onCopy }) {
    this._onChanged = onChanged ?? (() => {});
    this._onCopy = onCopy ?? (() => {});
    this._items = [];
    this._selection = null;
    this._ownerChangedId = 0;
    this._clipboard = null;
    this._restoring = false;
    this._restoreTimeoutId = 0;
    this._destroyed = false;
  }

  start() {
    this._clipboard = St.Clipboard.get_default();
    this._selection = global.display.get_selection();
    this._ownerChangedId = this._selection.connect(
      "owner-changed",
      (_s, type, owner) => this._onOwnerChanged(type, owner),
    );
  }

  destroy() {
    this._destroyed = true;
    if (this._restoreTimeoutId) GLib.source_remove(this._restoreTimeoutId);
    this._restoreTimeoutId = 0;
    if (this._selection && this._ownerChangedId)
      this._selection.disconnect(this._ownerChangedId);
    this._ownerChangedId = 0;
    this._selection = null;
    this._items = [];
  }

  getAll() {
    return this._items;
  }

  clear() {
    this._items = [];
    this._onChanged();
  }

  // Put an old item back on the clipboard. The owner change it
  // causes re-captures it as current, without firing the peek.
  restore(item) {
    this._restoring = true;
    if (this._restoreTimeoutId) GLib.source_remove(this._restoreTimeoutId);
    this._restoreTimeoutId = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      500,
      () => {
        this._restoreTimeoutId = 0;
        this._restoring = false;
        return GLib.SOURCE_REMOVE;
      },
    );
    try {
      this._clipboard?.set_text(St.ClipboardType.CLIPBOARD, item.text);
    } catch (e) {
      this._restoring = false;
      logError(e, "dynamic-notch: clipboard restore failed");
    }
  }

  _onOwnerChanged(type, owner) {
    if (this._destroyed || !owner) return;
    if (type !== Meta.SelectionType.SELECTION_CLIPBOARD) return;
    let mimes = [];
    try {
      mimes = owner.get_mimetypes() ?? [];
    } catch (_e) {}
    // Password managers mark secrets with this mimetype; those
    // copies are never read or stored.
    if (mimes.includes("x-kde-passwordManagerHint")) return;
    if (!TEXT_MIMES.some((m) => mimes.includes(m))) return;
    this._clipboard.get_text(St.ClipboardType.CLIPBOARD, (_cb, text) =>
      this._capture(text),
    );
  }

  _capture(text) {
    if (this._destroyed) return;
    const restoring = this._restoring;
    this._restoring = false;
    if (this._restoreTimeoutId) {
      GLib.source_remove(this._restoreTimeoutId);
      this._restoreTimeoutId = 0;
    }
    if (!text || !text.trim()) return;
    const clipped = text.slice(0, MAX_TEXT);
    const existing = this._items.findIndex((i) => i.text === clipped);
    if (existing >= 0) this._items.splice(existing, 1);
    this._items.unshift({ text: clipped, time: Date.now() });
    if (this._items.length > MAX_ITEMS) this._items.length = MAX_ITEMS;
    this._onChanged();
    if (!restoring) this._onCopy();
  }
}
