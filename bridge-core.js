'use strict';

/**
 * claude-remote-bridge — shared client core.
 *
 * Used by both guest front ends: the terminal client (client.js) and the
 * VS Code extension. It has no UI code and no npm dependencies.
 *
 *   Connection  encrypted requests to the host (the access code is the key and is never sent)
 *   Project     the local project: file tree, safe reads, text search, safe writes
 *   Session     one conversation, including automatic exploration: Claude sees the
 *               file tree, asks for files or searches, and this module answers those
 *               requests from the local disk before Claude gives its final answer
 *   diffLines   line diff + hunks for previewing proposed changes
 *   runCommand  run an approved shell command in the project folder
 *
 * Safety rules that every front end inherits from here:
 *   - nothing outside the project folder is read or written, symlinks included
 *   - .git, node_modules, .env and other secret files are never read, listed or written
 *   - reads happen automatically, but writes and commands only after the user approves them
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

// ---------------------------------------------------------------------------
// Limits and file rules
// ---------------------------------------------------------------------------

const LIMITS = {
  fileBytes: 200 * 1024, // largest file that is ever read
  requestFileBytes: 3 * 1024 * 1024, // file contents per request
  workingSetFiles: 60, // files kept in Claude's view across a conversation
  treeEntries: 5000,
  maxRounds: 6, // exploration rounds per message (the last one must answer)
  historyEntries: 40,
  historyEntryChars: 20_000,
  notesChars: 150_000, // search results and other client notes per request
  searchMatches: 40, // per search
  searchScanBytes: 64 * 1024 * 1024, // total bytes scanned per search
  commandTailChars: 6_000, // command output Claude gets to see
  requestTimeoutMs: 10 * 60 * 1000, // includes waiting in the host's queue
};

/** Never read, listed or written, wherever they appear in a path. */
const IGNORED_DIRS = new Set(['node_modules', '.git', '.hg', '.svn']);
/** Left out of the project tree (build output, caches). Files inside can still be read by name. */
const TREE_SKIP_DIRS = new Set([
  '.next', '.nuxt', '.cache', '.venv', 'venv', '__pycache__', 'dist', 'build', 'coverage', 'target',
  '.turbo', '.parcel-cache', '.gradle', '.idea', '.vscode-test', 'out',
]);
/** Secrets: never sent to the host and never overwritten. */
const SECRET_FILE = /^(\.env(\..*)?|\.bridge\.json|\.npmrc|\.netrc|\.pgpass|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|.*\.(pem|key|p12|pfx|keystore|jks))$/i;
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.avif', '.tiff', '.psd',
  '.mp3', '.wav', '.ogg', '.flac', '.mp4', '.mov', '.avi', '.mkv', '.webm',
  '.zip', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar', '.tar', '.jar', '.war', '.vsix',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.o', '.a', '.class', '.pyc', '.wasm', '.node',
  '.woff', '.woff2', '.ttf', '.otf', '.eot', '.sqlite', '.db', '.lockb', '.dat', '.dmg', '.iso',
]);

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * Remove terminal control sequences from text that came over the network, so a
 * response can never repaint a terminal or disguise what a command really does.
 */
function stripControl(text) {
  return String(text)
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '') // CSI sequences (colors, cursor moves)
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)?/g, '') // OSC sequences (titles, hyperlinks)
    .replace(/[\x00-\x08\x0b-\x1f\x7f\x9b]/g, ''); // other control chars (keeps \t and \n)
}

/** "https://host/path/" -> "https://host/path"; null when it is not an http(s) URL. */
function normalizeUrl(raw) {
  let url;
  try {
    url = new URL(String(raw).trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return url.origin + url.pathname.replace(/\/+$/, '');
}

const toPosix = (p) => p.split(path.sep).join('/');
const lineCount = (text) => (text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0));

// ---------------------------------------------------------------------------
// Encryption — must match server.js
//
//   key      = scrypt(accessCode, KEY_SALT) -> 32 bytes
//   envelope = { v: 2, iv, ct, tag }   AES-256-GCM, base64 fields
//   request  : plaintext { ts, body }, additional data "req:<route>"
//   reply    : plaintext result (or { error }), additional data "res:<request iv>"
// ---------------------------------------------------------------------------

const PROTOCOL_VERSION = 2;
const KEY_SALT = 'claude-remote-bridge/v2';

function deriveKey(accessCode) {
  return crypto.scryptSync(String(accessCode).trim(), KEY_SALT, 32);
}

function seal(key, value, aad) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return {
    v: PROTOCOL_VERSION,
    iv: iv.toString('base64'),
    ct: ct.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

/** Decrypt an envelope. Throws when the key, the data or the additional data do not match. */
function unseal(key, envelope, aad) {
  const shaped =
    envelope &&
    typeof envelope === 'object' &&
    typeof envelope.iv === 'string' &&
    typeof envelope.ct === 'string' &&
    typeof envelope.tag === 'string';
  if (!shaped) throw new Error('malformed envelope');
  const iv = Buffer.from(envelope.iv, 'base64');
  const tag = Buffer.from(envelope.tag, 'base64');
  if (iv.length !== 12 || tag.length !== 16) throw new Error('malformed envelope');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(Buffer.from(envelope.ct, 'base64')), decipher.final()]);
  return JSON.parse(plain.toString('utf8'));
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

/** Error for a plain (non-encrypted) error reply from the bridge, with its kind. */
function httpError(status, data) {
  const code = data && data.error && data.error.code ? String(data.error.code) : '';
  const kind = code === 'unauthorized' || code === 'replayed_request' ? 'code'
    : code === 'stale_request' ? 'clock'
    : code === 'unsupported_client' ? 'version'
    : status === 429 ? 'busy'
    : 'host';
  return bridgeError(describeHttpError(status, data), kind);
}

function describeHttpError(status, data) {
  const code = data && data.error && data.error.code ? String(data.error.code) : '';
  const message = data && data.error && data.error.message ? stripControl(data.error.message) : '';
  if (code === 'unauthorized') return 'The host rejected the access code. Enter the current access code.';
  if (code === 'unsupported_client') return 'The host runs an older or newer bridge version. Ask the host which client to install.';
  if (code === 'stale_request') return 'The host rejected the request because the clocks differ too much. Check the date and time on this machine.';
  if (status === 413) return 'Request too large: the files in view exceed the host limit. Start a new chat or drop some files.';
  if (status === 429) return 'The host is busy (queue full). Try again in a moment.';
  return message || `Bridge returned HTTP ${status}.`;
}

/**
 * An error that says what the user can do about it. `kind`:
 *   'link'    the link no longer leads to the bridge (tunnel gone, host offline) → enter a new link
 *   'code'    the access code is wrong                                          → enter the access code again
 *   'network' this machine has no connection, or the host is slow              → retry
 *   'clock' | 'version' | 'busy' | 'host'                                      → see the message
 */
function bridgeError(message, kind) {
  const err = new Error(message);
  err.kind = kind;
  return err;
}

/** True when the user should be asked for a new link and access code. */
function needsReconnect(err) {
  return Boolean(err && (err.kind === 'link' || err.kind === 'code'));
}

const LINK_GONE_CODES = new Set(['ENOTFOUND', 'ECONNREFUSED', 'EHOSTUNREACH', 'ERR_INVALID_URL', 'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID']);

/** Turn fetch / abort / network failures into one readable sentence. */
function describeError(err, url) {
  if (!err) return 'Unknown error.';
  if (err.kind) return err.message;
  if (err.name === 'TimeoutError') return `No answer from ${url}. Is the host's server running?`;
  if (err.cause) {
    const code = err.cause.code || err.cause.message;
    return `Could not reach ${url} (${code}). The host's server may be offline, or the link has changed.`;
  }
  return err.message || String(err);
}

class Connection {
  /** @param {{ url: string, accessCode: string }} options */
  constructor({ url, accessCode }) {
    const normalized = normalizeUrl(url);
    if (!normalized) throw new Error('The link must start with https:// or http://');
    if (!accessCode || !String(accessCode).trim()) throw new Error('The access code is empty.');
    this.url = normalized;
    this.key = deriveKey(accessCode);
  }

  /**
   * Send one encrypted request and return the decrypted reply.
   * Status 200 carries an encrypted reply; any other status is a plain error.
   */
  async request(route, body, signal) {
    if (typeof fetch !== 'function') throw new Error('This needs Node.js 18 or newer (built-in fetch).');
    const envelope = seal(this.key, { ts: Date.now(), body }, `req:${route}`);
    let res;
    let text;
    try {
      res = await fetch(`${this.url}${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(envelope),
        signal,
      });
      text = await res.text(); // may start with keep-alive whitespace; still valid JSON
    } catch (err) {
      if (err && (err.name === 'AbortError' || err.name === 'TimeoutError')) throw err; // Stop button / timeouts
      const code = err && err.cause ? err.cause.code || err.cause.message : err && err.message;
      if (LINK_GONE_CODES.has(code)) {
        throw bridgeError(`Could not reach ${this.url} (${code}). The host's server is offline or the link has changed. Enter the current link.`, 'link');
      }
      throw bridgeError(`Could not reach ${this.url} (${code}). Check your internet connection and try again.`, 'network');
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      // Not our server talking: the tunnel's own error page (530 = Cloudflare has no tunnel behind this link).
      const why = res.status === 530 || res.status === 404 || res.status === 502 || res.status === 503
        ? 'the host stopped or restarted the server, so this link no longer leads to it'
        : 'the host may be offline, or the link has changed';
      throw bridgeError(`The link answered with HTTP ${res.status}, but not from the bridge: ${why}. Enter the current link from the host.`, 'link');
    }
    if (!res.ok) throw httpError(res.status, data);

    let reply;
    try {
      reply = unseal(this.key, data, `res:${envelope.iv}`);
    } catch {
      throw bridgeError('Could not decrypt the reply: the access code is probably wrong. Enter it again.', 'code');
    }
    if (reply && reply.error) throw httpError(200, reply);
    return reply;
  }

  /** Resolves with { ok, busy, queued, ... }; throws a readable Error (with `kind`) when the host cannot be used. */
  async health(timeoutMs = 15_000) {
    try {
      return await this.request('/health', {}, AbortSignal.timeout(timeoutMs));
    } catch (err) {
      if (err.kind) throw err;
      throw bridgeError(describeError(err, this.url), err.name === 'TimeoutError' ? 'link' : 'network');
    }
  }
}

// ---------------------------------------------------------------------------
// .gitignore (root file only; negations are not supported and simply skipped)
// ---------------------------------------------------------------------------

function globToRegExp(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        out += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return out;
}

/** Returns (relPath, isDirectory) => boolean. */
function loadGitignore(root) {
  let text = '';
  try {
    text = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
  } catch {
    return () => false;
  }
  const rules = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    const dirOnly = line.endsWith('/');
    if (dirOnly) line = line.slice(0, -1);
    const anchored = line.includes('/');
    if (line.startsWith('/')) line = line.slice(1);
    if (!line) continue;
    const body = globToRegExp(line);
    // Anchored: match from the project root. Otherwise: match any single path segment.
    const regex = anchored ? new RegExp(`^${body}(/.*)?$`) : new RegExp(`(^|/)${body}(/.*)?$`);
    rules.push({ regex, dirOnly });
  }
  return (rel, isDirectory) => rules.some((rule) => (!rule.dirOnly || isDirectory) && rule.regex.test(rel));
}

// ---------------------------------------------------------------------------
// Project: everything that touches the local disk
// ---------------------------------------------------------------------------

class Project {
  constructor(root) {
    this.root = path.resolve(root);
    this.realRoot = fs.realpathSync(this.root);
    this.name = path.basename(this.root);
    this.isIgnored = loadGitignore(this.root);
  }

  /** Project-relative posix path, or null when `abs` is outside the project. "" is the root itself. */
  relativeOf(abs) {
    const rel = path.relative(this.root, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return toPosix(rel);
  }

  /** Resolve a path given by Claude or the user. Returns { abs, rel } or { error }. */
  locate(rawPath) {
    if (typeof rawPath !== 'string' || !rawPath.trim() || rawPath.includes('\0')) return { error: 'invalid path' };
    const abs = path.resolve(this.root, rawPath.trim().replace(/\\/g, '/'));
    const rel = this.relativeOf(abs);
    if (rel === null) return { error: 'outside the project folder' };
    if (rel === '') return { error: 'is the project folder itself' };
    if (rel.split('/').some((segment) => IGNORED_DIRS.has(segment))) return { error: 'inside an ignored folder' };
    return { abs, rel };
  }

  /** True when the nearest existing ancestor of `abs` (after resolving symlinks) is inside the project. */
  staysInside(abs) {
    let current = abs;
    while (!fs.existsSync(current)) {
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    try {
      const real = fs.realpathSync(current);
      return real === this.realRoot || real.startsWith(this.realRoot + path.sep);
    } catch {
      return false;
    }
  }

  /** Why a file cannot be read, or null when it can. */
  readRejection(rel) {
    const target = this.locate(rel);
    if (target.error) return target.error;
    const { abs } = target;
    if (SECRET_FILE.test(path.basename(abs))) return 'secret file — never shared';
    if (BINARY_EXTENSIONS.has(path.extname(abs).toLowerCase())) return 'binary file';

    let st;
    try {
      st = fs.lstatSync(abs);
    } catch {
      return 'not found';
    }
    if (st.isSymbolicLink()) return 'symlink';
    if (st.isDirectory()) return 'is a folder';
    if (!st.isFile()) return 'not a regular file';
    if (!this.staysInside(abs)) return 'resolves outside the project folder';
    if (st.size > LIMITS.fileBytes) return `larger than ${LIMITS.fileBytes / 1024} KB`;

    // Content sniff: a NUL byte in the first 8 KB means "not text".
    try {
      const fd = fs.openSync(abs, 'r');
      try {
        const probe = Buffer.alloc(Math.min(8192, st.size));
        const read = fs.readSync(fd, probe, 0, probe.length, 0);
        if (probe.subarray(0, read).includes(0)) return 'binary file';
      } finally {
        fs.closeSync(fd);
      }
    } catch (err) {
      return `unreadable (${err.code || err.message})`;
    }
    return null;
  }

  /** Returns { path, content, lines } or { path, error }. */
  readFile(rel) {
    const reason = this.readRejection(rel);
    const target = this.locate(rel);
    const shown = target.rel || String(rel);
    if (reason) return { path: shown, error: reason };
    const content = fs.readFileSync(target.abs, 'utf8');
    return { path: target.rel, content, lines: lineCount(content) };
  }

  /**
   * Every listable file in the project, sorted, as posix paths. Skips ignored
   * and build folders, .gitignore matches, secrets, binaries and symlinks.
   */
  scanTree() {
    const paths = [];
    let truncated = false;
    const walk = (absDir, relDir) => {
      if (truncated) return;
      let entries;
      try {
        entries = fs.readdirSync(absDir, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue; // never follow links (loops, escapes)
        const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (IGNORED_DIRS.has(entry.name) || TREE_SKIP_DIRS.has(entry.name) || this.isIgnored(rel, true)) continue;
          walk(path.join(absDir, entry.name), rel);
        } else if (entry.isFile()) {
          if (SECRET_FILE.test(entry.name) || BINARY_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
          if (this.isIgnored(rel, false)) continue;
          if (paths.length >= LIMITS.treeEntries) {
            truncated = true;
            return;
          }
          paths.push(rel);
        }
        if (truncated) return;
      }
    };
    walk(this.root, '');
    return { paths, truncated };
  }

  /** Case-insensitive plain-text search over the given files. Returns { query, matches: [{ path, line, text }], truncated }. */
  search(query, paths) {
    const needle = String(query).toLowerCase();
    const matches = [];
    let scanned = 0;
    let truncated = false;
    if (!needle) return { query, matches, truncated };

    for (const rel of paths) {
      if (matches.length >= LIMITS.searchMatches || scanned > LIMITS.searchScanBytes) {
        truncated = true;
        break;
      }
      const abs = path.join(this.root, rel);
      let text;
      try {
        const st = fs.statSync(abs);
        if (!st.isFile() || st.size > LIMITS.fileBytes) continue;
        scanned += st.size;
        text = fs.readFileSync(abs, 'utf8');
      } catch {
        continue;
      }
      if (!text.toLowerCase().includes(needle)) continue;
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(needle)) {
          matches.push({ path: rel, line: i + 1, text: lines[i].trim().slice(0, 200) });
          if (matches.length >= LIMITS.searchMatches) break;
        }
      }
    }
    return { query, matches, truncated };
  }

  /** Decide whether a proposed write is allowed. Returns { abs, rel } or { error }. */
  writeTarget(rawPath) {
    const target = this.locate(rawPath);
    if (target.error) return target;
    if (SECRET_FILE.test(path.basename(target.abs))) return { error: 'protected file' };
    if (!this.staysInside(target.abs)) return { error: 'resolves outside the project folder (symlink)' };
    try {
      if (fs.existsSync(target.abs)) {
        const st = fs.lstatSync(target.abs);
        if (st.isSymbolicLink()) return { error: 'is a symlink' };
        if (!st.isFile()) return { error: 'not a regular file' };
      }
    } catch (err) {
      return { error: err.message };
    }
    return target;
  }

  /**
   * Preview proposed file updates. Each item:
   *   { path, status: 'new'|'modified'|'unchanged'|'blocked', error?, previous, content, added, removed }
   */
  planUpdates(updates) {
    return updates.map((update) => {
      const target = this.writeTarget(update.path);
      if (target.error) {
        return { path: stripControl(update.path), status: 'blocked', error: target.error, previous: null, content: update.content, added: 0, removed: 0 };
      }
      let previous = null;
      try {
        if (fs.existsSync(target.abs)) previous = fs.readFileSync(target.abs, 'utf8');
      } catch {
        previous = null;
      }
      const status = previous === null ? 'new' : previous === update.content ? 'unchanged' : 'modified';
      const diff = diffLines(previous || '', update.content);
      return { path: target.rel, status, previous, content: update.content, added: diff.added, removed: diff.removed };
    });
  }

  /**
   * Write one approved file (re-validated right before writing).
   * Returns { path, ok, error?, previous } — `previous` is the old content (null for a new file), for undo.
   */
  writeFile(rel, content) {
    const target = this.writeTarget(rel);
    if (target.error) return { path: rel, ok: false, error: target.error };
    try {
      let previous = null;
      if (fs.existsSync(target.abs)) previous = fs.readFileSync(target.abs, 'utf8');
      fs.mkdirSync(path.dirname(target.abs), { recursive: true });
      fs.writeFileSync(target.abs, content);
      return { path: target.rel, ok: true, previous };
    } catch (err) {
      return { path: target.rel, ok: false, error: err.message };
    }
  }

  /**
   * Undo a write: put `previous` back (or delete the file when it was new).
   * Refuses with { conflict: true } when the file changed since it was written, unless `force`.
   */
  revertWrite(rel, previous, written, { force = false } = {}) {
    const target = this.writeTarget(rel);
    if (target.error) return { path: rel, ok: false, error: target.error };
    try {
      const exists = fs.existsSync(target.abs);
      const current = exists ? fs.readFileSync(target.abs, 'utf8') : null;
      if (!force && current !== written) return { path: target.rel, ok: false, conflict: true, error: 'changed since it was written' };
      if (previous === null) {
        if (exists) fs.unlinkSync(target.abs);
      } else {
        fs.mkdirSync(path.dirname(target.abs), { recursive: true });
        fs.writeFileSync(target.abs, previous);
      }
      return { path: target.rel, ok: true };
    } catch (err) {
      return { path: target.rel, ok: false, error: err.message };
    }
  }
}

// ---------------------------------------------------------------------------
// Line diff (for previews only — files are always written whole)
// ---------------------------------------------------------------------------

/**
 * Returns { lines: [{ type: ' '|'+'|'-', text, oldNo, newNo }], added, removed }.
 * Common prefix/suffix are trimmed first; the middle uses an LCS table when it is
 * small enough, otherwise it is shown as "all removed, then all added".
 */
function diffLines(oldText, newText) {
  const a = oldText === '' ? [] : oldText.replace(/\n$/, '').split('\n');
  const b = newText === '' ? [] : newText.replace(/\n$/, '').split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const out = [];
  for (let i = 0; i < start; i++) out.push({ type: ' ', text: a[i], oldNo: i + 1, newNo: i + 1 });

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const n = midA.length;
  const m = midB.length;
  let middle = [];
  if (n * m <= 4_000_000 && n > 0 && m > 0) {
    const width = m + 1;
    const table = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        table[i * width + j] = midA[i] === midB[j] ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) {
        middle.push({ type: ' ', i, j });
        i++;
        j++;
      } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
        middle.push({ type: '-', i });
        i++;
      } else {
        middle.push({ type: '+', j });
        j++;
      }
    }
    while (i < n) middle.push({ type: '-', i: i++ });
    while (j < m) middle.push({ type: '+', j: j++ });
  } else {
    middle = [...midA.map((_, i) => ({ type: '-', i })), ...midB.map((_, j) => ({ type: '+', j }))];
  }

  let added = 0;
  let removed = 0;
  for (const op of middle) {
    if (op.type === ' ') out.push({ type: ' ', text: midA[op.i], oldNo: start + op.i + 1, newNo: start + op.j + 1 });
    else if (op.type === '-') {
      removed++;
      out.push({ type: '-', text: midA[op.i], oldNo: start + op.i + 1, newNo: null });
    } else {
      added++;
      out.push({ type: '+', text: midB[op.j], oldNo: null, newNo: start + op.j + 1 });
    }
  }
  const shift = endB - endA;
  for (let i = endA; i < a.length; i++) out.push({ type: ' ', text: a[i], oldNo: i + 1, newNo: i + 1 + shift });
  return { lines: out, added, removed };
}

/** Group diff lines into hunks with `context` unchanged lines around each change. Returns [{ lines }]. */
function diffHunks(diff, context = 3) {
  const lines = diff.lines;
  const ranges = [];
  lines.forEach((line, i) => {
    if (line.type === ' ') return;
    const from = Math.max(0, i - context);
    const to = Math.min(lines.length - 1, i + context);
    const last = ranges[ranges.length - 1];
    if (last && from <= last.to + 1) last.to = Math.max(last.to, to);
    else ranges.push({ from, to });
  });
  return ranges.map((r) => ({ lines: lines.slice(r.from, r.to + 1) }));
}

// ---------------------------------------------------------------------------
// Running an approved command
// ---------------------------------------------------------------------------

/**
 * Run one shell command in `cwd`. The bridge settings are removed from its
 * environment. Resolves with { code, signal, error?, tail }.
 *   stdin:    'inherit' for a terminal front end, 'ignore' otherwise
 *   detached: true to run it in its own process group so `signal` can stop the whole tree
 */
function runCommand(command, { cwd, onOutput = () => {}, signal, stdin = 'ignore', detached = false } = {}) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    delete env.BRIDGE_URL;
    delete env.ACCESS_CODE;

    let tail = '';
    let child;
    try {
      child = spawn(command, {
        cwd,
        shell: true,
        env,
        stdio: [stdin, 'pipe', 'pipe'],
        detached: detached && process.platform !== 'win32',
        windowsHide: true,
      });
    } catch (err) {
      resolve({ code: null, signal: null, error: err.message, tail });
      return;
    }

    const capture = (stream) => (chunk) => {
      const text = chunk.toString('utf8');
      tail = (tail + text).slice(-LIMITS.commandTailChars);
      onOutput(text, stream);
    };
    child.stdout.on('data', capture('stdout'));
    child.stderr.on('data', capture('stderr'));

    const stop = () => {
      try {
        if (detached && process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM');
        else child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
    };
    if (signal) {
      if (signal.aborted) stop();
      else signal.addEventListener('abort', stop, { once: true });
    }

    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      if (signal) signal.removeEventListener('abort', stop);
      resolve({ ...result, tail });
    };
    child.on('error', (err) => finish({ code: null, signal: null, error: err.message }));
    child.on('close', (code, sig) => finish({ code, signal: sig }));
  });
}

/** One-line summary of a command result, for the UI and for Claude. */
function describeCommandResult(result) {
  if (result.error) return `failed to start: ${result.error}`;
  if (result.signal) return `stopped (${result.signal})`;
  return `exit code ${result.code}`;
}

// ---------------------------------------------------------------------------
// Session: one conversation, with automatic exploration
// ---------------------------------------------------------------------------

/** Accept only the documented response shape; ignore anything else the server sent. */
function sanitizeResponse(data) {
  const result = { explanation: '', fileUpdates: [], commands: [], readFiles: [], searches: [], todos: [], questions: [], usage: null };
  if (!data || typeof data !== 'object') return result;
  if (typeof data.explanation === 'string') result.explanation = data.explanation;

  if (Array.isArray(data.fileUpdates)) {
    const byPath = new Map(); // last update for a path wins
    for (const update of data.fileUpdates) {
      if (update && typeof update.path === 'string' && typeof update.content === 'string') {
        byPath.set(update.path, { path: update.path, content: update.content });
      }
    }
    result.fileUpdates = [...byPath.values()];
  }
  const strings = (list) => (Array.isArray(list) ? list.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()) : []);
  result.commands = strings(data.commands);
  result.readFiles = [...new Set(strings(data.readFiles))];
  result.searches = [...new Set(strings(data.searches))];

  if (Array.isArray(data.todos)) {
    for (const todo of data.todos.slice(0, 30)) {
      if (!todo || typeof todo.content !== 'string' || !todo.content.trim()) continue;
      const status = ['pending', 'in_progress', 'completed'].includes(todo.status) ? todo.status : 'pending';
      result.todos.push({ content: stripControl(todo.content).slice(0, 300), status });
    }
  }
  if (Array.isArray(data.questions)) {
    for (const q of data.questions.slice(0, 4)) {
      if (!q || typeof q.question !== 'string' || !Array.isArray(q.options)) continue;
      const options = q.options
        .filter((o) => o && typeof o.label === 'string' && o.label.trim())
        .slice(0, 6)
        .map((o) => ({ label: stripControl(o.label).trim().slice(0, 100), description: typeof o.description === 'string' ? stripControl(o.description).trim().slice(0, 300) : '' }));
      if (options.length < 2) continue;
      result.questions.push({
        question: stripControl(q.question).trim().slice(0, 500),
        header: typeof q.header === 'string' ? stripControl(q.header).trim().slice(0, 24) : '',
        multiSelect: q.multiSelect === true,
        options,
      });
    }
  }
  if (data.usage && typeof data.usage === 'object') {
    const num = (v) => (Number.isFinite(v) && v >= 0 ? v : 0);
    result.usage = {
      durationMs: num(data.usage.durationMs),
      inputTokens: num(data.usage.inputTokens),
      outputTokens: num(data.usage.outputTokens),
      costUsd: num(data.usage.costUsd),
      model: typeof data.usage.model === 'string' ? stripControl(data.usage.model).slice(0, 60) : '',
    };
  }
  return result;
}

/** Split "src/a.js#L10-20" into { path: "src/a.js", from: 10, to: 20 }; no fragment -> from/to null. */
function parseMention(token) {
  const m = /^(.*?)#L(\d+)(?:-L?(\d+))?$/.exec(token);
  if (!m) return { path: token, from: null, to: null };
  const from = Number(m[2]);
  const to = m[3] ? Math.max(from, Number(m[3])) : from;
  return { path: m[1], from, to };
}

/** "@path" mentions in a message ("user@example.com" is not one). Trailing punctuation is tolerated. */
function findMentions(text) {
  const found = [];
  for (const match of String(text).matchAll(/(?:^|\s)@(\S+)/g)) found.push(match[1]);
  return found;
}

class Session {
  /**
   * @param {{ connection: Connection, project: Project, maxRounds?: number }} options
   */
  constructor({ connection, project, maxRounds = LIMITS.maxRounds }) {
    this.connection = connection;
    this.project = project;
    this.maxRounds = maxRounds;
    this.clear();
  }

  /** Forget the conversation and every file in view. */
  clear() {
    this.history = [];
    this.workingSet = []; // project-relative paths Claude currently sees, most recent last
    this.pendingReports = []; // outcomes (applied / declined / command output) not yet told to Claude
    this.todos = []; // Claude's latest task list
  }

  /** Everything needed to continue this conversation later (no file contents). */
  toJSON() {
    return { history: this.history, workingSet: this.workingSet, pendingReports: this.pendingReports, todos: this.todos };
  }

  /** Continue a conversation saved with toJSON(). */
  restore(data) {
    this.clear();
    if (!data || typeof data !== 'object') return;
    const strings = (list) => (Array.isArray(list) ? list.filter((x) => typeof x === 'string') : []);
    if (Array.isArray(data.history)) {
      this.history = data.history
        .filter((t) => t && (t.role === 'user' || t.role === 'assistant') && typeof t.content === 'string')
        .slice(-LIMITS.historyEntries);
    }
    this.workingSet = strings(data.workingSet).slice(-LIMITS.workingSetFiles);
    this.pendingReports = strings(data.pendingReports);
    if (Array.isArray(data.todos)) this.todos = data.todos.filter((t) => t && typeof t.content === 'string');
  }

  /** Put a file in Claude's view (moves it to the "most recent" end). */
  addToView(rel) {
    this.workingSet = this.workingSet.filter((p) => p !== rel);
    this.workingSet.push(rel);
    if (this.workingSet.length > LIMITS.workingSetFiles) this.workingSet.shift();
  }

  removeFromView(relOrFolder) {
    const prefix = `${relOrFolder.replace(/\/+$/, '')}/`;
    const before = this.workingSet.length;
    this.workingSet = this.workingSet.filter((p) => p !== relOrFolder && !p.startsWith(prefix));
    return before - this.workingSet.length;
  }

  /**
   * While a request is open, ask the host every few seconds where it stands, and
   * report changes as { type: 'queue', state: 'queued'|'running', ahead }.
   * Quiet for fast answers (first check after 2.5s). Returns a function that stops it.
   */
  watchQueue(ticket, onEvent, signal) {
    let last = '';
    let stopped = false;
    let timer = null;
    const check = async () => {
      if (stopped || (signal && signal.aborted)) return;
      try {
        const health = await this.connection.request('/health', { ticket }, AbortSignal.timeout(8_000));
        const status = health && health.request;
        if (!stopped && status && (status.state === 'queued' || status.state === 'running')) {
          const key = `${status.state}:${status.ahead}`;
          if (key !== last) {
            last = key;
            onEvent({ type: 'queue', state: status.state, ahead: status.ahead || 0 });
          }
        }
      } catch {
        /* status is best effort; the request itself reports real errors */
      }
      if (!stopped) timer = setTimeout(check, 4_000);
    };
    timer = setTimeout(check, 2_500);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }

  /** Tell Claude, with the next message, what happened to its proposals. */
  report(text) {
    if (text) this.pendingReports.push(text);
  }

  remember(role, content) {
    let text = String(content);
    if (text.length > LIMITS.historyEntryChars) text = `${text.slice(0, LIMITS.historyEntryChars)}\n[…truncated]`;
    this.history.push({ role, content: text });
    if (this.history.length > LIMITS.historyEntries) this.history = this.history.slice(-LIMITS.historyEntries);
  }

  /**
   * Attach @mentions from a message. Returns { added: [rel], skipped: [{ path, reason }], missing: [token] }.
   * A mention of a folder adds the folder's files from the tree.
   */
  attachMentions(text, treePaths) {
    const added = [];
    const skipped = [];
    const missing = [];
    const ranges = []; // "src/a.js lines 10-20"
    for (const token of findMentions(text)) {
      const candidates = [token, token.replace(/[.,;:!?)\]}'"]+$/, '')];
      let handled = false;
      for (const raw of candidates) {
        if (!raw) continue;
        const mention = parseMention(raw);
        const candidate = mention.path;
        if (!candidate) continue;
        const target = this.project.locate(candidate);
        if (target.error || !fs.existsSync(target.abs)) continue;
        handled = true;
        let isDir = false;
        try {
          isDir = fs.lstatSync(target.abs).isDirectory();
        } catch {
          /* treated as a file */
        }
        if (isDir) {
          const prefix = `${target.rel}/`;
          for (const rel of treePaths.filter((p) => p.startsWith(prefix)).slice(0, 40)) {
            this.addToView(rel);
            added.push(rel);
          }
        } else {
          const reason = this.project.readRejection(target.rel);
          if (reason) skipped.push({ path: target.rel, reason });
          else {
            this.addToView(target.rel);
            added.push(target.rel);
            if (mention.from) ranges.push(`${target.rel} line${mention.to > mention.from ? `s ${mention.from}-${mention.to}` : ` ${mention.from}`}`);
          }
        }
        break;
      }
      if (!handled) missing.push(token);
    }
    return { added, skipped, missing, ranges };
  }

  /** Read the working set fresh from disk, newest first, within the per-request budget. */
  collectFiles() {
    const files = [];
    let total = 0;
    const dropped = [];
    for (const rel of [...this.workingSet].reverse()) {
      const file = this.project.readFile(rel);
      if (file.error) {
        this.workingSet = this.workingSet.filter((p) => p !== rel);
        dropped.push(`${rel} (${file.error})`);
        continue;
      }
      const size = Buffer.byteLength(file.content);
      if (total + size > LIMITS.requestFileBytes) {
        dropped.push(`${rel} (over the per-request size budget)`);
        continue;
      }
      total += size;
      files.push({ path: file.path, content: file.content });
    }
    return { files: files.reverse(), dropped };
  }

  /**
   * Send one user message and let Claude explore until it answers.
   *
   * onEvent receives:
   *   { type: 'mentions', added, skipped, missing }
   *   { type: 'thinking', round, maxRounds }
   *   { type: 'plan', text }                      Claude's short "what I'm checking" line
   *   { type: 'read', path, lines } / { type: 'read', path, error }
   *   { type: 'search', query, count, truncated }
   *
   * Resolves with { explanation, fileUpdates, commands, explored: { reads, searches }, rounds }.
   * `options.extraFiles` are put in view first (e.g. the file open in the editor).
   * `options.editorContext` is a note about the user's editor (open file, selection).
   */
  async send(prompt, { onEvent = () => {}, signal, extraFiles = [], editorContext = '', model = '', effort = '', mode = 'default', skills = [] } = {}) {
    const skillPayload = skills.map((k) => ({ name: k.name, instructions: k.instructions }));
    const planning = mode === 'plan';
    const compacting = mode === 'compact';
    const maxRounds = compacting ? 1 : this.maxRounds;
    const tree = this.project.scanTree();
    onEvent({ type: 'tree', count: tree.paths.length, truncated: tree.truncated });

    for (const rel of extraFiles) if (!this.project.readRejection(rel)) this.addToView(rel);
    const mentions = this.attachMentions(prompt, tree.paths);
    if (mentions.added.length || mentions.skipped.length || mentions.missing.length) onEvent({ type: 'mentions', ...mentions });

    // Outcomes of the previous answer go into the history before the new message.
    const history = [...this.history];
    if (this.pendingReports.length > 0) history.push({ role: 'user', content: `[client report]\n${this.pendingReports.join('\n')}` });

    const extras = [];
    if (mentions.ranges.length) extras.push(`[mentioned lines] ${mentions.ranges.join('; ')}`);
    if (editorContext) extras.push(`[editor] ${editorContext}`);
    const fullPrompt = extras.length ? `${prompt}\n\n${extras.join('\n')}` : prompt;
    const explored = { reads: [], searches: [] };
    const usage = { durationMs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, model: '' };
    const trail = []; // what Claude did in earlier rounds of this message
    const searchNotes = [];

    for (let round = 1; ; round++) {
      const tree2 = round === 1 ? tree : this.project.scanTree();
      const { files, dropped } = this.collectFiles();

      const notes = [];
      if (tree2.truncated) notes.push(`The project tree was cut off after ${LIMITS.treeEntries} files.`);
      if (trail.length > 0) notes.push('Earlier in this message:', ...trail);
      if (searchNotes.length > 0) notes.push(...searchNotes);
      if (dropped.length > 0) notes.push(`Not included: ${dropped.join(', ')}`);
      if (this.todos.length > 0) notes.push('Current task list:', ...this.todos.map((t) => `- [${t.status}] ${t.content}`));
      notes.push(
        round >= maxRounds
          ? 'You are out of exploration rounds. ANSWER now with what you have (readFiles and searches will be ignored).'
          : `Exploration round ${round} of ${maxRounds}.`
      );
      let context = notes.join('\n');
      if (context.length > LIMITS.notesChars) context = `${context.slice(0, LIMITS.notesChars)}\n[…notes truncated]`;

      onEvent({ type: 'thinking', round, maxRounds });
      const ticket = crypto.randomBytes(12).toString('hex');
      const stopWatching = this.watchQueue(ticket, onEvent, signal);
      let raw;
      try {
        raw = await this.connection.request(
          '/ask',
          { prompt: fullPrompt, files, history, tree: tree2.paths, context, model, effort, mode, skills: skillPayload, ticket },
          signal
        );
      } finally {
        stopWatching();
      }
      const response = sanitizeResponse(raw);
      if (response.usage) {
        usage.durationMs += response.usage.durationMs;
        usage.inputTokens += response.usage.inputTokens;
        usage.outputTokens += response.usage.outputTokens;
        usage.costUsd += response.usage.costUsd;
        usage.model = response.usage.model || usage.model;
      }
      if (planning || compacting) {
        // These modes never change anything, whatever the model returned.
        response.fileUpdates = [];
        response.commands = [];
      }

      const wantsMore = response.readFiles.length > 0 || response.searches.length > 0;
      const isFinal = !wantsMore || round >= maxRounds || response.fileUpdates.length > 0 || response.commands.length > 0 || response.questions.length > 0;

      if (!isFinal) {
        if (response.explanation.trim()) onEvent({ type: 'plan', text: response.explanation.trim() });
        const step = [];
        if (response.explanation.trim()) step.push(`- You said: ${response.explanation.trim().slice(0, 500)}`);

        const readOk = [];
        for (const rel of response.readFiles) {
          const file = this.project.readFile(rel);
          if (file.error) {
            onEvent({ type: 'read', path: file.path, error: file.error });
            step.push(`- Could not read ${file.path}: ${file.error}`);
          } else {
            this.addToView(file.path);
            explored.reads.push(file.path);
            readOk.push(file.path);
            onEvent({ type: 'read', path: file.path, lines: file.lines });
          }
        }
        if (readOk.length) step.push(`- Read (now in <project_files>): ${readOk.join(', ')}`);

        for (const query of response.searches) {
          const result = this.project.search(query, tree2.paths);
          explored.searches.push(query);
          onEvent({ type: 'search', query, count: result.matches.length, truncated: result.truncated });
          const lines = result.matches.map((m) => `${m.path}:${m.line}: ${m.text}`);
          searchNotes.push(
            `<search query=${JSON.stringify(query)} matches="${result.matches.length}${result.truncated ? '+' : ''}">`,
            ...(lines.length ? lines : ['(no matches)']),
            '</search>'
          );
        }
        trail.push(...step);
        continue;
      }

      if (compacting) {
        // Replace the whole history with Claude's own summary of it.
        this.history = [];
        this.pendingReports = [];
        this.remember('user', `[summary of the earlier conversation]\n${response.explanation}`);
        this.remember('assistant', 'Understood. I will continue from this summary.');
        return { explanation: response.explanation, fileUpdates: [], commands: [], todos: this.todos, explored, rounds: round, usage };
      }

      if (response.todos.length > 0 || planning) this.todos = response.todos;
      else if (this.todos.length && this.todos.every((t) => t.status === 'completed')) this.todos = [];

      // Final answer: record the exchange.
      if (this.pendingReports.length > 0) {
        this.remember('user', `[client report]\n${this.pendingReports.join('\n')}`);
        this.pendingReports = [];
      }
      this.remember('user', planning ? `[plan mode] ${prompt}` : prompt);
      const summary = [response.explanation];
      if (explored.reads.length) summary.push(`[Read: ${[...new Set(explored.reads)].join(', ')}]`);
      if (response.fileUpdates.length) summary.push(`[Proposed file updates: ${response.fileUpdates.map((u) => u.path).join(', ')}]`);
      if (response.commands.length) summary.push(`[Proposed commands: ${response.commands.join(' ; ')}]`);
      for (const q of response.questions) summary.push(`[Asked: ${q.question} Options: ${q.options.map((o) => o.label).join(' / ')}]`);
      if (skills.length) summary.push(`[Skills active: ${skills.map((k) => k.name).join(', ')}]`);
      this.remember('assistant', summary.filter(Boolean).join('\n'));

      return {
        explanation: response.explanation,
        fileUpdates: response.fileUpdates,
        commands: response.commands,
        questions: response.questions,
        todos: this.todos,
        explored,
        rounds: round,
        usage,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Skills: named instruction sets the user can switch on (several at once)
// ---------------------------------------------------------------------------

const SKILL_LIMIT_CHARS = 40_000;

/** Skills that ship with the client. */
const BUILTIN_SKILLS = [
  {
    name: 'code-review',
    description: 'Review code for bugs, risks and readability, ranked by severity',
    instructions: `Act as a careful code reviewer.
- Read the relevant code first (explore as needed). If the user names files or a change, focus there; otherwise review the files most central to their question.
- Report findings ranked by severity: bugs and data loss first, then security, then error handling and edge cases, then readability and maintainability.
- For each finding give the file and line, what goes wrong in a concrete scenario, and a fix.
- Do not pad the review with style nits or praise. If something is fine, say so in one line.
- Only propose file changes if the user asked for fixes.`,
  },
  {
    name: 'write-tests',
    description: 'Add tests that follow the project\'s existing test setup',
    instructions: `Write tests.
- First find out how the project tests things: the framework, file naming, folder layout, helpers and how tests are run (package.json scripts, config files). Follow that exactly; do not add a new framework unless there is none.
- Cover the normal path, edge cases (empty, zero, large, invalid input) and error paths. Each test checks one behaviour and has a descriptive name.
- Do not change the code under test, unless a test exposes a real bug: then say so and fix it separately.
- Finish by proposing the command that runs the new tests.`,
  },
  {
    name: 'explain',
    description: 'Explain code clearly for someone new to the project',
    instructions: `Explain for a developer who is new to this code.
- Start with a two-sentence summary of what it does and why it exists.
- Then walk through how it works in the order things happen, naming the files and functions involved.
- Point out non-obvious parts: hidden assumptions, side effects, tricky edge cases.
- Use short code excerpts only where they help. Do not propose changes.`,
  },
  {
    name: 'refactor',
    description: 'Improve structure without changing behaviour',
    instructions: `Refactor without changing behaviour.
- Identify concrete problems first (duplication, long functions, unclear names, tangled responsibilities) and state them briefly.
- Make small, safe, behaviour-preserving changes. Keep public interfaces unless the user agrees to change them.
- Keep the existing code style. Do not reformat untouched code.
- If tests exist, propose running them afterwards.`,
  },
  {
    name: 'debug',
    description: 'Find the root cause of a bug step by step',
    instructions: `Debug systematically.
- Restate the symptom precisely. Find where it is produced and trace the data backwards to the root cause; do not stop at the first suspicious line.
- State your hypothesis and the evidence from the code. If you cannot confirm it by reading, propose a command or a small logging change that would.
- Fix the root cause, not the symptom, with the smallest change. Mention other places with the same bug.
- Propose a test or command that proves the fix.`,
  },
  {
    name: 'security-review',
    description: 'Look for vulnerabilities: injection, auth, secrets, unsafe input',
    instructions: `Review for security problems.
- Check: injection (SQL, shell, path, template), authentication and authorization gaps, secrets in code or logs, unsafe deserialization, SSRF, XSS, insecure defaults, missing input validation, dependency risks visible in manifests.
- For each issue: the file and line, how an attacker would use it, the impact, and a concrete fix.
- Rank by severity. Do not report theoretical issues without a plausible path to exploit.`,
  },
  {
    name: 'docs',
    description: 'Write or update README, docs and comments',
    instructions: `Write documentation.
- Find out what already exists and match its tone and format.
- Lead with what the reader needs to do (install, configure, use), with copy-pasteable commands. Then explain concepts.
- Keep comments in code about why, not what. Do not comment obvious lines.
- Check every command, option and file name you mention against the code.`,
  },
  {
    name: 'performance',
    description: 'Find and fix slow code and wasted work',
    instructions: `Look for performance problems.
- Find hot paths first (loops over data, request handlers, rendering, I/O). Look for repeated work, N+1 queries, unnecessary allocations, blocking I/O, missing caching or indexes, and quadratic algorithms.
- For each finding estimate how much it matters in practice, and only fix what is worth the added complexity.
- Keep behaviour identical. Propose a way to measure the improvement.`,
  },
];

/** Parse a SKILL.md: optional "---" front matter with name/description, then the instructions. */
function parseSkillFile(text, fallbackName) {
  let body = String(text).replace(/\r/g, '');
  const meta = {};
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(body);
  if (fm) {
    for (const line of fm[1].split('\n')) {
      const m = /^([A-Za-z_-]+)\s*:\s*(.*)$/.exec(line);
      if (m) meta[m[1].toLowerCase()] = m[2].trim().replace(/^["']|["']$/g, '');
    }
    body = body.slice(fm[0].length);
  }
  const name = String(meta.name || fallbackName).replace(/[^\w .:-]/g, '-').slice(0, 64);
  return { name, description: (meta.description || '').slice(0, 200), instructions: body.trim().slice(0, SKILL_LIMIT_CHARS) };
}

/**
 * Every skill the user can switch on:
 *   built-in, then personal (~/.claude/skills/<name>/SKILL.md), then project (<root>/.claude/skills/<name>/SKILL.md).
 * A later source with the same name replaces an earlier one.
 * Returns [{ id, name, description, source, instructions }].
 */
function loadSkills(projectRoot, homeDir = os.homedir()) {
  const byName = new Map();
  for (const skill of BUILTIN_SKILLS) byName.set(skill.name, { ...skill, source: 'built-in' });
  const scan = (dir, source) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const file = path.join(dir, entry.name, 'SKILL.md');
      try {
        const st = fs.lstatSync(file);
        if (!st.isFile() || st.size > 2 * SKILL_LIMIT_CHARS) continue;
        const skill = parseSkillFile(fs.readFileSync(file, 'utf8'), entry.name);
        if (skill.instructions) byName.set(skill.name, { ...skill, source });
      } catch {
        /* no SKILL.md here */
      }
    }
  };
  if (homeDir) scan(path.join(homeDir, '.claude', 'skills'), 'personal');
  if (projectRoot) scan(path.join(projectRoot, '.claude', 'skills'), 'project');
  return [...byName.values()].map((skill) => ({ id: `${skill.source}:${skill.name}`, ...skill }));
}

/** Turn answers to Claude's questions into the follow-up message. answers[i] = { selected: [label], other: string } */
function formatAnswers(questions, answers) {
  const lines = ['[answers]'];
  questions.forEach((q, i) => {
    const a = answers[i] || { selected: [], other: '' };
    const parts = [...(a.selected || [])];
    if (a.other && a.other.trim()) parts.push(a.other.trim());
    lines.push(`${i + 1}. ${q.question}`, `   → ${parts.length ? parts.join('; ') : '(no answer — use your best judgement)'}`);
  });
  return lines.join('\n');
}

module.exports = {
  Connection,
  Project,
  Session,
  diffLines,
  diffHunks,
  runCommand,
  describeCommandResult,
  describeError,
  needsReconnect,
  stripControl,
  normalizeUrl,
  loadSkills,
  formatAnswers,
};
