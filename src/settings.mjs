// 配置存储：~/.dsh/local-llm/config.json
// 只放"用户偏好 + 路径 + 端口 + 已导入模型条目"这类可热改的东西；
// 大文件（模型、运行时、日志、模型库缓存）另有自己的文件。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const DATA_DIR = process.env.LOCAL_LLM_HOME
  ? path.resolve(process.env.LOCAL_LLM_HOME)
  : path.join(os.homedir(), '.dsh', 'local-llm');

export const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
export const CATALOG_FILE = path.join(DATA_DIR, 'catalog-cache.json');
export const MODELS_DEFAULT = defaultModelsDir();

function defaultModelsDir() {
  if (process.platform === 'win32') {
    // 先挑可用空间最大的固定盘，避免默认塞进系统盘。
    const roots = [];
    for (const letter of ['D', 'E', 'F', 'C']) {
      const root = letter + ':\\';
      try {
        if (!fs.existsSync(root)) continue;
        const st = fs.statfsSync(root);
        const free = Number(st.bavail) * Number(st.bsize);
        roots.push({ root, free });
      } catch {
        /* ignore */
      }
    }
    roots.sort((a, b) => b.free - a.free);
    if (roots.length) return path.join(roots[0].root, 'llama-models');
  }
  return path.join(os.homedir(), 'llama-models');
}

function randomKey() {
  return 'llm-' + crypto.randomBytes(16).toString('hex');
}

export function defaults() {
  return {
    version: 2,
    enabled: true,
    modelsDir: MODELS_DEFAULT,
    extraModelDirs: [],
    source: 'auto',
    hfToken: '',
    proxy: '',
    download: {
      concurrency: 3,
      dir: '',
    },
    runtime: {
      path: '',
      backend: 'auto',
      version: '',
      port: 18080,
      ctx: 65536,
      threads: 0,
      threadsBatch: 0,
      ngl: -1,
      tiered: true,
      extraArgs: '',
      autoStart: false,
      pausedByUser: false,
      flashAttn: 'auto',
      kvCache: 'auto',
      batch: 1024,
      ubatch: 512,
      mmap: true,
      mlock: false,
      parallel: 1,
      cacheReuse: 256,
      cacheRam: 512,
      // 投机解码：Qwen3.8-2B 可用 Qwen3.5-0.8B 当草稿，但本机 4 核 CPU 实测
      // 8.9 → 8.5 tok/s，收益为负；默认关闭，只保留手动开关。
      speculative: false,
      draftModel: '',
      draftMax: 8,
      draftMin: 2,
      warmup: true,
      reasoningEffort: 'default',
      timeoutSec: 600,
    },
    gateway: {
      enabled: true,
      port: 18081,
      actualPort: 0,
      // 本地小模型扛不住 Harness 标准模式约 2.7 万 token 的系统提示与工具表；
      // 超过阈值时只保留精简系统提示和最近对话，避免 CPU 预热几十分钟。
      leanPrompt: true,
      leanThresholdChars: 18000,
      maxSystemChars: 1500,
      maxConversationChars: 3000,
      // 输出上限：普通请求 8192，精简/压缩请求 2048；
      // 长 HTML 不再被旧的 4096/1024 一刀切截断。
      maxOutputTokens: 32768,
      leanMaxOutputTokens: 4096,
    },
    harness: {
      autoConnect: true,
      providerId: 'local-llm',
      reasoningEffort: 'medium',
      lastFingerprint: '',
      lastSyncAt: '',
      lastError: '',
      prevDefault: null,
    },
    pluginUpdate: {
      // 只允许 HTTPS；留空时设置页显示“未配置更新源”，不会误报“可更新”。
      url: '',
      autoCheckHours: 12,
    },
    apiKey: randomKey(),
    customModels: [],
    importedModels: [],
    placements: {},
    catalogAutoUpdate: true,
    catalogLastCheckAt: '',
  };
}

function isObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

/** 深合并，数组整体替换（自定义模型、导入模型都是数组）。 */
export function merge(base, patch) {
  if (!isObject(patch)) return base;
  const out = Array.isArray(base) ? patch.slice() : { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (isObject(v) && isObject(out[k])) out[k] = merge(out[k], v);
    else out[k] = v;
  }
  return out;
}

export function loadConfig() {
  const d = defaults();
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(CONFIG_FILE)) {
      writeConfig(d);
      return d;
    }
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    const merged = merge(d, raw);
    if (!merged.apiKey) merged.apiKey = randomKey();
    if (!Array.isArray(merged.importedModels)) merged.importedModels = [];
    if (!Array.isArray(merged.extraModelDirs)) merged.extraModelDirs = [];
    if (!isObject(merged.placements)) merged.placements = {};
    // 旧默认 4096/8192 会把 Spark 等模型卡在 8K，工具定义一进来就没输出空间。
    // 新语义：ctx 是“上限”，默认 65536；需要更长上下文可手动调高，代价是更慢。
    if (merged.runtime && [4096, 8192].includes(Number(merged.runtime.ctx))) {
      merged.runtime.ctx = 65536;
      writeConfig(merged);
    }
    return merged;
  } catch (e) {
    // 配置损坏时不覆盖用户文件，先用默认值把插件跑起来。
    console.warn('[local-llm] 读取配置失败：' + e.message);
    return d;
  }
}

export function writeConfig(cfg) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = CONFIG_FILE + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8');
  fs.renameSync(tmp, CONFIG_FILE);
  return cfg;
}

export function patchConfig(patch) {
  const next = merge(loadConfig(), patch);
  // 基础卫生：端口/上下文落在合理区间，路径必须是绝对路径（允许 ~ 展开）。
  if (next.runtime) {
    next.runtime.port = clampInt(next.runtime.port, 1024, 65535, 18080);
    next.runtime.ctx = clampInt(next.runtime.ctx, 512, 262144, 65536);
    next.runtime.threads = clampInt(next.runtime.threads, 0, 128, 0);
    next.runtime.ngl = clampInt(next.runtime.ngl, -1, 999, -1);
    next.runtime.batch = clampInt(next.runtime.batch, 32, 4096, 512);
    next.runtime.ubatch = clampInt(next.runtime.ubatch, 16, 2048, 256);
    next.runtime.parallel = clampInt(next.runtime.parallel, 1, 16, 1);
    next.runtime.timeoutSec = clampInt(next.runtime.timeoutSec, 30, 1800, 600);
    if (!['auto', 'on', 'off'].includes(next.runtime.flashAttn)) next.runtime.flashAttn = 'auto';
    if (!['auto', 'f16', 'q8_0', 'q4_0'].includes(next.runtime.kvCache)) next.runtime.kvCache = 'auto';
    if (!['default', 'off', 'low', 'medium', 'high'].includes(next.runtime.reasoningEffort)) next.runtime.reasoningEffort = 'default';
  }
  if (next.gateway) {
    next.gateway.port = clampInt(next.gateway.port, 1024, 65535, 18081);
    next.gateway.maxOutputTokens = clampInt(next.gateway.maxOutputTokens, 1024, 32768, 32768);
    next.gateway.leanMaxOutputTokens = clampInt(next.gateway.leanMaxOutputTokens, 512, 16384, 4096);
  }
  if (next.harness && !['off', 'low', 'medium', 'high'].includes(next.harness.reasoningEffort)) next.harness.reasoningEffort = 'medium';
  if (typeof next.modelsDir === 'string') next.modelsDir = expandHome(next.modelsDir);
  if (Array.isArray(next.extraModelDirs)) next.extraModelDirs = next.extraModelDirs.map(expandHome).filter(Boolean);
  if (!next.apiKey) next.apiKey = randomKey();
  writeConfig(next);
  return next;
}

export function clampInt(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

export function expandHome(p) {
  if (!p) return p;
  const s = String(p);
  if (s === '~') return os.homedir();
  if (s.startsWith('~/') || s.startsWith('~\\')) return path.join(os.homedir(), s.slice(2));
  return path.resolve(s);
}

export function ensureDir(p) {
  try {
    fs.mkdirSync(p, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

/** 面板展示用：不要把密钥原样打印给模型，掩码只留尾巴。 */
export function mask(v) {
  const s = String(v || '');
  if (!s) return '';
  if (s.length <= 8) return '••••';
  return s.slice(0, 3) + '••••' + s.slice(-4);
}

/** 给前端的配置视图（密钥掩码）。 */
export function publicConfig(cfg) {
  return {
    ...cfg,
    apiKeyMasked: mask(cfg.apiKey),
    hfTokenMasked: mask(cfg.hfToken),
    hfToken: cfg.hfToken ? mask(cfg.hfToken) : '',
  };
}

export function configPath() {
  return CONFIG_FILE;
}

export function logDir() {
  const d = path.join(DATA_DIR, 'logs');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

export function readCatalogCache() {
  try {
    const raw = JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8'));
    return {
      updatedAt: raw.updatedAt || '',
      families: Array.isArray(raw.families) ? raw.families : [],
    };
  } catch {
    return { updatedAt: '', families: [] };
  }
}

export function writeCatalogCache(cache) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = CATALOG_FILE + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), 'utf8');
  fs.renameSync(tmp, CATALOG_FILE);
  return cache;
}
