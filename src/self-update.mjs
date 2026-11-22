// 插件自更新：只信任 HTTPS 清单，校验 SHA-256 后再覆盖插件目录。
// 清单格式（JSON）：
// {
//   "name": "dsh-plugin-local-llm",
//   "version": "0.5.1",
//   "sha256": "<zip 的 sha256>",
//   "zipUrl": "https://.../raw",       // 二进制 zip，或 base64 文本
//   "zipEncoding": "binary" | "base64",
//   "notes": ["..."],
//   "publishedAt": "2026-..."
// }

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import http from 'node:http';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import { DATA_DIR, ensureDir, loadConfig, patchConfig } from './settings.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PLUGIN_ROOT = path.resolve(HERE, '..');
const CACHE_FILE = path.join(DATA_DIR, 'plugin-update.json');
const UPDATE_DIR = path.join(DATA_DIR, 'updates');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const PENDING_FILE = path.join(DATA_DIR, 'plugin-update-pending.json');
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const MAX_ZIP_BYTES = 32 * 1024 * 1024;
const ALLOWED_PREFIXES = ['src/', 'lib/', 'assets/', 'docs/', 'scripts/'];
const ALLOWED_FILES = new Set(['package.json', 'cordis.patch.yml', 'README.md', 'INSTALL.md', 'LICENSE']);

function nowIso() {
  return new Date().toISOString();
}

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, value) {
  ensureDir(path.dirname(file));
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function versionParts(v) {
  const m = String(v || '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+]([0-9A-Za-z.-]+))?/);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] || '' };
}

function newerVersion(candidate, current) {
  const a = versionParts(candidate);
  const b = versionParts(current);
  if (!a || !b) return false;
  if (a.major !== b.major) return a.major > b.major;
  if (a.minor !== b.minor) return a.minor > b.minor;
  if (a.patch !== b.patch) return a.patch > b.patch;
  // 只比较正式版；带预发布后缀的版本不主动推送。
  return false;
}

function assertHttps(url) {
  let parsed;
  try { parsed = new URL(String(url || '')); } catch { throw new Error('更新地址不是合法 URL'); }
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && /^(127\.0\.0\.1|localhost)$/.test(parsed.hostname))) {
    throw new Error('更新地址必须是 HTTPS（本机调试可用 http://127.0.0.1）');
  }
  return parsed.toString();
}

function requestBuffer(url, { timeoutMs = 25000, maxBytes = MAX_MANIFEST_BYTES, redirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(String(url)); } catch { return reject(new Error('更新地址不是合法 URL')); }
    const lib = parsed.protocol === 'http:' ? http : parsed.protocol === 'https:' ? https : null;
    if (!lib) return reject(new Error('更新地址只支持 HTTP/HTTPS'));
    const req = lib.get(parsed, {
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/142.0 Safari/537.36',
        accept: 'application/json,text/plain,*/*',
      },
    }, (res) => {
      const status = res.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
        res.resume();
        if (redirects <= 0) return reject(new Error('更新地址重定向过多'));
        let next;
        try { next = new URL(res.headers.location, parsed).toString(); } catch { return reject(new Error('更新地址重定向不合法')); }
        return resolve(requestBuffer(next, { timeoutMs, maxBytes, redirects: redirects - 1 }));
      }
      if (status < 200 || status >= 300) {
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size <= 2048) chunks.push(c);
        });
        res.on('end', () => reject(new Error('HTTP ' + status + ' ' + Buffer.concat(chunks).toString('utf8').replace(/\s+/g, ' ').slice(0, 160))));
        res.on('error', reject);
        return undefined;
      }
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > maxBytes) {
          req.destroy();
          reject(new Error('更新内容超过大小上限'));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
      return undefined;
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('更新请求超时')));
    req.on('error', reject);
  });
}

async function fetchText(url, timeoutMs = 25000) {
  const buf = await requestBuffer(url, { timeoutMs, maxBytes: MAX_MANIFEST_BYTES });
  return buf.toString('utf8');
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex').toLowerCase();
}

function currentUpdateUrl() {
  const cfg = loadConfig();
  return String(cfg.pluginUpdate?.url || '').trim();
}

function cacheStatus(currentVersion) {
  const cache = readJson(CACHE_FILE, null);
  if (!cache) {
    return {
      ok: true, current: currentVersion, latest: '', available: false,
      checkedAt: '', error: '', url: currentUpdateUrl(), notes: [], pendingRestart: false,
    };
  }
  let pending = readJson(PENDING_FILE, null);
  // 更新已经落盘并重启生效后，pending 标记必须自动清掉；否则页面会一直显示“重启后生效”。
  if (pending && !newerVersion(pending.version, currentVersion)) {
    try { fs.unlinkSync(PENDING_FILE); } catch { /* ignore */ }
    pending = null;
  }
  return {
    ok: true,
    current: currentVersion,
    latest: String(cache.version || ''),
    available: Boolean(cache.version && newerVersion(cache.version, currentVersion)),
    checkedAt: cache.checkedAt || '',
    error: cache.error || '',
    url: currentUpdateUrl(),
    notes: Array.isArray(cache.notes) ? cache.notes : [],
    sha256: cache.sha256 || '',
    pendingRestart: Boolean(pending && pending.version === cache.version && newerVersion(pending.version, currentVersion)),
  };
}

export function pluginUpdateStatus(currentVersion) {
  return cacheStatus(currentVersion);
}

export async function checkPluginUpdate(currentVersion, { force = false } = {}) {
  const url = currentUpdateUrl();
  if (!url) {
    const result = {
      ok: false, current: currentVersion, latest: '', available: false,
      checkedAt: nowIso(), error: '还没有配置插件更新源', url: '', notes: [], pendingRestart: false,
    };
    writeJson(CACHE_FILE, { version: '', checkedAt: result.checkedAt, error: result.error, notes: [] });
    return result;
  }
  const cache = readJson(CACHE_FILE, null);
  if (!force && cache?.checkedAt) {
    const age = Date.now() - Date.parse(cache.checkedAt);
    const hours = Math.max(1, Number(loadConfig().pluginUpdate?.autoCheckHours) || 12);
    if (Number.isFinite(age) && age >= 0 && age < hours * 3600 * 1000) return cacheStatus(currentVersion);
  }
  try {
    const safeUrl = assertHttps(url);
    const text = await fetchText(safeUrl);
    let manifest;
    try { manifest = JSON.parse(text); } catch { throw new Error('更新清单不是合法 JSON'); }
    if (!manifest || typeof manifest !== 'object') throw new Error('更新清单为空');
    if (String(manifest.name || '') !== 'dsh-plugin-local-llm') throw new Error('更新清单的插件名不匹配');
    const version = String(manifest.version || '').trim();
    if (!versionParts(version)) throw new Error('更新清单版本号不合法：' + version);
    const zipUrl = assertHttps(manifest.zipUrl || '');
    const zipEncoding = manifest.zipEncoding === 'base64' ? 'base64' : 'binary';
    const expected = String(manifest.sha256 || '').trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(expected)) throw new Error('更新清单缺少合法 sha256');
    writeJson(CACHE_FILE, {
      version,
      zipUrl,
      zipEncoding,
      sha256: expected,
      notes: Array.isArray(manifest.notes) ? manifest.notes.map(String).slice(0, 12) : [],
      publishedAt: String(manifest.publishedAt || ''),
      checkedAt: nowIso(),
      error: '',
    });
    return cacheStatus(currentVersion);
  } catch (e) {
    writeJson(CACHE_FILE, {
      version: cache?.version || '',
      zipUrl: cache?.zipUrl || '',
      zipEncoding: cache?.zipEncoding || 'binary',
      sha256: cache?.sha256 || '',
      notes: cache?.notes || [],
      checkedAt: nowIso(),
      error: e.message,
    });
    return cacheStatus(currentVersion);
  }
}

/** Minimal ZIP reader: store/deflate, no ZIP64（本项目发布包远小于 4GB）。 */
function readZipEntries(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65558); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('ZIP 缺少中央目录');
  const count = buf.readUInt16LE(eocd + 10);
  const centralOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || centralOffset === 0xffffffff) throw new Error('暂不支持 ZIP64');
  const entries = [];
  let p = centralOffset;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('ZIP 中央目录损坏');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen).replace(/\\/g, '/');
    if (name.endsWith('/')) { p += 46 + nameLen + extraLen + commentLen; continue; }
    if (!name || name.startsWith('/') || name.includes('../') || name.includes('\0')) throw new Error('ZIP 含不安全路径：' + name);
    if (!ALLOWED_FILES.has(name) && !ALLOWED_PREFIXES.some((prefix) => name.startsWith(prefix))) {
      throw new Error('ZIP 含不允许的文件：' + name);
    }
    if (uncompSize > MAX_ZIP_BYTES) throw new Error('ZIP 内文件过大：' + name);
    if (buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('ZIP 本地头损坏：' + name);
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const dataEnd = dataStart + compSize;
    if (dataEnd > buf.length) throw new Error('ZIP 数据越界：' + name);
    const raw = buf.subarray(dataStart, dataEnd);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error('ZIP 压缩方式不支持：' + method);
    if (data.length > MAX_ZIP_BYTES) throw new Error('ZIP 解压后过大：' + name);
    entries.push({ name, data });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function copyTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    if (entry.isDirectory()) copyTree(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}

function applyEntries(entries) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  ensureDir(BACKUP_DIR);
  const backup = path.join(BACKUP_DIR, `plugin-${stamp}`);
  copyTree(PLUGIN_ROOT, backup);
  try {
    for (const entry of entries) {
      const target = path.join(PLUGIN_ROOT, entry.name);
      ensureDir(path.dirname(target));
      fs.writeFileSync(target, entry.data);
    }
  } catch (e) {
    // 覆盖失败时尽量把旧文件还原，避免插件半新半旧。
    try { copyTree(backup, PLUGIN_ROOT); } catch { /* ignore */ }
    throw e;
  }
  return backup;
}

export async function applyPluginUpdate(currentVersion) {
  const cache = readJson(CACHE_FILE, null);
  if (!cache || !cache.zipUrl || !cache.sha256) throw new Error('还没有检查到可用更新');
  if (!newerVersion(cache.version, currentVersion)) throw new Error('当前已是最新版本');
  const zipUrl = assertHttps(cache.zipUrl);
  let zip;
  if (cache.zipEncoding === 'base64') {
    const text = await fetchText(zipUrl, 45000);
    const compact = text.replace(/\s+/g, '');
    if (compact.length > MAX_ZIP_BYTES * 2) throw new Error('更新包过大');
    zip = Buffer.from(compact, 'base64');
  } else {
    zip = await requestBuffer(zipUrl, { timeoutMs: 45000, maxBytes: MAX_ZIP_BYTES });
  }
  if (zip.length === 0 || zip.length > MAX_ZIP_BYTES) throw new Error('更新包大小异常');
  const actual = sha256(zip);
  if (actual !== cache.sha256) throw new Error(`更新包校验失败：期望 ${cache.sha256.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…`);
  const entries = readZipEntries(zip);
  if (!entries.some((entry) => entry.name === 'package.json')) throw new Error('更新包缺少 package.json');
  const pkg = JSON.parse(entries.find((entry) => entry.name === 'package.json').data.toString('utf8'));
  if (String(pkg.name || '') !== 'dsh-plugin-local-llm') throw new Error('更新包包名不匹配');
  if (String(pkg.version || '') !== cache.version) throw new Error('更新包版本与清单不一致');
  ensureDir(UPDATE_DIR);
  fs.writeFileSync(path.join(UPDATE_DIR, `dsh-plugin-local-llm-${cache.version}.zip`), zip);
  const backup = applyEntries(entries);
  writeJson(PENDING_FILE, { version: cache.version, appliedAt: nowIso(), backup });
  return {
    ok: true,
    current: currentVersion,
    latest: cache.version,
    version: cache.version,
    restartRequired: true,
    backup,
    notes: cache.notes || [],
  };
}

export function clearPendingPluginUpdate() {
  try { fs.unlinkSync(PENDING_FILE); } catch { /* ignore */ }
}

export function setPluginUpdateUrl(url) {
  const clean = String(url || '').trim();
  if (clean) assertHttps(clean);
  patchConfig({ pluginUpdate: { url: clean } });
  try { fs.unlinkSync(CACHE_FILE); } catch { /* ignore */ }
  return { ok: true, url: clean };
}
