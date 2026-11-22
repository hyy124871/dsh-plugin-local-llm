// GGUF 下载：自动/魔搭/hf-mirror/HF 官方多源回退，断点续传，分片并发。
// 文件清单不写死：先查 HuggingFace tree API，再按量化目录/文件名匹配，
// 仓库里换分片数量也不会下错。

import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ensureDir, expandHome, patchConfig, DATA_DIR } from './settings.mjs';
import { scanImported, removeImported } from './importer.mjs';
import { modelContextLength } from './runtime.mjs';

const HF_APIS = ['https://hf-mirror.com/api/models', 'https://huggingface.co/api/models'];
const TREE_TTL = 15 * 60 * 1000;
const treeCache = new Map();
const jobs = new Map();
const JOBS_FILE = path.join(DATA_DIR, 'downloads.json');

export const SOURCES = [
  { id: 'auto', label: '自动（推荐）', hint: '按 hf-mirror → 魔搭 → HF 官方顺序自动回退' },
  { id: 'hf-mirror', label: 'hf-mirror（国内镜像）', base: 'https://hf-mirror.com', hint: '国内最稳，推荐' },
  { id: 'modelscope', label: 'ModelScope（魔搭）', base: 'https://modelscope.cn/models', hint: '阿里魔搭，国内直连' },
  { id: 'hf', label: 'HuggingFace（官方）', base: 'https://huggingface.co', hint: '官方源，国内可能需要代理' },
];

function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v >= 1073741824) return (v / 1073741824).toFixed(2) + ' GB';
  if (v >= 1048576) return (v / 1048576).toFixed(1) + ' MB';
  if (v >= 1024) return (v / 1024).toFixed(1) + ' KB';
  return v + ' B';
}

function authHeaders(cfg) {
  const h = { 'user-agent': 'dsh-plugin-local-llm/0.2.2' };
  if (cfg?.hfToken) h.authorization = 'Bearer ' + cfg.hfToken;
  return h;
}

function withTimeout(ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, clear: () => clearTimeout(timer) };
}

export async function listRepoFiles(repo, cfg = {}) {
  const hit = treeCache.get(repo);
  if (hit && Date.now() - hit.at < TREE_TTL) return hit.files;
  let lastErr = null;
  // huggingface.co 在国内网络常被 ECONNRESET；hf-mirror 的 API 与文件树一致，先走镜像再回落官方。
  for (const api of HF_APIS) {
    const t = withTimeout(30000);
    try {
      const res = await fetch(`${api}/${repo}/tree/main?recursive=true`, { headers: authHeaders(cfg), signal: t.signal, redirect: 'follow' });
      if (res.status === 404) throw new Error(`仓库不存在或没有公开文件：${repo}`);
      if (!res.ok) throw new Error(`读取仓库清单失败 HTTP ${res.status}`);
      const list = await res.json();
      const files = (Array.isArray(list) ? list : [])
        .filter((x) => x.type === 'file' && /\.gguf$/i.test(x.path))
        .map((x) => ({ path: x.path, size: Number(x.size) || 0 }));
      treeCache.set(repo, { at: Date.now(), files });
      return files;
    } catch (e) {
      lastErr = e;
    } finally {
      t.clear();
    }
  }
  throw new Error(`读取 ${repo} 的文件清单失败：${lastErr ? lastErr.message : '网络不可用'}`);
}

const EXCLUDE = /(mmproj|imatrix|mtp[-_]|dspark|bf16|f16|fp16|fp32)/i;

export function pickQuantFiles(all, quant, family) {
  const match = String(quant?.match || quant?.id || '').trim();
  if (!match) throw new Error('这个量化档没有配置匹配关键字');
  const lower = match.toLowerCase();
  let hits = all.filter((f) => {
    const p = f.path;
    if (EXCLUDE.test(p)) return false;
    const lowerPath = p.toLowerCase();
    const base = p.split('/').pop().toLowerCase();
    return lowerPath.startsWith(lower + '/') || base.includes(lower) || lowerPath.includes('/' + lower + '/');
  });
  // Q8_0 这类短名字容易误撞 IQ8 或别的档，优先"目录名完全相等"的。
  const exactDir = hits.filter((f) => f.path.split('/')[0].toLowerCase() === lower);
  if (exactDir.length) hits = exactDir;
  // 去掉视觉投影/草稿头，即使它们恰好在同一目录里。
  hits = hits.filter((f) => !EXCLUDE.test(f.path.split('/').pop()));
  if (!hits.length) {
    const dirs = [...new Set(all.map((f) => f.path.split('/')[0]))].slice(0, 12);
    throw new Error(`${family.name} 里没找到 ${quant.label || match} 的 GGUF 文件；仓库现有目录：${dirs.join(' / ')}`);
  }
  return hits.sort((a, b) => a.path.localeCompare(b.path));
}

function sourceBase(source, repo) {
  switch (source) {
    case 'hf':
      return `https://huggingface.co/${repo}/resolve/main`;
    case 'hf-mirror':
      return `https://hf-mirror.com/${repo}/resolve/main`;
    case 'modelscope':
      return `https://modelscope.cn/models/${repo}/resolve/master`;
    default:
      return `https://hf-mirror.com/${repo}/resolve/main`;
  }
}

function encodePath(p) {
  return String(p)
    .split('/')
    .map((s) => encodeURIComponent(s))
    .join('/');
}

export function fileUrl(cfg, repo, filePath, source) {
  return `${sourceBase(source || cfg.source || 'hf-mirror', repo)}/${encodePath(filePath)}`;
}

/** 多源候选：选定源优先，失败后按国内优先顺序回退。 */
export function fileUrls(cfg, repo, filePath, preferred) {
  const source = String(preferred || cfg.source || 'auto');
  const order = source === 'auto'
    ? ['hf-mirror', 'modelscope', 'hf']
    : source === 'hf'
      ? ['hf', 'hf-mirror', 'modelscope']
      : source === 'modelscope'
        ? ['modelscope', 'hf-mirror', 'hf']
        : ['hf-mirror', 'modelscope', 'hf'];
  return [...new Set(order)].map((s) => ({ source: s, url: fileUrl(cfg, repo, filePath, s) }));
}

export function freeGB(dir) {
  try {
    let cur = dir;
    while (cur && !fs.existsSync(cur)) {
      const up = path.dirname(cur);
      if (up === cur) break;
      cur = up;
    }
    const st = fs.statfsSync(cur);
    return Math.round((Number(st.bavail) * Number(st.bsize)) / 1073741824 * 10) / 10;
  } catch {
    return null;
  }
}

export function modelIdFor(familyId, quantId) {
  const s = ('local-' + familyId + '-' + quantId).replace(/[^\w.\-]+/g, '-').replace(/-+/g, '-').toLowerCase();
  return s.slice(0, 96);
}

function modelKey(familyId, quantId) {
  return familyId + '/' + quantId;
}

function publicJob(j) {
  const totalFiles = j.files.length || Number(j.fileCount) || 0;
  const doneFiles = j.files.length
    ? (j.doneByFile || []).filter((v, i) => j.files[i] && v >= j.files[i].size).length
    : Number(j.filesDoneCount) || 0;
  return {
    id: j.id,
    key: j.key,
    familyId: j.familyId,
    quantId: j.quantId,
    name: j.name,
    label: j.label,
    status: j.status,
    totalBytes: j.totalBytes,
    doneBytes: j.doneBytes,
    percent: j.totalBytes ? Math.min(100, Math.round((j.doneBytes / j.totalBytes) * 1000) / 10) : 0,
    bytesPerSec: j.bytesPerSec,
    files: totalFiles,
    filesDone: doneFiles,
    currentFile: j.activeFiles && j.activeFiles.length
      ? j.activeFiles[0].split('/').pop()
      : j.currentIndex < j.files.length ? j.files[j.currentIndex].path.split('/').pop() : '',
    source: j.source,
    dir: j.dir,
    error: j.error || null,
    startedAt: j.startedAt,
    finishedAt: j.finishedAt || null,
  };
}

function persistJobs() {
  try {
    ensureDir(DATA_DIR);
    const list = [...jobs.values()].map((j) => ({
      ...publicJob(j),
      status: j.status,
      fileCount: (j.files && j.files.length) || Number(j.fileCount) || 0,
      filesDoneCount: publicJob(j).filesDone,
      doneByFile: [],
      error: j.error || null,
    }));
    const tmp = JOBS_FILE + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf8');
    fs.renameSync(tmp, JOBS_FILE);
  } catch {
    /* ignore */
  }
}

function restoreJobs() {
  try {
    const list = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8'));
    for (const j of Array.isArray(list) ? list : []) {
      if (!j || !j.key) continue;
      jobs.set(j.key, {
        ...j,
        files: [],
        doneByFile: [],
        activeFiles: [],
        status: j.status === 'running' || j.status === 'resolving' ? 'interrupted' : j.status,
        error: j.status === 'running' || j.status === 'resolving' ? '插件重载，下载已中断；点重试可续传 .part' : j.error || null,
      });
    }
  } catch {
    /* no history */
  }
}
restoreJobs();

export function listJobs() {
  return [...jobs.values()].map(publicJob);
}

export function findJob(familyId, quantId) {
  return jobs.get(modelKey(familyId, quantId)) || null;
}

function resolveDir(cfg, family, quant, explicit) {
  const key = modelKey(family.id, quant.id);
  if (explicit) return path.resolve(expandHome(String(explicit)));
  const placed = cfg.placements && cfg.placements[key];
  if (placed) return path.resolve(expandHome(placed));
  return path.join(cfg.modelsDir, family.id, quant.id);
}

export async function startDownload(cfg, family, quant, opts = {}) {
  const key = modelKey(family.id, quant.id);
  const existed = jobs.get(key);
  if (existed && (existed.status === 'running' || existed.status === 'resolving')) return publicJob(existed);

  const dir = resolveDir(cfg, family, quant, opts.dir);
  const id = key.replace(/[^a-zA-Z0-9]+/g, '-') + '-' + Date.now().toString(36);
  const job = {
    id,
    key,
    familyId: family.id,
    quantId: quant.id,
    name: family.name,
    label: quant.label,
    status: 'resolving',
    files: [],
    doneByFile: [],
    activeFiles: [],
    totalBytes: 0,
    doneBytes: 0,
    bytesPerSec: 0,
    currentIndex: 0,
    dir,
    familyRepo: family.repo,
    source: opts.source || cfg.source || 'auto',
    startedAt: Date.now(),
    finishedAt: null,
    error: null,
    cancel: false,
    controller: new AbortController(),
  };
  jobs.set(key, job);

  (async () => {
    try {
      const repo = family.repo;
      if (!repo) throw new Error('这个模型没有配置仓库');
      const all = await listRepoFiles(repo, cfg);
      const picked = pickQuantFiles(all, quant, family);
      job.files = picked.map((f) => ({
        path: f.path,
        size: f.size,
        dest: path.join(dir, f.path.split('/').pop()),
        urls: fileUrls(cfg, repo, f.path, job.source),
      }));
      job.doneByFile = job.files.map(() => 0);
      job.totalBytes = job.files.reduce((s, f) => s + f.size, 0);
      const free = freeGB(dir);
      const need = job.totalBytes * 1.06;
      if (free !== null && free * 1073741824 < need && !opts.force) {
        throw new Error(`磁盘空间不够：这档约 ${fmtBytes(job.totalBytes)}，${dir} 只剩 ${free}GB。可换目录或用 force=true 强下。`);
      }
      ensureDir(dir);
      if (opts.dir) {
        const placements = { ...(cfg.placements || {}), [key]: dir };
        patchConfig({ placements });
      }
      job.status = 'running';
      persistJobs();
      await runJob(job, cfg);
    } catch (e) {
      if (job.cancel) {
        job.status = 'cancelled';
      } else {
        job.status = 'error';
        job.error = e.message;
      }
      job.finishedAt = Date.now();
      persistJobs();
    }
  })();

  return publicJob(job);
}

function setDone(job) {
  job.doneBytes = job.doneByFile.reduce((s, v) => s + v, 0);
  const elapsed = Math.max(1, Date.now() - job.startedAt);
  job.bytesPerSec = Math.round((job.doneBytes * 1000) / elapsed);
}

async function downloadOne(job, cfg, index, f) {
  ensureDir(path.dirname(f.dest));
  const part = f.dest + '.part';
  let have = 0;
  try {
    have = fs.statSync(part).size;
  } catch {
    have = 0;
  }
  if (have > f.size) {
    fs.rmSync(part, { force: true });
    have = 0;
  }
  if (have === f.size && f.size > 0) {
    fs.renameSync(part, f.dest);
    job.doneByFile[index] = f.size;
    setDone(job);
    return { source: 'resumed' };
  }

  let lastError = null;
  for (const candidate of f.urls) {
    if (job.cancel) throw new Error('cancelled');
    try {
      const headers = authHeaders(cfg);
      if (have > 0) headers.range = `bytes=${have}-`;
      const res = await fetch(candidate.url, { headers, signal: job.controller.signal, redirect: 'follow' });
      if (res.status === 416) {
        fs.rmSync(part, { force: true });
        have = 0;
        lastError = new Error('服务端范围错误，已清理 .part');
        continue;
      }
      if (!res.ok && res.status !== 206) {
        lastError = new Error(`HTTP ${res.status}（${candidate.source}）`);
        continue;
      }
      if (!res.body) {
        lastError = new Error('响应没有 body（' + candidate.source + '）');
        continue;
      }
      const append = res.status === 206 && have > 0;
      if (!append) {
        have = 0;
        fs.rmSync(part, { force: true });
      }
      const out = fs.createWriteStream(part, { flags: append ? 'a' : 'w' });
      let written = have;
      const nodeStream = Readable.fromWeb(res.body, { highWaterMark: 1024 * 1024 });
      job.activeFiles.push(f.path);
      nodeStream.on('data', (chunk) => {
        written += chunk.length;
        job.doneByFile[index] = written;
        setDone(job);
        if (job.cancel) nodeStream.destroy(new Error('cancelled'));
      });
      try {
        await pipeline(nodeStream, out);
      } finally {
        job.activeFiles = job.activeFiles.filter((x) => x !== f.path);
      }
      if (job.cancel) throw new Error('cancelled');
      const finalSize = fs.statSync(part).size;
      if (f.size > 0 && finalSize !== f.size) {
        lastError = new Error(`文件不完整（${finalSize}/${f.size}，${candidate.source}）`);
        have = finalSize;
        continue;
      }
      fs.renameSync(part, f.dest);
      job.doneByFile[index] = f.size;
      setDone(job);
      return { source: candidate.source };
    } catch (e) {
      if (job.cancel || e.message === 'cancelled') throw new Error('cancelled');
      lastError = e;
    }
  }
  throw new Error(`下载失败（已尝试 ${f.urls.length} 个源）：${f.path} · ${lastError ? lastError.message : 'unknown'}；.part 已保留，可重试续传`);
}

async function runJob(job, cfg) {
  const concurrency = Math.max(1, Math.min(Number(cfg.download?.concurrency) || 3, job.files.length));
  let next = 0;
  let error = null;
  const worker = async () => {
    while (true) {
      if (error || job.cancel) return;
      const i = next++;
      if (i >= job.files.length) return;
      job.currentIndex = i;
      try {
        await downloadOne(job, cfg, i, job.files[i]);
      } catch (e) {
        if (!error) error = e;
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  if (job.cancel) throw new Error('cancelled');
  if (error) throw error;

  job.doneBytes = job.totalBytes;
  job.bytesPerSec = Math.round((job.totalBytes * 1000) / Math.max(1, Date.now() - job.startedAt));
  const manifest = {
    familyId: job.familyId,
    name: job.name,
    quantId: job.quantId,
    label: job.label,
    repo: job.familyRepo,
    source: job.source,
    totalBytes: job.totalBytes,
    files: job.files.map((f) => ({ path: f.path, size: f.size, bytes: fs.existsSync(f.dest) ? fs.statSync(f.dest).size : 0 })),
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(job.dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  job.status = 'done';
  job.finishedAt = Date.now();
  persistJobs();
}

export function cancelDownload(familyId, quantId) {
  const job = jobs.get(modelKey(familyId, quantId));
  if (!job || job.status === 'done' || job.status === 'cancelled') return null;
  job.cancel = true;
  try {
    job.controller.abort();
  } catch {
    /* ignore */
  }
  persistJobs();
  return publicJob(job);
}

function insideAny(roots, p) {
  const t = path.resolve(p);
  return roots.some((root) => {
    const b = path.resolve(root);
    return t === b || t.startsWith(b + path.sep);
  });
}

function allowedRoots(cfg) {
  return [cfg.modelsDir, ...(cfg.extraModelDirs || []), ...Object.values(cfg.placements || {})]
    .filter(Boolean)
    .map((x) => path.resolve(expandHome(x)));
}

export function removeModel(cfg, familyId, quantId, families = []) {
  if (familyId === 'imported') return removeImported(cfg, quantId);
  // 允许删除按 placement 放在任意受管目录里的模型；目录必须属于用户选过的根。
  const rec = scanModels(cfg, families).find((d) => d.familyId === familyId && d.quantId === quantId);
  const dir = rec?.dir || path.join(cfg.modelsDir, familyId, quantId);
  if (!insideAny(allowedRoots(cfg), dir)) throw new Error('拒绝删除模型目录之外的路径');
  if (!fs.existsSync(dir)) return { removed: false, dir };
  fs.rmSync(dir, { recursive: true, force: true });
  try {
    const famDir = path.join(cfg.modelsDir, familyId);
    if (fs.existsSync(famDir) && fs.readdirSync(famDir).length === 0) fs.rmdirSync(famDir);
  } catch {
    /* ignore */
  }
  const key = modelKey(familyId, quantId);
  const job = jobs.get(key);
  if (job) jobs.delete(key);
  if (cfg.placements && cfg.placements[key]) {
    const next = { ...cfg.placements };
    delete next[key];
    patchConfig({ placements: next });
  }
  persistJobs();
  return { removed: true, dir };
}

function dirSize(dir) {
  let total = 0;
  const walk = (p) => {
    for (const ent of fs.readdirSync(p, { withFileTypes: true })) {
      const full = path.join(p, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.isFile()) total += fs.statSync(full).size;
    }
  };
  try {
    walk(dir);
  } catch {
    /* ignore */
  }
  return total;
}

function ggufsIn(dir) {
  const out = [];
  const walk = (p) => {
    for (const ent of fs.readdirSync(p, { withFileTypes: true })) {
      const full = path.join(p, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.isFile() && isGgufName(ent.name)) out.push(full);
    }
  };
  try {
    walk(dir);
  } catch {
    /* ignore */
  }
  return out.sort((a, b) => a.localeCompare(b));
}

function isGgufName(name) {
  return /\.gguf$/i.test(name) && !/mmproj|imatrix|mtp|dspark/i.test(name);
}

export function scanModels(cfg, families) {
  const out = [];
  ensureDir(cfg.modelsDir);
  const roots = [cfg.modelsDir, ...(cfg.extraModelDirs || [])].filter(Boolean).map((x) => path.resolve(expandHome(x)));
  for (const f of families) {
    for (const q of f.quants) {
      const key = modelKey(f.id, q.id);
      const candidates = [];
      if (cfg.placements && cfg.placements[key]) candidates.push(path.resolve(expandHome(cfg.placements[key])));
      for (const root of roots) candidates.push(path.join(root, f.id, q.id));
      const dir = candidates.find((p) => fs.existsSync(p));
      if (!dir) continue;
      const ggufs = ggufsIn(dir);
      if (!ggufs.length) continue;
      const bytes = ggufs.reduce((sum, file) => {
        try {
          return sum + fs.statSync(file).size;
        } catch {
          return sum;
        }
      }, 0);
      let manifest = null;
      try {
        manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
      } catch {
        /* no manifest yet */
      }
      out.push({
        familyId: f.id,
        familyName: f.name,
        quantId: q.id,
        label: q.label,
        dir,
        gb: Math.round((bytes / 1073741824) * 100) / 100,
        bytes,
        files: ggufs.length,
        firstGguf: ggufs[0],
        contextLength: modelContextLength(ggufs[0]),
        complete: Boolean(manifest),
        source: manifest?.source || 'local',
        modelId: modelIdFor(f.id, q.id),
      });
    }
  }
  // 本地导入的模型作为独立条目追加；它们不依赖目录结构。
  out.push(...scanImported(cfg));
  return out;
}

/** 给面板/工具用的一行文件大小描述 */
export function formatBytes(n) {
  return fmtBytes(n);
}
