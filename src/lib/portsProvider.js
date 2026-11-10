// Listening ports from /proc: /proc/net/{tcp,tcp6,udp,udp6}
// for the sockets, /proc/<pid>/fd + comm for their owners.

import Gio from "gi://Gio";

function _readText(path) {
  try {
    const [ok, bytes] = Gio.File.new_for_path(path).load_contents(null);
    if (ok) return new TextDecoder().decode(bytes);
  } catch (e) {
    /* hilang: perlakukan kosong */
  }
  return "";
}

function _ipv4(hex) {
  const b = [];
  for (let i = 6; i >= 0; i -= 2) b.push(parseInt(hex.substr(i, 2), 16));
  return b.join(".");
}

function _ipv6(hex) {
  // /proc prints 4 host-endian words: reverse each word's
  // bytes, split into hextets, compress the longest 0-run.
  let norm = "";
  for (let w = 0; w < 32; w += 8) {
    const word = hex.substr(w, 8);
    for (let i = 6; i >= 0; i -= 2) norm += word.substr(i, 2);
  }
  const groups = [];
  for (let i = 0; i < 32; i += 4)
    groups.push(norm.substr(i, 4).replace(/^0+/, "") || "0");
  let bestStart = -1,
    bestLen = 0,
    runStart = -1,
    runLen = 0;
  for (let i = 0; i <= groups.length; i++) {
    if (i < groups.length && groups[i] === "0") {
      if (runStart < 0) runStart = i;
      runLen++;
    } else {
      if (runLen > bestLen) {
        bestStart = runStart;
        bestLen = runLen;
      }
      runStart = -1;
      runLen = 0;
    }
  }
  if (bestLen < 2) return groups.join(":");
  const head = groups.slice(0, bestStart).join(":");
  const tail = groups.slice(bestStart + bestLen).join(":");
  return `${head}::${tail}`;
}

function _parseNet(text, proto, v6, out) {
  for (const line of text.split("\n").slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10) continue;
    // TCP counts only in LISTEN (0A); bound UDP is listed.
    if (proto === "TCP" && f[3] !== "0A") continue;
    const [ipHex, portHex] = f[1].split(":");
    if (!ipHex || !portHex) continue;
    out.push({
      proto,
      v6,
      addr: v6 ? _ipv6(ipHex) : _ipv4(ipHex),
      port: parseInt(portHex, 16),
      inode: f[9],
    });
  }
}

// inode -> process name, scanning /proc/<pid>/fd until every
// wanted inode is matched (root-owned fds stay unresolved).
function _owners(inodes) {
  const map = new Map();
  if (inodes.size === 0) return map;
  const remaining = new Set(inodes);
  let dirs = null;
  try {
    dirs = Gio.File.new_for_path("/proc").enumerate_children(
      "standard::name",
      Gio.FileQueryInfoFlags.NONE,
      null,
    );
  } catch (e) {
    return map;
  }
  let info;
  while ((info = dirs.next_file(null)) !== null && remaining.size > 0) {
    const pid = info.get_name();
    if (!/^\d+$/.test(pid)) continue;
    let fds = null;
    try {
      fds = Gio.File.new_for_path(`/proc/${pid}/fd`).enumerate_children(
        "standard::symlink-target",
        Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
        null,
      );
    } catch (e) {
      continue;
    }
    let fi,
      name = null;
    while ((fi = fds.next_file(null)) !== null) {
      const m = (fi.get_symlink_target() ?? "").match(/^socket:\[(\d+)\]$/);
      if (m && remaining.has(m[1])) {
        if (name === null) name = _readText(`/proc/${pid}/comm`).trim();
        map.set(m[1], name || `pid ${pid}`);
        remaining.delete(m[1]);
      }
    }
    try {
      fds.close(null);
    } catch (e) {}
  }
  try {
    dirs.close(null);
  } catch (e) {}
  return map;
}

export function scanListeningPorts() {
  const rows = [];
  _parseNet(_readText("/proc/net/tcp"), "TCP", false, rows);
  _parseNet(_readText("/proc/net/tcp6"), "TCP", true, rows);
  _parseNet(_readText("/proc/net/udp"), "UDP", false, rows);
  _parseNet(_readText("/proc/net/udp6"), "UDP", true, rows);
  const owners = _owners(new Set(rows.map((r) => r.inode)));
  const out = rows.map((r) => ({
    proto: r.proto,
    addr: r.addr,
    port: r.port,
    v6: r.v6,
    process: owners.get(r.inode) ?? "",
  }));
  out.sort(
    (a, b) =>
      a.port - b.port ||
      a.proto.localeCompare(b.proto) ||
      a.addr.localeCompare(b.addr),
  );
  return out;
}
