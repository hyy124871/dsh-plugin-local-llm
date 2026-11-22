// 自动接入 Harness：把本地网关注册成官方 llm-pi-ai 的“自定义模型 API”。
// - provider 配置写进 profile 的 cordis.patch.yml（通过 configEditor，支持热加载）
// - API Key 自动生成并写进 Harness 凭据库，用户不需要手填
// - 模型列表随下载/导入变化自动同步；默认模型只在用户点「设为默认」时切换

import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, patchConfig, ensureDir, DATA_DIR } from './settings.mjs';
import { recommendedContext } from './runtime.mjs';

export const PROVIDER_ID = 'local-llm';
export const CREDENTIAL_REF = 'LOCAL_LLM_API_KEY';

let host = null;

export function setHost(ctx) {
  host = ctx;
}

export function hasHost() {
  return Boolean(host && host.configEditor);
}

function editor() {
  if (!host || !host.configEditor) throw new Error('Harness 配置编辑服务还没就绪');
  return host.configEditor;
}

// Harness 的 configEditor 同一时刻只能有一个 HMR 事务。模型预热、切换默认模型、
// 网关切模型和下载完成后的自动同步都可能并发写配置，所以所有写入统一排队；
// 另外 Loader 自己正在应用补丁时也会返回 "HMR transactions cannot be nested"，
// 这里再做一次短退避重试，避免把错误直接暴露到模型菜单。
let configQueue = Promise.resolve();
function withConfigLock(fn) {
  const run = configQueue.then(fn, fn);
  configQueue = run.catch(() => {});
  return run;
}

async function editWithRetry(entry, fn, attempts = 4) {
  for (let i = 0; i < attempts; i++) {
    try {
      return await editor().edit(entry, fn);
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (/HMR transactions cannot be nested/i.test(msg) && i < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, 900));
        continue;
      }
      if (/no longer available|changed during reload/i.test(msg) && i < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        continue;
      }
      throw e;
    }
  }
}

function credentialService() {
  return host ? host.credentials : null;
}

function findEntry(id) {
  const entries = editor().entries();
  const hit = entries.find((e) => e.options && e.options.id === id);
  if (!hit) throw new Error(`Harness 里没有找到 ${id} 这个配置项`);
  return hit;
}

export function providerEntry() {
  try {
    return editor().entries().find((e) => e.options && e.options.id === 'llm-pi-ai') || null;
  } catch {
    return null;
  }
}

export function currentProviderConfig() {
  return providerEntry()?.options?.config || {};
}

export function currentDefaultModel() {
  try {
    return findEntry('agent-default-model').options.config || {};
  } catch {
    return {};
  }
}

function logHarnessError(scope, error) {
  try {
    const file = path.join(DATA_DIR, 'harness-error.log');
    ensureDir(DATA_DIR);
    fs.appendFileSync(file, new Date().toISOString() + ' ' + scope + ': ' + (error && error.message || error) + '\n');
  } catch {
    /* ignore */
  }
}

function localLimits(cfg) {
  const ctx = Math.max(512, Number(cfg.runtime.ctx) || 4096);
  const maxTokens = outputLimitFor(ctx);
  const headroom = Math.max(64, Math.min(1024, Math.floor(ctx / 4), ctx - maxTokens - 64));
  const retain = Math.max(32, Math.min(512, Math.floor((ctx - maxTokens) * 0.16)));
  // 大窗口给 Harness 的系统提示和工具 schema 留足空间；小窗口维持 0.7 保护历史。
  const thresholdRatio = ctx >= 16384 ? 0.9 : 0.7;
  return { ctx, maxTokens, headroom, retain, thresholdRatio };
}

/**
 * 输出上限不能一刀切 1024：
 * 256K 窗口只给 1024 completion，用户写长文会立刻被“输出 token 上限”截断。
 * 这里按模型实际窗口分档，最大 32768；同时保证不超过窗口的 1/4，
 * 小窗口（MiniCPM Q8 的 8192）仍留出历史和 headroom。
 */
function outputLimitFor(contextWindow) {
  const c = Math.max(4096, Number(contextWindow) || 4096);
  // 与 gateway 的 max_tokens 规则保持一致：最多吃掉 1/4 上下文，普通请求上限 32768。
  // 65K → 16384，32K → 8192，16K → 4096；避免 Harness 以为 8192、网关却给 16K 的两套账。
  const out = Math.max(1024, Math.min(32768, Math.floor(c / 4)));
  return Math.max(256, Math.min(out, Math.floor(c / 4)));
}

// 顶层 compaction 兜底取所有本地模型里最小的输出预算，避免 Q8 小窗口被
// 256K 模型的 32K completion 预留挤成负预算；每个模型自己的 policy 仍然用各自上限。
function topOutputLimit(models, fallback = 1024) {
  if (!models || !models.length) return Math.min(4096, fallback);
  return Math.min(...models.map((m) => outputLimitFor(m.contextWindow || m.ctx || fallback)));
}

function providerModels(models, cfg) {
  const { ctx } = localLimits(cfg);
  return models
    .filter((m) => m && m.modelId)
    .map((m) => {
      const contextWindow = Math.max(4096, Number(m.contextWindow) || ctx);
      return {
        id: m.modelId,
        name: `${m.familyName || '本地'} ${m.label || m.quantId || ''}`.trim().slice(0, 80),
        contextWindow,
        maxTokens: outputLimitFor(contextWindow),
        input: ['text'],
        reasoningEfforts: {
          off: null,
          low: 'low',
          medium: 'medium',
          high: 'high',
        },
      };
    });
}

function buildProvider(models, cfg, baseURL) {
  const { ctx, maxTokens } = localLimits(cfg);
  const maxCtx = models.reduce((n, m) => Math.max(n, Number(m.contextWindow) || 0), ctx);
  return {
    displayName: '本地模型',
    api: 'openai-completions',
    baseURL,
    apiKeyEnv: CREDENTIAL_REF,
    defaultContextWindow: maxCtx,
    defaultMaxTokens: maxTokens,
    models: providerModels(models, cfg),
    headers: { 'x-dsh-local-llm': '1' },
    timeoutMs: Math.max(60000, (Number(cfg.runtime.timeoutSec) || 600) * 1000),
    streamIdleTimeoutMs: Math.max(60000, (Number(cfg.runtime.timeoutSec) || 600) * 1000),
    retryPolicy: { mode: 'normal', maxRetries: 1 },
  };
}

export async function ensureCredential(cfg) {
  const cs = credentialService();
  if (!cs) return false;
  try {
    if (cs.describe) {
      const d = await cs.describe(CREDENTIAL_REF);
      if (d && d.configured) return true;
    }
    await cs.set(CREDENTIAL_REF, cfg.apiKey || 'llm-local');
    return true;
  } catch (e) {
    const file = path.join(DATA_DIR, 'harness-error.log');
    try { ensureDir(DATA_DIR); fs.appendFileSync(file, new Date().toISOString() + ' credential: ' + e.message + '\n'); } catch { /* ignore */ }
    return false;
  }
}

/** 生成 profile patch 里的 compaction-basic 条目；modelPolicies 只覆盖本地路由。 */
function compactionPatchBlock(models, policy) {
  const lines = [
    '- id: compaction-basic',
    '  config:',
    '    thresholdRatio: ' + policy.thresholdRatio,
    '    headroomTokens: ' + policy.headroom,
    '    maxTokens: ' + topOutputLimit(models, policy.maxTokens),
    '    retainTokens: ' + policy.retain,
    models.length ? '    modelPolicies:' : '    modelPolicies: []',
  ];
  for (const m of models) {
    lines.push(
      '      - provider: ' + PROVIDER_ID,
      '        model: ' + m.modelId,
      '        thresholdRatio: ' + policy.thresholdRatio,
      '        headroomTokens: ' + policy.headroom,
      '        maxTokens: ' + outputLimitFor(m.contextWindow || policy.ctx),
      '        retainTokens: ' + policy.retain,
      '        summarizationProvider: ' + PROVIDER_ID,
      '        summarizationModel: ' + m.modelId,
    );
  }
  return lines.join('\n') + '\n';
}

function readCompactionPatch() {
  try {
    const text = fs.readFileSync(editor().documentPath, 'utf8');
    const start = text.search(/^- id: compaction-basic\s*$/m);
    if (start < 0) return { text, start: -1, end: -1, block: '' };
    const rest = text.slice(start + 1);
    const next = rest.search(/^- id:/m);
    const end = next < 0 ? text.length : start + 1 + next;
    return { text, start, end, block: text.slice(start, end) };
  } catch {
    return { text: '', start: -1, end: -1, block: '' };
  }
}

/** 已经由 profile patch 精确写下同一组本地模型策略时，不再重复触发 configEditor。 */
function hasCompactionPatch(models, policy) {
  if (!models.length) return false;
  const { block } = readCompactionPatch();
  if (!block.includes('provider: ' + PROVIDER_ID)) return false;
  if (!block.includes('headroomTokens: ' + policy.headroom)) return false;
  if (!block.includes('maxTokens: ' + topOutputLimit(models, policy.maxTokens))) return false;
  return models.every((m) => block.includes('model: ' + m.modelId + '\n')
    && block.includes('maxTokens: ' + outputLimitFor(m.contextWindow || policy.ctx)));
}

/** 兜底：configEditor 无法编辑 base insert 里的 compaction-basic 时，直接写 profile patch。 */
async function writeCompactionPatch(models, policy) {
  const { text, start, end } = readCompactionPatch();
  const block = compactionPatchBlock(models, policy);
  const next = start < 0 ? text.replace(/\s*$/, '\n') + block : text.slice(0, start) + block + text.slice(end).replace(/^\s*\n/, '\n');
  const file = editor().documentPath;
  try { fs.copyFileSync(file, file + '.bak-local-llm'); } catch { /* ignore */ }
  const tmp = file + '.tmp-local-llm';
  fs.writeFileSync(tmp, next, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
  // 写 patch 后触发一次普通 configEditor 编辑，让 Loader 读到新增的 compaction 条目并热加载。
  try {
    const entry = providerEntry() || findEntry('agent-default-model');
    if (entry) await editWithRetry(entry, (current) => current);
  } catch { /* 下一次启动会自然加载 */ }
  return true;
}

function presetWithPolicy(plugins, localPolicies) {
  const list = structuredClone(Array.isArray(plugins) ? plugins : []);
  const group = list.find((row) => row && row.id === 'compaction');
  if (!group) throw new Error('Agent 预设里没有 compaction 分组');
  if (!Array.isArray(group.config)) group.config = [];
  let basic = group.config.find((row) => row && row.id === 'compaction-basic');
  if (!basic) {
    basic = { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic' };
    group.config.push(basic);
  }
  const existing = Array.isArray(basic.config?.modelPolicies) ? basic.config.modelPolicies : [];
  const first = localPolicies[0];
  const safeTopMax = localPolicies.length
    ? Math.min(...localPolicies.map((p) => Number(p.maxTokens) || 1024))
    : 1024;
  basic.config = {
    ...(basic.config || {}),
    // 顶层兜底：即使新模型还没有逐模型策略，也不会退回 Harness 的
    // 2048 completion + 65536 headroom 默认值而把 32768 窗口卡死。
    ...(first ? {
      thresholdRatio: first.thresholdRatio,
      headroomTokens: first.headroomTokens,
      maxTokens: safeTopMax,
      retainTokens: first.retainTokens,
    } : {}),
    modelPolicies: existing.filter((p) => p && p.provider !== PROVIDER_ID).concat(localPolicies),
  };
  return list;
}

function presetHasPolicy(plugins, localPolicies) {
  if (!localPolicies.length) return true;
  const group = (plugins || []).find((row) => row && row.id === 'compaction');
  const basic = group?.config?.find((row) => row && row.id === 'compaction-basic');
  const policies = basic?.config?.modelPolicies;
  if (!Array.isArray(policies)) return false;
  return localPolicies.every((want) => policies.some((p) => p && p.provider === want.provider
    && p.model === want.model
    && p.thresholdRatio === want.thresholdRatio
    && p.headroomTokens === want.headroomTokens
    && p.maxTokens === want.maxTokens
    && p.retainTokens === want.retainTokens
    && p.summarizationProvider === want.summarizationProvider
    && p.summarizationModel === want.summarizationModel));
}

async function syncPresetCompaction(cfg, models) {
  const policy = localLimits(cfg);
  const localPolicies = (models || []).filter((m) => m && m.modelId).map((m) => ({
    provider: PROVIDER_ID,
    model: String(m.modelId),
    thresholdRatio: policy.thresholdRatio,
    headroomTokens: policy.headroom,
    maxTokens: outputLimitFor(m.contextWindow || policy.ctx),
    retainTokens: policy.retain,
    summarizationProvider: PROVIDER_ID,
    summarizationModel: String(m.modelId),
  }));
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const entry = findEntry('preset-standard');
      if (presetHasPolicy(entry.options.config?.plugins, localPolicies)) {
        return { ok: true, models: localPolicies.length, headroomTokens: policy.headroom, maxTokens: policy.maxTokens, retainTokens: policy.retain, target: 'preset-standard', source: 'preset' };
      }
      await editWithRetry(entry, (current) => ({
        ...current,
        plugins: presetWithPolicy(current.plugins, localPolicies),
      }));
      return { ok: true, models: localPolicies.length, headroomTokens: policy.headroom, maxTokens: policy.maxTokens, retainTokens: policy.retain, target: 'preset-standard' };
    } catch (e) {
      if (/HMR transactions cannot be nested/i.test(String(e && e.message || e))) {
        // 启动阶段 Loader 正在应用补丁时不能再开 HMR；等这一轮结束再试。
        await new Promise((resolve) => setTimeout(resolve, 1200));
        continue;
      }
      if (attempt < 3 && /no longer available|changed during reload/i.test(String(e && e.message || e))) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        continue;
      }
      throw e;
    }
  }
  return { ok: false, skipped: true };
}

async function syncCompactionPolicy(cfg, models) {
  if (!hasHost()) return { ok: false, skipped: true };
  try {
    return await syncPresetCompaction(cfg, models);
  } catch (e) {
    if (!/没有找到 preset-standard/i.test(String(e && e.message || e))) throw e;
  }
  const { maxTokens, headroom, retain, thresholdRatio } = localLimits(cfg);
  const policy = { maxTokens: topOutputLimit(models, maxTokens), headroom, retain, thresholdRatio };
  const localPolicies = (models || []).filter((m) => m && m.modelId).map((m) => ({
    provider: PROVIDER_ID,
    model: String(m.modelId),
    thresholdRatio,
    headroomTokens: headroom,
    maxTokens: outputLimitFor(m.contextWindow || cfg.runtime.ctx),
    retainTokens: retain,
    summarizationProvider: PROVIDER_ID,
    summarizationModel: String(m.modelId),
  }));
  if (hasCompactionPatch(models, policy)) {
    return { ok: true, models: localPolicies.length, headroomTokens: headroom, maxTokens, retainTokens: retain, source: 'profile' };
  }
  // 旧组合没有 Agent 预设时，才退回编辑顶层 compaction-basic。
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const entry = findEntry('compaction-basic');
      await editWithRetry(entry, (current) => {
        const existing = Array.isArray(current.modelPolicies) ? current.modelPolicies : [];
        return {
          ...current,
          modelPolicies: existing.filter((p) => p && p.provider !== PROVIDER_ID).concat(localPolicies),
        };
      });
      return { ok: true, models: localPolicies.length, headroomTokens: headroom, maxTokens, retainTokens: retain };
    } catch (e) {
      if (attempt < 3 && /no longer available|changed during reload/i.test(String(e && e.message || e))) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        continue;
      }
      if (/no longer available|changed during reload/i.test(String(e && e.message || e))) {
        await writeCompactionPatch(models, { ...policy, models: localPolicies });
        return { ok: true, models: localPolicies.length, headroomTokens: headroom, maxTokens, retainTokens: retain, source: 'profile-patch' };
      }
      throw e;
    }
  }
  return { ok: false, skipped: true };
}

async function syncProviderInner(cfg, models, opts = {}) {
  if (!hasHost()) throw new Error('Harness 配置编辑服务还没就绪，稍后会自动重试');
  const baseURL = String(opts.baseURL || '').trim();
  if (!baseURL) throw new Error('本地网关还没启动，无法写 Harness 端点');
  if (!models.length) {
    // 没有本地模型时不要留下非空 models 的非法 provider，直接移除本地 provider。
    const entry = providerEntry();
    if (entry && currentProviderConfig().providers && currentProviderConfig().providers[PROVIDER_ID]) {
      await editWithRetry(entry, (current) => {
        const providers = { ...(current.providers || {}) };
        delete providers[PROVIDER_ID];
        return { ...current, providers };
      });
    }
    try {
      await syncCompactionPolicy(cfg, []);
    } catch (e) {
      logHarnessError('compaction-cleanup', e);
    }
    patchConfig({ harness: { lastFingerprint: '', lastSyncAt: new Date().toISOString(), lastError: '' } });
    return { ok: true, configured: false, models: 0, baseURL };
  }
  // 每个模型按本机显存计算“真正能全量进 GPU 的最大上下文”，
  // 不能把 2B 的 256K 声明值直接写给 Harness：2B 的 256K KV 放不进 2GB。
  const modelsWithCtx = await Promise.all(models.map(async (m) => {
    let contextWindow = 0;
    try { contextWindow = await recommendedContext(cfg, m); } catch { /* fallback below */ }
    if (!contextWindow) contextWindow = Math.min(Number(m.contextLength) || Number(cfg.runtime.ctx) || 4096, Number(cfg.runtime.ctx) || 262144);
    return { ...m, contextWindow };
  }));
  const fingerprint = JSON.stringify({
    b: baseURL,
    c: Number(cfg.runtime.ctx) || 4096,
    x: localLimits(cfg).maxTokens,
    h: localLimits(cfg).headroom,
    t: cfg.harness.reasoningEffort,
    m: modelsWithCtx.map((m) => [m.modelId, m.familyName, m.label, m.contextWindow]),
  });
  if (!opts.force && cfg.harness.lastFingerprint === fingerprint) {
    // provider 没变时仍然补齐压缩策略，修复升级后旧 profile 只有 provider、没有 modelPolicies 的情况。
    try {
      const synced = await syncCompactionPolicy(cfg, modelsWithCtx);
      if (!synced || synced.skipped) throw new Error('压缩策略同步未完成，稍后重试');
      return { ok: true, configured: true, models: modelsWithCtx.length, baseURL, unchanged: true, compaction: synced };
    } catch (e) {
      logHarnessError('compaction-sync-unchanged', e);
      throw e;
    }
  }
  // 顺序很关键：先把新模型的压缩策略落进 preset，再把模型暴露给 Harness。
  // 反过来的话，用户在策略生效前切换模型就会命中默认 65536 headroom。
  let compacted;
  try {
    compacted = await syncCompactionPolicy(cfg, modelsWithCtx);
  } catch (e) {
    logHarnessError('compaction-sync', e);
    throw e;
  }
  if (!compacted || compacted.skipped) throw new Error('压缩策略同步未完成，稍后重试');
  const credential = await ensureCredential(cfg);
  if (!credential) throw new Error('Harness 凭据服务不可用，无法自动写入本地模型密钥');
  const entry = findEntry('llm-pi-ai');
  const provider = buildProvider(modelsWithCtx, cfg, baseURL);
  await editWithRetry(entry, (current) => {
    const providers = { ...(current.providers || {}) };
    providers[PROVIDER_ID] = provider;
    return { ...current, providers };
  });
  patchConfig({ harness: { lastFingerprint: fingerprint, lastSyncAt: new Date().toISOString(), lastError: '' } });
  return { ok: true, configured: true, models: modelsWithCtx.length, baseURL, unchanged: false, compaction: compacted };
}

/**
 * 所有 provider/compaction 写入串行化。
 * Harness 的 configEditor 不允许嵌套 HMR；模型预热、用户切默认、下载完成如果同时写，
 * 就会出现 "HMR transactions cannot be nested"，进而留下“模型有了、策略没写”的中间态。
 */
export function syncProvider(cfg, models, opts = {}) {
  return withConfigLock(() => syncProviderInner(cfg, models, opts));
}

export function setDefaultModel(modelId, reasoningEffort = 'medium') {
  return withConfigLock(async () => {
    if (!hasHost()) throw new Error('Harness 配置编辑服务还没就绪');
    const cfg = loadConfig();
    const entry = findEntry('agent-default-model');
    const current = entry.options.config || {};
    const prev = current.provider === PROVIDER_ID ? cfg.harness.prevDefault : {
      provider: current.provider || 'deepseek-account',
      model: current.model || 'deepseek-flash',
      reasoningEffort: current.reasoningEffort || 'low',
    };
    const effort = ['off', 'low', 'medium', 'high'].includes(reasoningEffort) ? reasoningEffort : 'medium';
    await editWithRetry(entry, () => ({
      ...current,
      provider: PROVIDER_ID,
      model: String(modelId),
      reasoningEffort: effort,
    }));
    patchConfig({ harness: { prevDefault: prev, reasoningEffort: effort } });
    return { ok: true, provider: PROVIDER_ID, model: modelId, reasoningEffort: effort, previous: prev };
  });
}

export function restoreDefaultModel() {
  return withConfigLock(async () => {
    const cfg = loadConfig();
    if (!cfg.harness.prevDefault) throw new Error('没有记录过切换前的默认模型');
    const entry = findEntry('agent-default-model');
    const prev = cfg.harness.prevDefault;
    await editWithRetry(entry, () => ({ ...prev }));
    patchConfig({ harness: { prevDefault: null } });
    return { ok: true, restored: prev };
  });
}

export function compactionDebug() {
  if (!hasHost()) return { available: false };
  try {
    let service = null;
    try { service = host.get('compaction'); } catch { /* ignore */ }
    const serviceInfo = service ? {
      ctor: service.constructor?.name,
      config: service.config,
    } : null;
    const rows = editor().configuration().filter((row) => row.entry?.options?.id === 'compaction-basic');
    const presetRow = editor().configuration().find((row) => row.entry?.options?.id === 'preset-standard');
    const presetBasic = presetRow?.entry?.options?.config?.plugins?.find((row) => row.id === 'compaction')?.config?.find((row) => row.id === 'compaction-basic');
    const all = host.loader?.entries?.().filter((entry) => entry.options?.id === 'compaction-basic') || [];
    return {
      available: true,
      service: serviceInfo,
      preset: presetBasic ? { config: presetBasic.config, fiber: Boolean(presetRow.entry.fiber), fiberState: presetRow.entry.fiber?.state } : null,
      count: rows.length,
      all: all.map((entry) => ({
        fiber: Boolean(entry.fiber),
        fiberState: entry.fiber?.state,
        parent: entry.parent?.tree?.ctx?.fiber?.entry?.id,
        parentName: entry.parent?.tree?.ctx?.fiber?.entry?.options?.name,
        config: entry.options?.config,
      })),
      rows: rows.map((row) => ({
        config: row.entry.options.config,
        inherited: row.inherited,
        override: row.override,
        fiber: Boolean(row.entry.fiber),
        fiberState: row.entry.fiber?.state,
      })),
    };
  } catch (e) {
    return { available: true, error: String(e && e.message || e) };
  }
}

export function harnessStatus() {
  const cfg = loadConfig();
  const provider = currentProviderConfig()?.providers?.[PROVIDER_ID] || null;
  const def = currentDefaultModel();
  return {
    available: hasHost(),
    autoConnect: Boolean(cfg.harness.autoConnect),
    providerId: PROVIDER_ID,
    configured: Boolean(provider && Array.isArray(provider.models) && provider.models.length),
    baseURL: provider?.baseURL || '',
    modelCount: provider?.models?.length || 0,
    modelIds: (provider?.models || []).map((m) => m.id),
    defaultProvider: def.provider || '',
    defaultModel: def.model || '',
    defaultReasoningEffort: def.reasoningEffort || '',
    isLocalDefault: def.provider === PROVIDER_ID,
    prevDefault: cfg.harness.prevDefault || null,
    lastSyncAt: cfg.harness.lastSyncAt || '',
    lastError: cfg.harness.lastError || '',
    credentialRef: CREDENTIAL_REF,
  };
}

/** 模型被删除后，如果默认模型指向它，自动回到切换前的官方模型，避免新会话卡死。 */
export async function resetDefaultIfMissing(modelIds) {
  const def = currentDefaultModel();
  if (def.provider !== PROVIDER_ID) return null;
  if (modelIds.includes(def.model)) return null;
  try {
    const cfg = loadConfig();
    if (!cfg.harness.prevDefault) return null;
    return await restoreDefaultModel();
  } catch {
    return null;
  }
}

/** 给 UI 的简短诊断文本。 */
export function harnessHint(status) {
  if (!status.available) return '等待 Harness 服务注入…';
  if (!status.configured) return '下载或导入模型后会自动接入';
  if (status.isLocalDefault) return `已作为默认模型（${status.defaultReasoningEffort}）`;
  return '已接入，可在官方模型下拉中选择';
}
