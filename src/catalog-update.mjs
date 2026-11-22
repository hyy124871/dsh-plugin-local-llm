// 在线模型库更新：从 hf-mirror 的 Unsloth 作者页发现新的 GGUF 仓库，
// 读取 tree API 生成量化档，缓存到 ~/.dsh/local-llm/catalog-cache.json。
// 只在用户点「检查更新」时联网；启动时只用缓存，不拖慢面板。

import fs from 'node:fs';
import { FAMILIES } from './catalog.mjs';
import { readCatalogCache, writeCatalogCache, patchConfig } from './settings.mjs';

const AUTHOR_API = 'https://hf-mirror.com/api/models?author=unsloth&limit=100&sort=lastModified&direction=-1';
const MODEL_API = 'https://hf-mirror.com/api/models';
const SEARCHES = ['Qwen3.5', 'DeepSeek-V4', 'DeepSeek-R1', 'MiniMax-M3.1', 'Kimi-K3.1', 'GLM-5.3', 'Qwen3.8', 'Hy4', 'Llama-4', 'MiniCPM5'];
const WANTED = /(Qwen3\.5-[0-9.]+B(?:-A[0-9.]+B)?|DeepSeek-V4-Pro(?:-\d+)?|DeepSeek-R1(?:-0528)?|MiniMax-M[0-9.]+-Flash|Kimi-K[0-9.]+-Pro|GLM-[0-9.]+-Flash|Qwen[0-9.]+-[0-9.]+B|Hy4(?:-flash)?|Llama-4(?:-Scout|-Maverick)?|MiniCPM5)/i;
const TRUSTED = /^(unsloth|KarLexAI|bartowski|QuantFactory|TheBloke|openbmb|AngelSlim)\//i;
const UNSAFE_NAME = /(abliterated|uncensored|heretic|nsfw|lewd|erotic|xxx)/i;
const SKIP = /(mmproj|imatrix|mtp[-_]|dspark|bf16|f16|fp16|fp32)/i;

async function fetchJson(url, timeoutMs = 30000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { 'user-agent': 'dsh-plugin-local-llm/0.2.2' }, signal: ctrl.signal, redirect: 'follow' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function slimName(repo) {
  return repo.split('/').pop().replace(/-GGUF$/i, '');
}

function inferBits(id) {
  const s = String(id).toUpperCase();
  if (/IQ1|Q1_/.test(s)) return 1;
  if (/IQ2|Q2_/.test(s)) return 2;
  if (/IQ3|Q3_/.test(s)) return 3;
  if (/MXFP4|IQ4|Q4_/.test(s)) return 4;
  if (/Q5_/.test(s)) return 5;
  if (/Q6_/.test(s)) return 6;
  if (/Q8_/.test(s)) return 8;
  return 4;
}

function quantIdFromFile(name) {
  const base = name.replace(/\.gguf$/i, '');
  const m = base.match(/(UD-[A-Za-z0-9_]+|MXFP4_MOE|IQ[0-9]_[A-Za-z0-9_]+|Q[0-9]_[A-Za-z0-9_]+)/);
  return m ? m[1] : base.slice(-36);
}

function groupQuants(files) {
  const groups = new Map();
  for (const f of files) {
    if (!/\.gguf$/i.test(f.path) || SKIP.test(f.path)) continue;
    const parts = f.path.split('/');
    const dir = parts.length > 1 ? parts[0] : '';
    const base = parts[parts.length - 1].replace(/\.gguf$/i, '');
    const key = dir || quantIdFromFile(base);
    const id = dir || quantIdFromFile(base);
    if (!groups.has(key)) groups.set(key, { id, files: [], bytes: 0, match: dir || quantIdFromFile(base) });
    const g = groups.get(key);
    g.files.push(f);
    g.bytes += Number(f.size) || 0;
  }
  return [...groups.values()]
    .map((g) => ({
      id: g.id,
      label: g.id + ' · ' + inferBits(g.id) + '-bit',
      bits: inferBits(g.id),
      gb: Math.round((g.bytes / 1073741824) * 100) / 100,
      match: g.match,
      note: '',
    }))
    .filter((q) => q.gb > 0.05)
    .sort((a, b) => a.gb - b.gb)
    .slice(0, 10);
}

function inferFamily(repo) {
  const name = slimName(repo);
  const p = name.match(/([0-9.]+B)(?:-A([0-9.]+)B)?/i);
  const paramsB = p ? Number(p[1].replace(/B$/i, '')) : 120;
  const isMoe = /-A[0-9.]+B|MoE/i.test(name);
  const vendor = repo.split('/')[0].toLowerCase().includes('unsloth')
    ? name.split(/[-\s]/)[0]
    : repo.split('/')[0];
  return {
    id: repo.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase(),
    name,
    vendor,
    params: p ? p[1] + (p[2] ? '-A' + p[2] + 'B' : '') : 'MoE',
    paramsB,
    arch: isMoe ? 'MoE' : 'Dense',
    mode: isMoe ? 'moe' : 'dense',
    tag: paramsB <= 10 ? '在线新增' : paramsB <= 32 ? '在线新增' : '大内存',
    tier: paramsB <= 10 ? 3 : paramsB <= 32 ? 2 : 1,
    repo,
    sourceRepo: repo.replace(/unsloth\//, '').replace(/-GGUF$/i, ''),
    license: '见仓库',
    homepage: 'https://huggingface.co/' + repo,
    note: '在线模型库更新发现的 ' + name + ' GGUF 仓库，已缓存到本机。',
    discovered: true,
    quants: [],
  };
}

export async function discoverCatalog({ force = false } = {}) {
  const cache = readCatalogCache();
  // 自动检查每天最多一次；手动「检查更新」始终强制。
  if (!force && cache.updatedAt && cache.families.length) {
    const age = Date.now() - Date.parse(cache.updatedAt);
    if (Number.isFinite(age) && age >= 0 && age < 24 * 3600 * 1000) {
      return { ok: true, skipped: true, checked: 0, added: [], updated: [], totalCached: cache.families.length, updatedAt: cache.updatedAt };
    }
  }
  const existingRepos = new Set([
    ...FAMILIES.map((f) => f.repo),
    ...cache.families.map((f) => f.repo),
  ]);
  const author = await fetchJson(AUTHOR_API, 35000);
  const all = Array.isArray(author) ? author.slice() : [];
  // 作者页只按 lastModified 给最新 100 个，老仓库会翻不到；再用关键词搜一遍各家族。
  for (const q of SEARCHES) {
    try {
      const extra = await fetchJson(`${MODEL_API}?search=${encodeURIComponent(q)}&limit=30&sort=lastModified&direction=-1`, 20000);
      if (Array.isArray(extra)) all.push(...extra);
    } catch {
      /* 单个关键词失败不阻塞 */
    }
  }
  const repos = [...new Set(all
    .map((x) => String(x.id || x.modelId || ''))
    .filter((id) => id && /-GGUF$/i.test(id) && WANTED.test(id) && TRUSTED.test(id) && !UNSAFE_NAME.test(id)))];
  const newRepos = repos.filter((id) => !existingRepos.has(id)).slice(0, 12);
  const added = [];
  const updated = [];
  const families = cache.families.slice();

  for (const repo of newRepos) {
    try {
      const tree = await fetchJson(`${MODEL_API}/${repo}/tree/main?recursive=true`, 35000);
      const quants = groupQuants(Array.isArray(tree) ? tree : []);
      if (!quants.length) continue;
      const fam = inferFamily(repo);
      fam.quants = quants;
      families.push(fam);
      added.push({ id: fam.id, name: fam.name, repo: fam.repo, quants: quants.length });
    } catch {
      /* 单个仓库失败不阻塞整体更新 */
    }
  }

  // 已缓存家族也刷新一次体积/新增量化档，但最多 8 个，避免一次请求过多。
  for (const fam of cache.families.slice(0, 8)) {
    try {
      const tree = await fetchJson(`${MODEL_API}/${fam.repo}/tree/main?recursive=true`, 30000);
      const quants = groupQuants(Array.isArray(tree) ? tree : []);
      if (!quants.length) continue;
      const idx = families.findIndex((x) => x.repo === fam.repo);
      if (idx >= 0) {
        families[idx] = { ...families[idx], quants };
        updated.push({ id: fam.id, name: fam.name, quants: quants.length });
      }
    } catch {
      /* ignore */
    }
  }

  const next = { updatedAt: new Date().toISOString(), families };
  writeCatalogCache(next);
  try {
    patchConfig({ catalogLastCheckAt: next.updatedAt });
  } catch {
    /* 配置写入失败不影响缓存 */
  }
  return {
    ok: true,
    checked: repos.length,
    added,
    updated,
    totalCached: families.length,
    updatedAt: next.updatedAt,
    force: Boolean(force),
  };
}

export function clearCatalogCache() {
  try {
    const file = readCatalogCache();
    if (file.updatedAt) writeCatalogCache({ updatedAt: '', families: [] });
  } catch {
    /* ignore */
  }
}

// 给测试/脚本一个不联网的入口。
export function cachedFamilies() {
  try {
    const raw = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    return raw?.dsh?.catalog?.families || [];
  } catch {
    return [];
  }
}
