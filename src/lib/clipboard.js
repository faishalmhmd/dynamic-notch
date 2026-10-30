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
  constructor({ onChanged }) {
    this._onChanged = onChanged ?? (() => {});
    this._items = [];
    this._selection = null;
    this._ownerChangedId = 0;
    this._clipboard = null;
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
  // causes re-captures it as the current item.
  restore(item) {
    try {
      this._clipboard?.set_text(St.ClipboardType.CLIPBOARD, item.text);
    } catch (e) {
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
    if (!text || !text.trim()) return;
    const clipped = text.slice(0, MAX_TEXT);
    const existing = this._items.findIndex((i) => i.text === clipped);
    if (existing >= 0) this._items.splice(existing, 1);
    this._items.unshift({ text: clipped, time: Date.now() });
    if (this._items.length > MAX_ITEMS) this._items.length = MAX_ITEMS;
    this._onChanged();
  }
}
