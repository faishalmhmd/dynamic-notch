# Dynamic Notch — GNOME Shell 51

Notch/pill di tengah atas panel yang **menggantikan dateMenu bawaan GNOME**:
jam, kalender, dan notifikasi masuk ke notch dengan UI sendiri.

- **Panel gabungan**: SEMUA klik pada notch (kiri/kanan/tengah) membuka satu
  panel yang sama — media (MPRIS) di atas, kalender (kiri) + notifikasi
  (kanan) di bawah. Hover hanya menampilkan preview. Tidak ada menu klik
  kanan terpisah.
- **Notifikasi masuk notch dulu**: banner stok diblokir
  (`Main.messageTray.bannerBlocked = true`), notifikasi tampil sebagai
  live activity di notch ±4 detik, lalu menetap di daftar panel gabungan.
  Policy per-app / DND dihormati, kecuali notifikasi CRITICAL.
- **Kalender**: instance `Calendar.DBusEventSource` sendiri (backend
  `org.gnome.Shell.CalendarServer` yang sama dengan dateMenu), grid bulan
  + daftar acara hari terpilih, render sendiri.
- **dateMenu dimatikan, bukan di-destroy**: actor disembunyikan, dan kalau
  menu stok tetap mencoba terbuka (mis. keybinding `Super+V` /
  toggle-calendar), langsung ditutup dan dialihkan ke panel gabungan.
- **Gaya notch**: `apple` (nempel tepi atas, radius bawah saja, setinggi
  panel) atau `pill` (melayang, radius penuh). Lebar/radius/warna diatur.
- **Transparansi panel**: status panel tidak berubah selama animasi
  Overview/menu Apps. Transparansi adaptif menghitung ulang langsung setelah
  Overview ditutup dan saat jendela/desktop berubah.
- **Live activity lain**: musik yang sedang diputar (MPRIS), progress
  transfer file, transisi baterai charging/discharging (UPower).

## Struktur & cara edit

Sumber extension adalah file biasa di `src/` — edit di sana, bukan di
script dan bukan di folder extensions:

```
dynamic-notch.sh   installer: salin src/ -> ~/.local/share/gnome-shell/extensions/dynamic-notch@local + compile schema
src/
  extension.js  prefs.js  stylesheet.css  metadata.json
  lib/          notifications.js calendarProvider.js music.js fileTransfer.js battery.js
  schemas/      org.gnome.shell.extensions.dynamic-notch.gschema.xml
```

Alur edit: ubah file di `src/` → jalankan `./dynamic-notch.sh` → muat
ulang Shell (X11: Alt+F2 `r`; Wayland: logout/login).

## Install

```sh
./dynamic-notch.sh            # install / update
./dynamic-notch.sh --enable   # install + coba enable
./dynamic-notch.sh --uninstall
```

Setelah install di Wayland: **logout/login**, lalu:

```sh
gnome-extensions enable dynamic-notch@local
gnome-extensions prefs dynamic-notch@local
```

Extension terinstall di `~/.local/share/gnome-shell/extensions/dynamic-notch@local`,
schema `org.gnome.shell.extensions.dynamic-notch`.

## Struktur

```
extension.js            orkestrasi: notch, panel gabungan, theming panel, pengganti dateMenu
lib/notifications.js    mirror MessageTray sources, bannerBlocked, badge, clear-all
lib/calendarProvider.js DBusEventSource sendiri: range/bulan/hari terpilih
lib/music.js            MPRIS: enumerasi player, metadata, kontrol
lib/fileTransfer.js     sinyal Unity LauncherEntry (progress copy file)
lib/battery.js          UPower DisplayDevice: % + transisi state
prefs.js                Adw preferences
stylesheet.css          styling notch & panel
```

Di `lib/music.js` ada titik integrasi bertanda komentar
`INTEGRATION POINT: dynamic-music-pill lyrics engine plugs in here` —
engine lirik dynamic-music-pill dipasang di sana, bukan ditulis ulang.

## Verifikasi manual yang masih perlu dilakukan di mesin target

1. **Kanal progress copy file** — belum terverifikasi Nautilus di mesin ini
   benar-benar mengirimnya. Cek:
   ```sh
   dbus-monitor --session "interface='com.canonical.Unity.LauncherEntry'"
   ```
   lalu copy file besar di Nautilus. Kalau muncul sinyal `Update` dengan
   `progress` / `progress-visible`, provider transfer file akan menampilkannya
   di notch. Kalau tidak ada sinyal sama sekali, provider ini diam saja
   (by design) — Nautilus build tersebut tidak mengekspos progress copy.

2. **Intersepsi dateMenu** — perilaku `open-state-changed` menu stok saat
   dipicu `Super+V` perlu dites live.

3. **Banner queue** — pastikan tidak ada banner stok yang tumpah keluar
   setelah extension di-disable di tengah notifikasi masuk (notifikasi
   ditandai `acknowledged` setelah live activity untuk mencegah ini).

Debug: `journalctl -f -o cat /usr/bin/gnome-shell` (filter `dynamic-notch`).
