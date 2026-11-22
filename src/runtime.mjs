// llama.cpp 运行时：找/下预编译包，起停 llama-server，健康检查，OpenAI 兼容端点。
// 只依赖 Node 自带模块，不引入 npm 包；Windows 用 Expand-Archive 解压，macOS/Linux 用 tar。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DATA_DIR, ensureDir, logDir, patchConfig } from './settings.mjs';
import { detect as detectHardware, powershellExe } from './hardware.mjs';

const RUNTIME_ROOT = path.join(DATA_DIR, 'runtime');
const RUNTIME_DIR = path.join(RUNTIME_ROOT, 'llama.cpp');
const RELEASE_API = 'https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=1';
// GitHub 的 release 资产在部分网络会直连超时，按顺序回退到两个可用加速前缀。
const GH_MIRRORS = ['https://gh-proxy.com/', 'https://ghproxy.net/'];

let releaseCache = null;
let runtimeDetectCache = { at: 0, path: '', info: null };
let runtimeJob = null;
let stopping = false;
const ggufMetaCache = new Map();
let lifecycle = Promise.resolve();
let server = {
  status: 'stopped', port: null, modelPath: '', modelName: '', modelId: '',
  pid: null, startedAt: null, error: null, logTail: [], adopted: false,
  ctx: null, ngl: null, threads: null, backend: '', reasoningEffort: '', params: null,
};
let proc = null;
const warmedPorts = new Set();
const SERVER_FILE = path.join(DATA_DIR, 'server.json');

function isExe(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function findExeIn(dir, depth = 3) {
  if (!dir || !fs.existsSync(dir)) return null;
  const names = process.platform === 'win32' ? ['llama-server.exe'] : ['llama-server'];
  const walk = (p, d) => {
    let entries = [];
    try {
      entries = fs.readdirSync(p, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const e of entries) {
      const full = path.join(p, e.name);
      if (e.isFile() && names.includes(e.name)) return full;
    }
    if (d <= 0) return null;
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const hit = walk(path.join(p, e.name), d - 1);
      if (hit) return hit;
    }
    return null;
  };
  return walk(dir, depth);
}

function fromPath() {
  const r = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', ['llama-server'], { encoding: 'utf8', timeout: 8000, windowsHide: true });
  const line = String(r.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
  return line && isExe(line) ? line : null;
}

function estimateBlocks(paramsB) {
  const n = Number(paramsB) || 2;
  if (n >= 60) return 80;
  if (n >= 30) return 64;
  if (n >= 13) return 48;
  if (n >= 7) return 32;
  if (n >= 3) return 28;
  return 24;
}

/** 只读 GGUF 头部的 metadata，拿 block_count / kv 头数，用于自动算 GPU 层数。 */
function readGgufMetaUncached(file) {
  const out = {
    ok: false, arch: '', blockCount: 0, headCount: 0, headCountKv: 0,
    embeddingLength: 0, contextLength: 0, keyLength: 0, valueLength: 0,
    fullAttentionInterval: 0, slidingWindow: 0, slidingWindowPattern: null,
  };
  let fd = null;
  try {
    const size = fs.statSync(file).size;
    const len = Math.min(size, 8 * 1024 * 1024);
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(Number(len));
    fs.readSync(fd, buf, 0, Number(len), 0);
    fs.closeSync(fd);
    fd = null;
    let off = 0;
    const need = (n) => { if (off + n > buf.length) throw new Error('gguf metadata overflow'); };
    const u32 = () => { need(4); const v = buf.readUInt32LE(off); off += 4; return v; };
    const u64 = () => { need(8); const v = Number(buf.readBigUInt64LE(off)); off += 8; return v; };
    const readStr = () => { const n = u64(); need(n); const s = buf.toString('utf8', off, off + n); off += n; return s; };
    const readNum = (t) => {
      switch (t) {
        case 0: { need(1); const v = buf.readUInt8(off); off += 1; return v; }
        case 1: { need(1); const v = buf.readInt8(off); off += 1; return v; }
        case 2: { need(2); const v = buf.readUInt16LE(off); off += 2; return v; }
        case 3: { need(2); const v = buf.readInt16LE(off); off += 2; return v; }
        case 4: return u32();
        case 5: { need(4); const v = buf.readInt32LE(off); off += 4; return v; }
        case 6: { need(4); const v = buf.readFloatLE(off); off += 4; return v; }
        case 7: { need(1); const v = buf.readUInt8(off); off += 1; return v; }
        case 10: return u64();
        case 11: { need(8); const v = Number(buf.readBigInt64LE(off)); off += 8; return v; }
        case 12: { need(8); const v = buf.readDoubleLE(off); off += 8; return v; }
        default: throw new Error('gguf unknown type ' + t);
      }
    };
    const skip = (t) => {
      if (t === 8) { const n = u64(); off += n; need(0); return; }
      if (t === 9) {
        const et = u32();
        const n = u64();
        for (let i = 0; i < n; i += 1) skip(et);
        return;
      }
      readNum(t);
    };
    const magic = u32();
    if (magic !== 0x46554747) throw new Error('not gguf');
    u32(); // version
    u64(); // tensor count
    const kvCount = u64();
    for (let i = 0; i < kvCount; i += 1) {
      const key = readStr();
      const type = u32();
      if (type === 8) {
        const value = readStr();
        if (key === 'general.architecture') out.arch = value;
      } else if (type === 9) {
        const et = u32();
        const n = u64();
        if (n > 4096) throw new Error('gguf array too large');
        if (/\.attention\.sliding_window_pattern$/.test(key) && [4, 5, 7].includes(et)) {
          const arr = [];
          for (let j = 0; j < n; j += 1) arr.push(Boolean(readNum(et)));
          out.slidingWindowPattern = arr;
        } else {
          for (let j = 0; j < n; j += 1) skip(et);
        }
      } else {
        const value = readNum(type);
        if (/\.block_count$/.test(key)) out.blockCount = Number(value) || 0;
        else if (/\.attention\.head_count_kv$/.test(key)) out.headCountKv = Number(value) || 0;
        else if (/\.attention\.head_count$/.test(key)) out.headCount = Number(value) || 0;
        else if (/\.embedding_length$/.test(key)) out.embeddingLength = Number(value) || 0;
        else if (/\.context_length$/.test(key)) out.contextLength = Number(value) || 0;
        else if (/\.attention\.key_length$/.test(key)) out.keyLength = Number(value) || 0;
        else if (/\.attention\.value_length$/.test(key)) out.valueLength = Number(value) || 0;
        else if (/\.attention\.sliding_window$/.test(key)) out.slidingWindow = Number(value) || 0;
        else if (/\.full_attention_interval$/.test(key)) out.fullAttentionInterval = Number(value) || 0;
      }
    }
    out.ok = out.blockCount > 0;
    return out;
  } catch {
    return out;
  } finally {
    if (fd != null) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

function readGgufMeta(file) {
  try {
    const stat = fs.statSync(file);
    const key = path.resolve(file) + ':' + stat.size + ':' + stat.mtimeMs;
    const hit = ggufMetaCache.get(key);
    if (hit) return hit;
    const meta = readGgufMetaUncached(file);
    ggufMetaCache.set(key, meta);
    // 元数据缓存不需要无限增长：四个模型来回切也就几条。
    if (ggufMetaCache.size > 64) {
      const first = ggufMetaCache.keys().next().value;
      ggufMetaCache.delete(first);
    }
    return meta;
  } catch {
    return readGgufMetaUncached(file);
  }
}

/** 给面板/服务层用的模型元数据。 */
export function readModelMeta(file) {
  return readGgufMeta(file);
}

/** 模型 GGUF 自己声明的最大上下文（Qwen3.5 为 262144）。 */
export function modelContextLength(file) {
  return Number(readGgufMeta(file).contextLength) || 0;
}

function kvBytesPer(type) {
  const t = String(type || 'f16').toLowerCase();
  if (t === 'f16' || t === 'bf16') return 2;
  if (t === 'f32') return 4;
  if (t === 'q8_0') return 1;
  if (t === 'q5_1') return 0.75;
  if (t === 'q5_0') return 0.6875;
  if (t === 'q4_1') return 0.625;
  if (t === 'q4_0') return 0.5625;
  if (t === 'iq4_nl') return 0.5625;
  // 默认按 q8 级别估算，宁可少算一点显存也不要直接 OOM。
  return 1;
}

function modelBytes(file) {
  let own = 0;
  try {
    const stat = fs.statSync(file);
    if (stat.isFile()) own = stat.size;
  } catch {
    return 0;
  }
  // 分片模型：同一目录下的 .gguf 分片要合计，否则 ngl 会按单片体积高估。
  let total = 0;
  let count = 0;
  try {
    for (const name of fs.readdirSync(path.dirname(file))) {
      if (!/\.gguf$/i.test(name) || /mmproj|imatrix|mtp|draft/i.test(name)) continue;
      try { total += fs.statSync(path.join(path.dirname(file), name)).size; count += 1; } catch { /* ignore */ }
    }
  } catch {
    /* ignore */
  }
  return count > 1 ? total : own;
}

function estimateKvBytes(meta, ctx, kvType) {
  const blocks = meta.blockCount || 24;
  const heads = meta.headCount || 32;
  const kvHeads = meta.headCountKv || heads;
  const embed = meta.embeddingLength || 2048;
  const headDim = meta.keyLength || Math.max(32, Math.round(embed / Math.max(1, heads)));
  const bytes = kvBytesPer(kvType);
  // Spark-X2.6 是滑动窗口混合注意力：7 层全注意力 + 21 层 512 窗口。
  // 1M 上下文的 KV 只有约 4.2GB（q4_0），不是按 28 层全注意力算出的 17GB。
  const pattern = meta.slidingWindowPattern;
  const win = Number(meta.slidingWindow) || 0;
  if (Array.isArray(pattern) && pattern.length && win > 0) {
    let full = 0;
    let sliding = 0;
    for (let i = 0; i < blocks; i += 1) {
      if (pattern[i % pattern.length]) sliding += 1;
      else full += 1;
    }
    const fullCtx = Math.max(512, ctx);
    const slidingCtx = Math.min(fullCtx, win);
    return 2 * kvHeads * headDim * (full * fullCtx + sliding * slidingCtx) * bytes;
  }
  // Qwen3.5 是混合架构：只有每隔 full_attention_interval 层才有完整的 KV，
  // 其余层是 SSM 状态；按全部 block 算会把 256K 的 KV 高估 4 倍。
  const interval = Number(meta.fullAttentionInterval) || 1;
  const attentionBlocks = interval > 1 ? Math.ceil(blocks / interval) : blocks;
  return 2 * attentionBlocks * kvHeads * headDim * Math.max(512, ctx) * bytes;
}

function gbOf(bytes) {
  return Math.round((Number(bytes) || 0) / 1073741824 * 10) / 10;
}

/** 三层加载计划：能进显存的层 → GPU，剩余层 → 内存，模型文件超出内存 → mmap 硬盘。 */
export async function computeTierPlan(cfg, model, ctx = cfg.runtime.ctx || 4096) {
  const hw = await detectHardware({ modelsDir: cfg.modelsDir }).catch(() => null);
  const meta = readGgufMeta(model.path);
  const blocks = Math.max(1, meta.blockCount || estimateBlocks(model.paramsB));
  const total = modelBytes(model.path);
  const modelGB = gbOf(total);
  const backend = String(cfg.runtime.build || '').toLowerCase();
  const vramGB = Number(hw?.vramGB) || 0;
  const ramGB = Number(hw?.ramGB) || 0;
  const kvGB = gbOf(estimateKvBytes(meta, ctx, resolveKvCache(cfg, model.path, ctx)));
  const layerGB = modelGB / blocks;
  const reserveGB = 0.15 + Math.min(2.5, kvGB);
  let ngl = 0;
  if (backend === 'cuda' || backend === 'vulkan' || backend === 'metal') {
    ngl = Math.floor((vramGB - reserveGB) / Math.max(0.01, layerGB));
    ngl = Math.max(0, Math.min(blocks, ngl));
    // 2GB 级弱显存跑 2B 以下小模型时，GPU 解码往往打不过 4 核 CPU：
    // 权重能塞进显存不代表值得塞，PCIe/驱动开销会拖慢每 token。
    if (modelGB <= 2.5 && vramGB <= 4) ngl = 0;
  }
  const gpuGB = Math.round(ngl * layerGB * 10) / 10;
  const ramNeedGB = Math.round((modelGB - gpuGB) * 10) / 10;
  const diskBacked = ramNeedGB > Math.max(1, ramGB * 0.85);
  return {
    backend: backend || 'cpu',
    blockCount: blocks,
    ngl,
    modelGB,
    gpuGB,
    ramNeedGB,
    vramGB,
    ramGB,
    kvGB,
    diskBacked,
    mode: ngl >= blocks ? 'gpu' : ngl > 0 ? (diskBacked ? 'gpu+ram+disk' : 'gpu+ram') : (diskBacked ? 'ram+disk' : 'ram'),
    note: ngl > 0
      ? `${ngl}/${blocks} 层进显存（约 ${gpuGB}GB），其余 ${Math.max(0, blocks - ngl)} 层在内存${diskBacked ? '，超出部分 mmap 落盘' : ''}`
      : (diskBacked ? `显存未启用；内存不足，模型靠 mmap 从硬盘流式读取` : `显存未启用；全部 ${blocks} 层在内存`),
  };
}

const ctxPlanCache = new Map();

/**
 * 在“模型声明的最大上下文”和“本机显存/内存能承受的 KV”之间取最大值。
 * Qwen3.5 的 256K 是模型能力，不等于每台机器都能在 2GB 显存里全量放 KV。
 * 目标：优先让全部层进 GPU；如果 256K 放不下，自动降到 128K/64K。
 */
export async function recommendedContext(cfg, model) {
  const file = String(model?.firstGguf || model?.path || '');
  if (!file) return Math.max(4096, Number(cfg.runtime?.ctx) || 8192);
  let stat;
  try { stat = fs.statSync(file); } catch { return Math.max(4096, Number(cfg.runtime?.ctx) || 8192); }
  const meta = readGgufMeta(file);
  const declared = Math.max(4096, Number(meta.contextLength) || 32768);
  const cap = Math.max(4096, Number(cfg.runtime?.ctx) || declared);
  const backend = String(detectRuntime(cfg).build || cfg.runtime?.build || 'cpu').toLowerCase();
  const gpuBackend = ['cuda', 'vulkan', 'metal'].includes(backend);
  const cacheKey = [file, stat.size, stat.mtimeMs, backend, cfg.runtime?.kvCache, cap, declared].join(':');
  const cached = ctxPlanCache.get(cacheKey);
  if (cached) return cached;
  const hw = await detectHardware({ modelsDir: cfg.modelsDir }).catch(() => null);
  const vramGB = Number(hw?.vramGB) || 0;
  const ramGB = Number(hw?.ramGB) || 0;
  const modelGB = gbOf(modelBytes(file));
  // 与 computeTierPlan 的弱显存规则保持一致：2.5GB 以下模型 + 4GB 以下显存走 CPU，
  // 此时上下文预算必须按内存算，不能按 2GB 显存算，否则 Spark 1.7B 会被卡在 8K。
  const weakGpu = gpuBackend && modelGB <= 2.5 && vramGB <= 4;
  const limitGB = weakGpu ? ramGB : gpuBackend ? vramGB : ramGB;
  if (!limitGB) return Math.min(declared, cap);
  const reserveGB = weakGpu ? 2.0 : gpuBackend ? 0.1 : 2.0;
  const steps = [1048576, 524288, 262144, 131072, 65536, 32768, 16384, 8192]
    .filter((n) => n <= declared && n <= cap);
  if (!steps.length) steps.push(Math.min(declared, cap));
  let chosen = steps[steps.length - 1];
  for (const n of steps) {
    const kvGB = gbOf(estimateKvBytes(meta, n, resolveKvCache(cfg, file, n)));
    if (modelGB + kvGB + reserveGB <= limitGB) { chosen = n; break; }
  }
  ctxPlanCache.set(cacheKey, chosen);
  if (ctxPlanCache.size > 128) ctxPlanCache.delete(ctxPlanCache.keys().next().value);
  return chosen;
}

export function runtimeVersion(exe) {  try {
    const r = spawnSync(exe, ['--version'], { timeout: 12000, encoding: 'utf8', windowsHide: true });
    const text = String(r.stdout || '') + ' ' + String(r.stderr || '');
    const m = text.match(/b(\d{4,})/);
    if (m) return 'b' + m[1];
    const line = text.split(/\r?\n/).map((s) => s.trim()).find((s) => /version/i.test(s));
    return line ? line.slice(0, 60) : '';
  } catch {
    return '';
  }
}

export function detectRuntime(cfg = {}, force = false) {
  const key = String(cfg.runtime?.path || '');
  if (!force && runtimeDetectCache.info && Date.now() - runtimeDetectCache.at < 60 * 1000 && runtimeDetectCache.path === key) {
    return runtimeDetectCache.info;
  }
  const candidates = [];
  if (cfg.runtime?.path) {
    const p = /\.exe$/.test(cfg.runtime.path) || !fs.existsSync(cfg.runtime.path) ? cfg.runtime.path : findExeIn(cfg.runtime.path, 4);
    candidates.push(p);
  }
  candidates.push(findExeIn(RUNTIME_DIR, 4));
  candidates.push(fromPath());
  if (process.platform === 'win32') {
    for (const c of [
      'C:\\llama.cpp\\build\\bin\\Release',
      'C:\\llama.cpp\\build\\bin',
      'D:\\llama.cpp\\build\\bin\\Release',
      path.join(process.env.LOCALAPPDATA || '', 'llama.cpp'),
      path.join(process.env.USERPROFILE || '', 'llama.cpp'),
    ]) {
      candidates.push(findExeIn(c, 4));
    }
  }
  const exe = candidates.find((p) => p && isExe(p)) || null;
  if (!exe) {
    const miss = { installed: false, exe: null, dir: null, version: '', build: '' };
    runtimeDetectCache = { at: Date.now(), path: key, info: miss };
    return miss;
  }
  const dir = path.dirname(exe);
  const version = runtimeVersion(exe) || cfg.runtime?.version || '';
  let build = '';
  if (/cuda/i.test(dir)) build = 'cuda';
  else if (/vulkan/i.test(dir)) build = 'vulkan';
  else if (/cpu|avx/i.test(dir)) build = 'cpu';
  const info = { installed: true, exe, dir, version, build };
  runtimeDetectCache = { at: Date.now(), path: key, info };
  return info;
}

async function latestRelease() {
  if (releaseCache && Date.now() - releaseCache.at < 30 * 60 * 1000) return releaseCache.value;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(RELEASE_API, { headers: { 'user-agent': 'dsh-plugin-local-llm/0.2.2', accept: 'application/vnd.github+json' }, signal: ctrl.signal });
    if (!res.ok) throw new Error('读取 llama.cpp release 失败 HTTP ' + res.status);
    const rel = (await res.json())[0];
    const value = { tag: rel.tag_name, assets: rel.assets || [] };
    releaseCache = { at: Date.now(), value };
    return value;
  } finally {
    clearTimeout(timer);
  }
}

function pickAssets(tag, backend) {
  const b = tag;
  const win = process.platform === 'win32';
  const mac = process.platform === 'darwin';
  const linux = process.platform === 'linux';
  let mainRe;
  let cudartRe = null;
  if (win) {
    if (backend === 'cuda') {
      mainRe = new RegExp(`^llama-${b}-bin-win-cuda-12\\.4-x64\\.zip$`);
      cudartRe = new RegExp(`^cudart-llama(?:-${b})?-bin-win-cuda-12\\.4-x64\\.zip$`);
    } else if (backend === 'vulkan') {
      mainRe = new RegExp(`^llama-${b}-bin-win-vulkan-x64\\.zip$`);
    } else {
      mainRe = new RegExp(`^llama-${b}-bin-win-cpu-x64\\.zip$`);
    }
  } else if (mac) {
    mainRe = new RegExp(`^llama-${b}-bin-macos-(arm64|x64)\\.tar\\.gz$`);
  } else if (linux) {
    mainRe = backend === 'cuda'
      ? new RegExp(`^llama-${b}-bin-ubuntu-cuda-12\\.8-x64\\.tar\\.gz$`)
      : backend === 'vulkan'
        ? new RegExp(`^llama-${b}-bin-ubuntu-vulkan-x64\\.tar\\.gz$`)
        : new RegExp(`^llama-${b}-bin-ubuntu-x64\\.tar\\.gz$`);
  } else {
    throw new Error('当前平台没有对应的 llama.cpp 预编译包');
  }
  return { mainRe, cudartRe, tag };
}

export function runtimeJobInfo() {
  if (!runtimeJob) return null;
  return {
    status: runtimeJob.status,
    percent: runtimeJob.percent,
    bytes: runtimeJob.bytes,
    totalBytes: runtimeJob.totalBytes,
    bytesPerSec: runtimeJob.bytesPerSec,
    error: runtimeJob.error,
    backend: runtimeJob.backend,
    version: runtimeJob.version,
  };
}

async function downloadFile(url, dest, onProgress) {
  const candidates = [url, ...GH_MIRRORS.map((m) => m + url)];
  let lastError = null;
  for (const candidate of candidates) {
    let out = null;
    try {
      const res = await fetch(candidate, { headers: { 'user-agent': 'dsh-plugin-local-llm/0.2.2' }, redirect: 'follow' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const total = Number(res.headers.get('content-length')) || 0;
      ensureDir(path.dirname(dest));
      try { fs.rmSync(dest, { force: true }); } catch { /* ignore */ }
      out = fs.createWriteStream(dest);
      let got = 0;
      let last = Date.now();
      let lastBytes = 0;
      const rs = Readable.fromWeb(res.body);
      rs.on('data', (c) => {
        got += c.length;
        const now = Date.now();
        onProgress(got, total, now - last > 800 ? ((got - lastBytes) * 1000) / (now - last) : null);
        if (now - last > 800) {
          last = now;
          lastBytes = got;
        }
      });
      await pipeline(rs, out);
      out = null;
      return { bytes: got, totalBytes: total, url: candidate };
    } catch (e) {
      lastError = e;
      try { if (out) out.destroy(); } catch { /* ignore */ }
      try { fs.rmSync(dest, { force: true }); } catch { /* ignore */ }
      onProgress(0, 0, null);
    }
  }
  throw new Error('下载失败（GitHub 与镜像都不可用）：' + (lastError?.message || 'unknown'));
}

function extract(zip, dest) {
  ensureDir(dest);
  if (process.platform === 'win32') {
    const ps = `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${dest.replace(/'/g, "''")}' -Force`;
    const r = spawnSync(powershellExe(), ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 180000, encoding: 'utf8', windowsHide: true });
    if (r.status !== 0) throw new Error('解压失败：' + String(r.stderr || r.stdout || '').slice(0, 300));
  } else {
    const r = spawnSync('tar', ['-xf', zip, '-C', dest], { timeout: 180000 });
    if (r.status !== 0) throw new Error('解压失败：tar exit ' + r.status);
  }
}

export async function downloadRuntime(cfg, backend) {
  if (runtimeJob && (runtimeJob.status === 'running' || runtimeJob.status === 'resolving')) return runtimeJobInfo();
  runtimeJob = { status: 'resolving', percent: 0, bytes: 0, totalBytes: 0, bytesPerSec: 0, error: null, backend, version: '' };
  (async () => {
    try {
      const rel = await latestRelease();
      const { mainRe, cudartRe } = pickAssets(rel.tag, backend);
      const main = rel.assets.find((a) => mainRe.test(a.name));
      if (!main) throw new Error(`这个 release 没有 ${backend} 的预编译包（${rel.tag}）`);
      runtimeJob.version = rel.tag;
      runtimeJob.totalBytes = main.size;
      runtimeJob.status = 'running';
      const tagDir = path.join(RUNTIME_DIR, rel.tag + '-' + backend);
      ensureDir(tagDir);
      const zip = path.join(RUNTIME_ROOT, 'downloads', main.name);
      await downloadFile(main.browser_download_url, zip, (got, total, speed) => {
        runtimeJob.bytes = got;
        runtimeJob.totalBytes = total || main.size || 0;
        runtimeJob.percent = runtimeJob.totalBytes ? Math.min(99, Math.round((got / runtimeJob.totalBytes) * 100)) : 0;
        if (speed) runtimeJob.bytesPerSec = Math.round(speed);
      });
      extract(zip, tagDir);
      if (cudartRe) {
        const cudart = rel.assets.find((a) => cudartRe.test(a.name));
        if (cudart) {
          const czip = path.join(RUNTIME_ROOT, 'downloads', cudart.name);
          await downloadFile(cudart.browser_download_url, czip, () => {});
          extract(czip, tagDir);
        }
      }
      const exe = findExeIn(tagDir, 4);
      if (!exe) throw new Error('解压后没找到 llama-server，可改用手动指定路径');
      runtimeJob.percent = 100;
      runtimeJob.status = 'done';
      patchConfig({ runtime: { path: exe, version: rel.tag, build: backend } });
      runtimeDetectCache = { at: 0, path: '', info: null };
      try {
        fs.rmSync(zip, { force: true });
      } catch {
        /* ignore */
      }
    } catch (e) {
      runtimeJob.status = 'error';
      runtimeJob.error = e.message;
    }
  })();
  return runtimeJobInfo();
}

async function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

function splitArgs(text) {
  const s = String(text || '').trim();
  if (!s) return [];
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(s))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

export function baseUrl(port) {
  return `http://127.0.0.1:${port}`;
}

export function apiBase(port) {
  return `${baseUrl(port)}/v1`;
}

async function health(port, timeoutMs = 2500) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl(port)}/health`, { signal: ctrl.signal });
    if (!res.ok) return { ok: false, status: res.status };
    const j = await res.json().catch(() => ({}));
    return { ok: j.status === 'ok' || j.status === 'ready', status: j.status || 'ok' };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}

export async function healthCheck(port, timeoutMs = 2000) {
  if (!port) return { ok: false };
  return health(port, timeoutMs);
}

/**
 * 首次真实请求会触发 Vulkan 计算图编译，表现为“首 token 要等 2~3 秒”。
 * 服务 ready 后先发一个 1-token 的空请求，把图编译提前吃掉；失败不影响服务。
 */
export async function warmupServer(port, cfg, timeoutMs = 8000) {
  if (!port) return { ok: false };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl(port)}/completion`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${cfg.apiKey || 'llm-local'}`,
      },
      body: JSON.stringify({
        prompt: 'warmup',
        n_predict: 1,
        temperature: 0,
        ignore_eos: true,
        cache_prompt: true,
        stream: false,
      }),
      signal: ctrl.signal,
    });
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}

async function warmupOnce(port, cfg) {
  if (!port || warmedPorts.has(port)) return;
  warmedPorts.add(port);
  const warm = await warmupServer(port, cfg);
  if (!warm.ok) warmedPorts.delete(port);
}

function pushLog(line) {
  const s = String(line).replace(/\x1b\[[0-9;]*m/g, '').trimEnd();
  if (!s) return;
  server.logTail.push(s);
  if (server.logTail.length > 200) server.logTail.shift();
}

async function waitReady(port, timeoutSec, candidate = server) {
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    if (candidate.status === 'error' || candidate.status === 'stopped') return false;
    const h = await health(port);
    if (h.ok) return true;
    await new Promise((r) => setTimeout(r, 1200));
  }
  return false;
}

function physicalThreads() {
  // 逻辑核的一半最接近物理核（SMT 机器）；没有超线程的机器也至少给 2 个。
  return Math.max(2, Math.min(16, Math.floor(os.cpus().length / 2) || 2));
}

/**
 * 自动挑一个“草稿模型”做投机解码：小模型先猜 8 个 token，大模型一次验证。
 * 只对实测词表/模板兼容的组合自动开启，其他模型保持原样，避免加载失败。
 */
function resolveDraftModel(cfg, model) {
  if (cfg.runtime.speculative === false) return '';
  const explicit = String(cfg.runtime.draftModel || '').trim();
  if (explicit) {
    try { if (fs.statSync(explicit).isFile()) return explicit; } catch { /* ignore */ }
  }
  const name = path.basename(String(model?.path || '')).toLowerCase();
  if (!/qwen3\.8-2b/.test(name)) return '';
  const candidates = [
    path.join(String(cfg.modelsDir || ''), 'qwen3.5-0.8b', 'Q4_K_M', 'Qwen3.5-0.8B-Q4_K_M.gguf'),
  ];
  for (const file of candidates) {
    try { if (fs.statSync(file).isFile()) return file; } catch { /* ignore */ }
  }
  return '';
}

function resolveKvCache(cfg, modelPath, ctx) {
  const raw = String(cfg.runtime.kvCache || 'auto').toLowerCase();
  if (raw !== 'auto') return raw;
  try {
    const modelGB = modelBytes(modelPath) / 1073741824;
    // 2B 在 64K 上下文下 f16 KV 实测 8.6 → 9.8 tok/s；
    // 0.8B 的 256K 上下文改用 f16 会翻倍 KV 带宽，实测反而掉到 18，所以保留 q4_0。
    return modelGB <= 4 && Number(ctx) <= 131072 ? 'f16' : 'q4_0';
  } catch {
    return 'q4_0';
  }
}

function buildArgs(cfg, model, port, opts, threads, alias, threadsBatch = threads) {
  const args = [
    '-m', model.path,
    '--host', '127.0.0.1',
    '--port', String(port),
    '-c', String(opts.ctx),
    '-t', String(threads),
    '--threads-batch', String(threadsBatch),
    '--alias', alias,
    '--api-key', cfg.apiKey || 'llm-local',
    '--jinja',
    '--reasoning-format', 'deepseek',
    '--parallel', String(Number(cfg.runtime.parallel) || 1),
  ];
  const ngl = Number(opts.ngl);
  if (Number.isFinite(ngl) && ngl >= 0) args.push('-ngl', String(ngl));
  const fa = cfg.runtime.flashAttn || 'auto';
  if (fa !== 'auto') args.push('--flash-attn', fa);
  else args.push('--flash-attn', 'auto');
  const kv = resolveKvCache(cfg, model.path, opts.ctx);
  if (kv !== 'f16') args.push('--cache-type-k', kv, '--cache-type-v', kv);
  const batch = Number(cfg.runtime.batch) || 1024;
  const ubatch = Number(cfg.runtime.ubatch) || 512;
  args.push('-b', String(batch), '-ub', String(ubatch));
  // 多轮对话把已算过的 KV 前缀复用起来；chunk 太小反而增加查找开销，256 是这几档小模型的折中。
  const cacheReuse = Number(cfg.runtime.cacheReuse ?? 256);
  if (Number.isFinite(cacheReuse) && cacheReuse > 0) args.push('--cache-reuse', String(Math.floor(cacheReuse)));
  // 限制 host 端 prompt cache 上限，避免长上下文时又悄悄吃掉几百 MB～几 GB 内存。
  const cacheRam = Number(cfg.runtime.cacheRam ?? 512);
  if (Number.isFinite(cacheRam) && cacheRam > 0) args.push('--cache-ram', String(Math.floor(cacheRam)));
  if (!cfg.runtime.mmap) args.push('--no-mmap');
  if (cfg.runtime.mlock) args.push('--mlock');
  if (cfg.runtime.warmup === false) args.push('--no-warmup');
  const effort = String(cfg.runtime.reasoningEffort || 'default');
  if (effort !== 'default') args.push('--reasoning-effort', effort);
  if (effort === 'off') args.push('--reasoning', 'off');
  args.push(...splitArgs(cfg.runtime.extraArgs));
  return args;
}

async function startServerInner(cfg, model, opts = {}) {
  const previous = (server.status === 'running' || server.status === 'loading') ? server : null;
  const oldProc = proc;
  if (previous) {
    const same = server.modelPath && model?.path && path.resolve(server.modelPath) === path.resolve(model.path);
    if (same && server.status === 'running') {
      // 状态是 running 不代表进程还活着：先探一次 /health，死了就重建。
      const healthy = await health(server.port);
      if (healthy.ok) {
        await warmupOnce(server.port, cfg);
        return server;
      }
      pushLog('已有 server 状态为 running 但 /health 不通过，重建进程');
    }
  }
  if (!model || !model.path || !fs.existsSync(model.path)) throw new Error('模型文件不存在：' + (model?.path || '(空)'));
  const rt = detectRuntime(cfg);
  if (!rt.installed) throw new Error('还没装 llama.cpp 运行时：先在面板里点「下载运行时」或填写 llama-server 路径');

  // 蓝绿切换：先在新端口把新模型拉起来，确认健康后再停旧进程。
  // 这样新模型加载失败时旧服务仍然可用，也不会出现“旧 server 已杀、新 server 没起来”
  // 导致 Harness 压缩请求 502 fetch failed 的窗口。
  let overlap = Boolean(previous && previous.pid);
  if (overlap) {
    try {
      const newBytes = fs.statSync(model.path).size;
      const freeBytes = os.freemem();
      // 留 1.5GB 给 KV cache / 系统；旧模型已经占着内存，这里只判断“还能不能放下新权重”。
      overlap = newBytes <= Math.max(0, freeBytes - 1.5 * 1024 ** 3);
    } catch {
      overlap = false;
    }
  }
  if (previous && !overlap) {
    await stopServerInner();
  }

  const cfgPort = Number(opts.port || cfg.runtime.port || 18080);
  let port = cfgPort;
  for (let i = 0; i < 12; i++) {
    if (await portFree(port + i)) {
      port = port + i;
      break;
    }
    if (i === 11) throw new Error(`端口 ${cfgPort}~${cfgPort + 11} 都被占用了`);
  }
  const threads = Number(cfg.runtime.threads) || physicalThreads();
  const autoCtx = await recommendedContext(cfg, model);
  const requestedCtx = Number(opts.ctx);
  // 页面/API 传的 ctx 只能作为上限，不能超过本机显存放得下的值。
  const ctx = requestedCtx > 0 ? Math.min(requestedCtx, autoCtx) : autoCtx;
  const plan = await computeTierPlan({ ...cfg, runtime: { ...cfg.runtime, build: rt.build } }, model, ctx);
  let ngl = Number(opts.ngl ?? cfg.runtime.ngl);
  if ((!Number.isFinite(ngl) || ngl < 0) && cfg.runtime.tiered !== false) ngl = plan.ngl;
  if (!Number.isFinite(ngl) || ngl < 0) ngl = 0;
  const alias = String(opts.alias || model.modelId || model.name || path.basename(model.path, '.gguf'));
  const threadsBatch = Number(cfg.runtime.threadsBatch) > 0
    ? Math.min(16, Number(cfg.runtime.threadsBatch))
    : Math.min(16, threads * 2);
  const args = buildArgs(cfg, model, port, { ctx, ngl }, threads, alias, threadsBatch);
  const draftModel = resolveDraftModel(cfg, model);
  if (draftModel) {
    // 2GB MX250 上 0.8B 草稿也放 GPU 只会更慢，固定 0；大显存才交给 auto。
    const draftNgl = Number(plan.vramGB) > 4 ? 'auto' : '0';
    const draftMax = Math.min(16, Math.max(2, Number(cfg.runtime.draftMax) || 8));
    const draftMin = Math.max(0, Math.min(draftMax, Number(cfg.runtime.draftMin) || 2));
    args.push(...[
      '-md', draftModel,
      '--spec-draft-ngl', draftNgl,
      '--spec-draft-n-max', String(draftMax),
      '--spec-draft-n-min', String(draftMin),
    ]);
  }

  const logFile = path.join(logDir(), `server-${Date.now()}.log`);
  const out = fs.createWriteStream(logFile, { flags: 'a' });
  out.write(`# ${new Date().toISOString()}\n# ${rt.exe} ${args.map((a) => (a.includes(' ') ? JSON.stringify(a) : a)).join(' ')}\n`);

  // 候选服务先独立存在，健康后才替换全局 server；加载失败不会破坏旧服务状态。
  const candidate = {
    status: 'loading',
    port,
    modelPath: model.path,
    modelName: alias,
    modelId: model.modelId || '',
    pid: null,
    startedAt: Date.now(),
    error: null,
    logTail: [],
    adopted: false,
    ctx,
    ngl,
    tierPlan: plan,
    threads,
    backend: rt.build || cfg.runtime.build || '',
    reasoningEffort: cfg.runtime.reasoningEffort || 'default',
    logFile,
    exe: rt.exe,
    params: {
      flashAttn: cfg.runtime.flashAttn,
      kvCache: resolveKvCache(cfg, model.path, ctx),
      batch: cfg.runtime.batch,
      ubatch: cfg.runtime.ubatch,
      mmap: cfg.runtime.mmap,
      mlock: cfg.runtime.mlock,
      parallel: cfg.runtime.parallel,
      speculative: Boolean(draftModel),
      draftModel,
    },
  };

  let child = null;
  let generation = 0;
  const launch = (useArgs) => {
    const myGen = ++generation;
    out.write(`# attempt ${myGen} ${new Date().toISOString()}\n# ${useArgs.map((a) => (a.includes(' ') ? JSON.stringify(a) : a)).join(' ')}\n`);
    const myChild = spawn(rt.exe, useArgs, { cwd: rt.dir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    candidate.pid = myChild.pid || null;
    const wire = (stream, tag) => {
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        out.write(chunk);
        for (const line of chunk.split(/\r?\n/)) if (line.trim()) pushLog(tag + line);
      });
    };
    wire(myChild.stdout, '');
    wire(myChild.stderr, '');
    myChild.on('error', (e) => {
      if (myGen !== generation) return;
      candidate.status = 'error';
      candidate.error = '启动失败：' + e.message;
      pushLog('spawn error: ' + e.message);
    });
    myChild.on('exit', (code, signal) => {
      pushLog(`llama-server 退出 code=${code} signal=${signal || ''} port=${port}`);
      if (myGen !== generation) return; // 已被回退重试替换掉的旧候选，不影响新状态
      if (candidate.status === 'loading' || candidate.status === 'running') {
        candidate.status = 'error';
        candidate.error = `llama-server 退出（code ${code}）`;
      }
      if (proc === myChild) proc = null;
      // 只有当前生效的 server 才清理 server.json；旧进程退出不能删掉新进程的状态文件。
      if (server === candidate) {
        try { fs.rmSync(SERVER_FILE, { force: true }); } catch { /* ignore */ }
      }
    });
    return myChild;
  };
  const killChild = (target) => {
    if (!target) return;
    try { target.kill(); } catch { /* ignore */ }
    if (process.platform === 'win32' && target.pid) {
      try { spawnSync('taskkill', ['/PID', String(target.pid), '/T', '/F'], { windowsHide: true, timeout: 8000 }); } catch { /* ignore */ }
    }
  };

  const timeout = Number(opts.timeoutSec || cfg.runtime.timeoutSec || 600);
  try {
    child = launch(args);
    // 草稿模型若和主模型不兼容，不能把整个槽位卡死：90 秒内没起来就回退。
    let ready = await waitReady(port, draftModel ? Math.min(timeout, 90) : timeout, candidate);
    if (!ready && draftModel) {
      pushLog('草稿模型加载失败，回退到无投机解码重试');
      killChild(child);
      await new Promise((r) => setTimeout(r, 800));
      candidate.status = 'loading';
      candidate.error = null;
      candidate.pid = null;
      // 去掉 -md 及其参数，其他参数原样保留。
      const plainArgs = args.filter((a, i) => {
        if (a === '-md') return false;
        if (args[i - 1] === '-md') return false;
        if (a === '--spec-draft-ngl' || a === '--spec-draft-n-max' || a === '--spec-draft-n-min') return false;
        if (args[i - 1] === '--spec-draft-ngl' || args[i - 1] === '--spec-draft-n-max' || args[i - 1] === '--spec-draft-n-min') return false;
        return true;
      });
      child = launch(plainArgs);
      ready = await waitReady(port, timeout, candidate);
      if (ready) candidate.params.speculative = false;
    }
    if (!ready) {
      killChild(child);
      const message = `模型在 ${timeout} 秒内没有加载完成（内存不足时可能卡在加载）`;
      if (previous && oldProc && previous.status === 'running') {
        pushLog('新模型启动失败，继续使用旧服务：' + message);
        throw new Error(message + '；旧模型仍在运行');
      }
      throw new Error(message);
    }
  } catch (e) {
    candidate.status = 'error';
    candidate.error = e.message;
    killChild(child);
    throw e;
  }
  candidate.status = 'running';

  // 新服务已就绪，再回收旧进程；如果旧进程已经退出则跳过。
  if (previous && previous.pid && previous.pid !== candidate.pid) {
    await retirePid(previous.pid, previous.port).catch(() => {});
  }

  server = candidate;
  proc = child;
  if (opts.warmup !== false) {
    await warmupOnce(port, cfg);
    if (!warmedPorts.has(port)) pushLog('预热请求未成功，首个真实请求仍会稍慢');
  }
  try {
    fs.writeFileSync(SERVER_FILE, JSON.stringify({
      pid: server.pid,
      port,
      modelPath: server.modelPath,
      modelName: server.modelName,
      modelId: server.modelId,
      apiKey: cfg.apiKey,
      startedAt: server.startedAt,
      exe: rt.exe,
      ctx: server.ctx,
      ngl: server.ngl,
      tierPlan: server.tierPlan,
      threads: server.threads,
      backend: server.backend,
      reasoningEffort: server.reasoningEffort,
    }, null, 2), 'utf8');
  } catch {
    /* ignore */
  }
  return server;
}

/** 回收旧 llama-server；蓝绿切换时旧进程不一定是 proc 全局变量。 */
async function retirePid(pid, port) {
  if (!pid) return;
  try { process.kill(pid, 0); } catch { return; }
  try { process.kill(pid); } catch { /* ignore */ }
  await new Promise((r) => setTimeout(r, 1200));
  try { process.kill(pid, 0); } catch {
    if (port) warmedPorts.delete(port);
    return;
  }
  if (process.platform === 'win32') {
    try { spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 8000 }); } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (port) warmedPorts.delete(port);
}

async function stopServerInner() {
  stopping = true;
  let pid = server.pid;
  // 独立 CLI / 新进程里模块状态是空的：从 server.json 把上次启动的 PID 找回来再杀。
  if (!pid) {
    try {
      const saved = JSON.parse(fs.readFileSync(SERVER_FILE, 'utf8'));
      if (saved && saved.pid) pid = saved.pid;
    } catch {
      /* ignore */
    }
  }
  if (proc && proc.pid) {
    try {
      proc.kill();
    } catch {
      /* ignore */
    }
    await new Promise((r) => setTimeout(r, 1200));
    if (process.platform === 'win32' && proc && proc.pid) {
      try {
        spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true, timeout: 8000 });
      } catch {
        /* ignore */
      }
    }
  } else if (pid) {
    try {
      process.kill(pid);
    } catch {
      /* ignore */
    }
    if (process.platform === 'win32') {
      try {
        spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 8000 });
      } catch {
        /* ignore */
      }
    }
  }
  proc = null;
  const stopped = { ...server };
  if (stopped.port) warmedPorts.delete(stopped.port);
  server = {
    status: 'stopped', port: null, modelPath: '', modelName: '', modelId: '',
    pid: null, startedAt: null, error: null, logTail: [], adopted: false,
    ctx: null, ngl: null, threads: null, backend: '', reasoningEffort: '', params: null,
  };
  stopping = false;
  try {
    fs.rmSync(SERVER_FILE, { force: true });
  } catch {
    /* ignore */
  }
  return stopped;
}

function withLifecycle(fn) {
  const run = lifecycle.then(fn, fn);
  lifecycle = run.catch(() => {});
  return run;
}

export function startServer(cfg, model, opts = {}) {
  return withLifecycle(() => startServerInner(cfg, model, opts));
}

export function stopServer() {
  return withLifecycle(() => stopServerInner());
}

export function restartServer(cfg, model, opts = {}) {
  return withLifecycle(async () => {
    await stopServerInner();
    return startServerInner(cfg, model, opts);
  });
}

export function serverStatus() {
  return {
    ...server,
    baseUrl: server.port ? baseUrl(server.port) : null,
    apiBase: server.port ? apiBase(server.port) : null,
    webUi: server.port ? baseUrl(server.port) : null,
  };
}

/** 插件重新加载后接管之前启动的 server（进程还在 + 健康检查通过）。 */
export async function adoptServer(cfg) {
  try {
    const saved = JSON.parse(fs.readFileSync(SERVER_FILE, 'utf8'));
    if (!saved?.pid || !saved?.port) return null;
    try {
      process.kill(saved.pid, 0);
    } catch {
      fs.rmSync(SERVER_FILE, { force: true });
      return null;
    }
    const h = await health(saved.port);
    if (!h.ok) {
      fs.rmSync(SERVER_FILE, { force: true });
      return null;
    }
    if (saved.modelPath && !fs.existsSync(saved.modelPath)) {
      fs.rmSync(SERVER_FILE, { force: true });
      return null;
    }
    server = {
      status: 'running',
      port: saved.port,
      modelPath: saved.modelPath || '',
      modelName: saved.modelName || path.basename(saved.modelPath || '', '.gguf'),
      modelId: saved.modelId || '',
      pid: saved.pid,
      startedAt: saved.startedAt || null,
      error: null,
      logTail: ['（已接管上一次启动的 llama-server，PID ' + saved.pid + '）'],
      adopted: true,
      ctx: saved.ctx || cfg.runtime?.ctx || null,
      ngl: saved.ngl ?? cfg.runtime?.ngl ?? null,
      tierPlan: saved.tierPlan || null,
      threads: saved.threads || cfg.runtime?.threads || null,
      backend: saved.backend || cfg.runtime?.build || '',
      reasoningEffort: saved.reasoningEffort || cfg.runtime?.reasoningEffort || 'default',
      params: null,
    };
    await warmupOnce(server.port, cfg);
    return server;
  } catch {
    return null;
  }
}

export async function chat(cfg, messages, opts = {}) {
  if (server.status !== 'running') throw new Error('本地模型还没启动：先 start（或在「本地模型」设置页点启动）');
  const body = {
    model: server.modelName || 'local',
    messages,
    temperature: opts.temperature ?? 0.6,
    max_tokens: Math.max(1, Math.min(
      Math.max(512, Math.floor((Number(server.ctx) || 8192) / 4)),
      Number(opts.maxTokens) || 512,
    )),
    stream: false,
  };
  if (opts.reasoningEffort && opts.reasoningEffort !== 'default') body.reasoning_effort = opts.reasoningEffort;
  if (opts.chatTemplateKwargs) body.chat_template_kwargs = opts.chatTemplateKwargs;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Number(opts.timeoutMs) || 180000);
  try {
    const res = await fetch(`${apiBase(server.port)}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey || 'llm-local'}` },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error('本地模型返回 HTTP ' + res.status + '：' + (await res.text()).slice(0, 300));
    const j = await res.json();
    const message = j.choices?.[0]?.message || {};
    const text = message.content ?? '';
    return { text, reasoning: message.reasoning_content || '', usage: j.usage || null, model: j.model || body.model };
  } finally {
    clearTimeout(timer);
  }
}

export function listModels(cfg) {
  return server.status === 'running'
    ? fetch(`${apiBase(server.port)}/models`, { headers: { authorization: `Bearer ${cfg.apiKey || 'llm-local'}` } })
      .then((r) => r.json())
      .then((j) => j.data || [])
      .catch(() => [])
    : Promise.resolve([]);
}
