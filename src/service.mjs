// 面板与工具的统一后端：snapshot 给界面渲染，action 处理所有按钮动作。
// 重点是"每次动作都重新读配置"，避免多个页面/工具各持有旧 cfg 导致互相覆盖。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import {
  loadConfig, patchConfig, publicConfig, configPath, DATA_DIR,
  readCatalogCache, defaults,
} from './settings.mjs';
import { allFamilies, evaluate, describe, findFamily } from './catalog.mjs';
import { detect, diskFree } from './hardware.mjs';
import { scanModels, startDownload, cancelDownload, removeModel, listJobs, SOURCES, freeGB, formatBytes } from './download.mjs';
import { detectRuntime, runtimeJobInfo, downloadRuntime, startServer, stopServer, restartServer, serverStatus, chat, adoptServer, recommendedContext, healthCheck, modelContextLength } from './runtime.mjs';
import { startGateway, stopGateway, restartGateway, gatewayStatus, gatewayBaseURL, setSwitchHandler, beginGatewayMaintenance, endGatewayMaintenance, waitForGatewayIdle, gatewayActiveRequests, gatewayOldestRequestMs } from './gateway.mjs';
import { setHost as setHarnessHost, syncProvider, setDefaultModel, restoreDefaultModel, harnessStatus, resetDefaultIfMissing, currentDefaultModel, compactionDebug } from './harness.mjs';
import { importPath, scanImported, removeImported } from './importer.mjs';
import { discoverCatalog } from './catalog-update.mjs';
import { checkPluginUpdate, pluginUpdateStatus, applyPluginUpdate, setPluginUpdateUrl } from './self-update.mjs';

const VERSION = '1.0.0-preview';
let rootCtx = null;
let booted = false;
let bootError = null;
let syncing = false;
let lastSyncTry = 0;

export function setContext(ctx) {
  rootCtx = ctx;
}

export function setHostContext(child) {
  setHarnessHost(child);
}

function svc(name) {
  try {
    return rootCtx?.get ? rootCtx.get(name) : null;
  } catch {
    return null;
  }
}

function families(cfg) {
  return allFamilies(cfg.customModels, readCatalogCache().families);
}

function currentModels(cfg) {
  return scanModels(cfg, families(cfg));
}

function familyFor(cfg, id) {
  return findFamily(id, cfg.customModels, readCatalogCache().families);
}

function findRecord(cfg, body = {}) {
  const models = currentModels(cfg);
  if (body.modelId) {
    const hit = models.find((m) => m.modelId === body.modelId || m.quantId === body.modelId || m.familyId + '/' + m.quantId === body.modelId);
    if (hit) return hit;
  }
  if (body.path) {
    return {
      path: String(body.path),
      firstGguf: String(body.path),
      modelId: body.modelId || ('local-' + path.basename(String(body.path), '.gguf').replace(/[^\w.\-]+/g, '-').toLowerCase()),
      familyName: '本地文件',
      label: path.basename(String(body.path)),
      familyId: 'imported',
      quantId: 'direct',
    };
  }
  if (body.familyId && body.quantId) {
    const hit = models.find((m) => m.familyId === body.familyId && m.quantId === body.quantId);
    if (hit) return hit;
    const f = familyFor(cfg, body.familyId);
    if (f) {
      const q = f.quants.find((x) => x.id === body.quantId);
      if (q) {
        return {
          familyId: f.id,
          quantId: q.id,
          familyName: f.name,
          label: q.label,
          modelId: ('local-' + f.id + '-' + q.id).replace(/[^\w.\-]+/g, '-').toLowerCase(),
          firstGguf: path.join(cfg.modelsDir, f.id, q.id),
          path: path.join(cfg.modelsDir, f.id, q.id),
        };
      }
    }
  }
  return null;
}

async function maybeSync(cfg, opts = {}) {
  if (!cfg.harness.autoConnect) return harnessStatus();
  const models = currentModels(cfg);
  const base = gatewayBaseURL();
  const ids = models.map((m) => m.modelId);
  await resetDefaultIfMissing(ids).catch(() => {});
  if (!base) return { ...harnessStatus(), lastError: '本地网关未启动' };
  try {
    const r = await syncProvider(cfg, models, { baseURL: base, force: opts.force });
    return { ...harnessStatus(), lastSync: r };
  } catch (e) {
    patchConfig({ harness: { lastError: e.message } });
    return { ...harnessStatus(), lastError: e.message };
  }
}

async function bgSync() {
  const cfg = loadConfig();
  if (!cfg.harness.autoConnect) return;
  if (syncing) return;
  if (Date.now() - lastSyncTry < 1500) return;
  syncing = true;
  lastSyncTry = Date.now();
  try {
    await maybeSync(cfg);
  } finally {
    syncing = false;
  }
}

/**
 * 模型切换后清掉 Harness 侧的旧快照：provider 重写 + compaction policy 重新落盘。
 * 这样下一次请求不会还拿着旧模型的 maxTokens/headroom。
 */
async function resetHarnessForModel(modelId) {
  const cfg = loadConfig();
  patchConfig({ harness: { lastFingerprint: '', lastSyncAt: '', lastError: '' } });
  await maybeSync(loadConfig(), { force: true });
  return modelId;
}

let modelWatcherStarted = false;
let watchBusy = false;
let watchStartedAt = 0;
let watchRetryAt = 0;
let lastDefaultModel = '';
let lastWatchAttempt = 0;
let watchdogStarted = false;
let watchdogBusy = false;
let watchdogFailStreak = 0;
let lastWatchdogFail = 0;
// “先切 server、再改 Harness 默认”这段窗口里，watcher 不能拿旧默认模型去反向切 server；
// 否则会同时起两个 llama-server，随后互相回收，表现为切换卡住/502。
let switchBusy = false;
let watchGeneration = 0;
// Harness 默认模型变化后先观察 3 秒：设置页的“先切 server、再改默认”需要几秒，
// watcher 若立刻反向切旧模型，就会和显式切换抢同一台机器。
let pendingDefaultId = '';
let pendingDefaultSince = 0;
// 用户点了「停止服务」后，watcher 不能因为 Harness 默认模型还是本地模型就马上把它拉起来；
// 否则页面显示已停止、后台其实又起了一个，反复点会出现多个 llama-server 抢端口。
let manualStopAt = 0;
let manualStopModel = '';
// 进程内硬闸门：停止服务后即使配置文件/缓存短暂不同步，watcher 也不能再拉起任何 server。
let userPaused = false;

function markManualStop() {
  manualStopAt = Date.now();
  try { manualStopModel = String(currentDefaultModel()?.model || ''); } catch { manualStopModel = ''; }
}

function clearManualStop() {
  manualStopAt = 0;
  manualStopModel = '';
}

function manualStopBlocks(id) {
  // 30 分钟内且 Harness 默认模型没变化，才视为“用户就是要它停着”。
  if (!manualStopAt || Date.now() - manualStopAt > 30 * 60 * 1000) return false;
  return !manualStopModel || !id || id === manualStopModel;
}

/**
 * 监听 Harness 的 agent-default-model。用户在模型菜单里切到本地模型时，
 * 先把本地 llama-server 换到同一个模型（预热），再重置 Harness 的模型/压缩缓存。
 * 真正做到“选中即切换”，而不是等第一条请求到了才在网关里换。
 */
export function startModelWatcher() {
  if (modelWatcherStarted) return;
  modelWatcherStarted = true;
  const timer = setInterval(async () => {
    if (watchBusy) return;
    if (switchBusy) return;
    if (userPaused) return;
    if (Date.now() < watchRetryAt) return;
    const myGeneration = watchGeneration;
    const def = currentDefaultModel();
    const id = def && def.provider === 'local-llm' ? String(def.model || '') : '';
    if (!id) return;
    if (manualStopBlocks(id)) return;
    if (id !== pendingDefaultId) {
      pendingDefaultId = id;
      pendingDefaultSince = Date.now();
    }
    if (Date.now() - pendingDefaultSince < 3000) return;
    const cfg = loadConfig();
    if (cfg.runtime.pausedByUser) return;
    if (manualStopBlocks(id)) return;
    const rec = currentModels(cfg).find((m) => m.modelId === id || m.quantId === id);
    if (!rec || !rec.firstGguf) return;
    // 不能只看“默认模型 id 变没变”：重启时 boot 的 autoStart 可能先把旧模型
    // 拉起来，此时 id 已经是新模型，但 server 还是旧模型。必须再核对 server 路径。
    const st = serverStatus();
    // 服务已经在跑时，watcher 不再“预切换”。模型菜单里的选择交给网关在下一个
    // 请求到达时 ensureModel 切换；否则设置页正在蓝绿启动新 server 时，watcher
    // 会拿 Harness 的旧默认模型反向再起一个，两个进程互相回收，正好制造 502。
    if (st.status === 'running') {
      lastDefaultModel = id;
      return;
    }
    const samePath = st.status === 'running' && st.modelPath && rec.firstGguf &&
      path.resolve(st.modelPath).toLowerCase() === path.resolve(rec.firstGguf).toLowerCase();
    if (id === lastDefaultModel && samePath) return;
    if (Date.now() - lastWatchAttempt < 1000) return;
    watchBusy = true;
    watchStartedAt = Date.now();
    lastWatchAttempt = Date.now();
    // 关网关闸门 → 等当前请求结束 → 再换模型。否则 Harness 的压缩请求还在飞，
    // llama-server 已经被 watcher 杀掉，就会报 502 fetch failed。
    beginGatewayMaintenance();
    try {
      // 本地 CPU 生成/压缩可能跑几分钟，等待窗口不能只有 60 秒；等不到就下一轮再试，
      // 绝不能把还在生成的 llama-server 杀掉。
      const idle = await waitForGatewayIdle(300000);
      if (!idle) throw new Error('当前仍有本地请求在生成，模型切换已推迟');
      if (switchBusy || myGeneration !== watchGeneration) return;
      const want = await recommendedContext(cfg, rec);
      const now = serverStatus();
      const nowSamePath = now.status === 'running' && now.modelPath && rec.firstGguf &&
        path.resolve(now.modelPath).toLowerCase() === path.resolve(rec.firstGguf).toLowerCase();
      if (nowSamePath && Number(now.ctx) >= Math.floor(want * 0.95)) {
        lastDefaultModel = id;
        return;
      }
      if (switchBusy || myGeneration !== watchGeneration) return;
      await startServer(cfg, {
        path: rec.firstGguf,
        name: `${rec.familyName || '本地'} ${rec.label || ''}`.trim(),
        modelId: rec.modelId,
        familyId: rec.familyId,
        quantId: rec.quantId,
      }, { alias: rec.modelId, timeoutSec: Number(cfg.runtime.timeoutSec) || 600 });
      await resetHarnessForModel(rec.modelId);
      lastDefaultModel = id;
    } catch (e) {
      // 失败后不要每 1.5 秒重试一次：反复 start/stop 会制造一串空日志和端口争抢。
      watchRetryAt = Date.now() + 15000;
      patchConfig({ harness: { lastError: '模型预热失败：' + e.message } });
    } finally {
      endGatewayMaintenance();
      watchBusy = false;
      watchStartedAt = 0;
    }
  }, 1500);
  if (timer.unref) timer.unref();
  startServerWatchdog();
}

/**
 * 连接稳定性看门狗：server 状态显示 running 也可能是进程已经死了，
 * 这里每 10 秒探一次 /health；连续失败才重建，避免误杀正常生成中的服务。
 */
export function startServerWatchdog() {
  if (watchdogStarted) return;
  watchdogStarted = true;
  const timer = setInterval(async () => {
    if (watchdogBusy || watchBusy) return;
    const st = serverStatus();
    if (!st || st.status !== 'running' || !st.port || !st.modelPath) {
      watchdogFailStreak = 0;
      return;
    }
    // 刚启动/刚切完模型的 60 秒内不做 health 重启：此时 Vulkan 图编译、KV
    // 分配都可能让 /health 短暂超时，误杀会直接打断正在飞的首个请求。
    if (st.startedAt && Date.now() - Number(st.startedAt) < 60000) return;
    // 有在飞请求时，CPU 100% 会让 /health 变慢，这不等于进程死了；直接跳过。
    if (gatewayActiveRequests() > 0) {
      watchdogFailStreak = 0;
      return;
    }
    const h = await healthCheck(st.port, 2500);
    if (h.ok) {
      watchdogFailStreak = 0;
      return;
    }
    if (gatewayActiveRequests() > 0) {
      watchdogFailStreak = 0;
      return;
    }
    watchdogFailStreak += 1;
    // 连续两次失败（约 10 秒）才认为真的挂了，避免一次抖动就重建模型。
    if (watchdogFailStreak < 2) return;
    if (Date.now() - lastWatchdogFail < 60000) return;
    lastWatchdogFail = Date.now();
    watchdogBusy = true;
    beginGatewayMaintenance();
    try {
      const idle = await waitForGatewayIdle(30000);
      if (!idle) throw new Error('仍有请求在生成，自动重启已推迟');
      const cfg = loadConfig();
      const rec = currentModels(cfg).find((m) => m.modelId === st.modelId
        || (m.firstGguf && st.modelPath && path.resolve(m.firstGguf).toLowerCase() === path.resolve(st.modelPath).toLowerCase()));
      if (!rec) return;
      patchConfig({ harness: { lastError: '本地服务无响应，正在自动重启…' } });
      await restartServer(cfg, {
        path: st.modelPath,
        name: st.modelName || `${rec.familyName || '本地'} ${rec.label || ''}`.trim(),
        modelId: rec.modelId,
        familyId: rec.familyId,
        quantId: rec.quantId,
      }, { alias: rec.modelId, timeoutSec: Number(cfg.runtime.timeoutSec) || 600 });
      await resetHarnessForModel(rec.modelId);
      patchConfig({ harness: { lastError: '' } });
      watchdogFailStreak = 0;
    } catch (e) {
      patchConfig({ harness: { lastError: '本地服务自动重启失败：' + e.message } });
    } finally {
      endGatewayMaintenance();
      watchdogBusy = false;
    }
  }, 10000);
  if (timer.unref) timer.unref();
}

async function handleGatewaySwitch(modelId) {
  await resetHarnessForModel(modelId);
}

/**
 * 设置页「设为默认」的正确顺序：先切本地 server，再改 Harness 默认模型。
 * 反过来的话，Harness 会在 server 还是旧模型时立刻发起上下文压缩，压缩请求
 * 刚飞出去就被 watcher 杀掉旧进程，于是出现 502 fetch failed。
 */
/**
 * 设置页显式切换前，先让正在进行的 watcher 切换收尾；否则两边会各起一个
 * llama-server，后启动的把前一个回收，用户正好在这时发消息就会 502。
 */
async function waitForWatchIdle(ms = 15000) {
  const deadline = Date.now() + ms;
  while (watchBusy && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
  }
  return !watchBusy;
}

async function switchDefaultModel(cfg, rec, effort) {
  clearManualStop();
  userPaused = false;
  patchConfig({ runtime: { pausedByUser: false } });
  switchBusy = true;
  watchGeneration += 1;
  if (!(await waitForWatchIdle(15000))) {
    switchBusy = false;
    throw new Error('上一个模型切换仍在进行，请稍后重试');
  }
  const model = {
    path: rec.firstGguf || rec.path,
    name: `${rec.familyName || '本地'} ${rec.label || ''}`.trim(),
    modelId: rec.modelId,
  };
  beginGatewayMaintenance();
  try {
    const idle = await waitForGatewayIdle(300000);
    if (!idle) throw new Error('当前仍有本地请求在生成，模型切换已推迟，请稍后重试');
    await startServer(cfg, model, {
      alias: rec.modelId,
      timeoutSec: Number(cfg.runtime.timeoutSec) || 600,
    });
    const result = await setDefaultModel(rec.modelId, effort || cfg.harness.reasoningEffort);
    // 让 Harness 丢掉旧模型的 maxTokens/headroom 快照；压缩请求会在闸门后
    // 排队，等这里完成才发到已经就绪的新 server。
    await resetHarnessForModel(rec.modelId);
    lastDefaultModel = rec.modelId;
    pendingDefaultId = rec.modelId;
    pendingDefaultSince = Date.now();
    return result;
  } finally {
    switchBusy = false;
    endGatewayMaintenance();
  }
}

export async function boot() {
  if (booted) return { ok: true, already: true };
  booted = true;
  const cfg = loadConfig();
  userPaused = Boolean(cfg.runtime.pausedByUser);
  try {
    await adoptServer(cfg);
    await startGateway(cfg);
    setSwitchHandler(handleGatewaySwitch);
    startModelWatcher();
    // 给 Harness provider 的端点用网关真实端口，随后异步同步一次。
    setTimeout(() => { bgSync().catch(() => {}); }, 300);
    // 自动启动优先使用 Harness 当前默认的本地模型，而不是上次服务路径；
    // 否则重启后会先拉起旧模型，再等 watcher 纠正，模型菜单看起来像“没切过去”。
    let startPath = cfg.runtime.lastModelPath;
    let startName = startPath ? path.basename(startPath) : '';
    let startModelId = 'local-last';
    try {
      const def = currentDefaultModel();
      if (def && def.provider === 'local-llm') {
        const rec = currentModels(cfg).find((m) => m.modelId === def.model || m.quantId === def.model);
        if (rec && rec.firstGguf) {
          startPath = rec.firstGguf;
          startName = `${rec.familyName || '本地'} ${rec.label || ''}`.trim();
          startModelId = rec.modelId;
        }
      }
    } catch { /* 首次启动 host 还没注入时保持 lastModelPath */ }
    if (cfg.runtime.autoStart && !cfg.runtime.pausedByUser && startPath && fs.existsSync(startPath)) {
      setTimeout(() => {
        // 1.5 秒内用户可能已经点了「停止」；定时器触发时必须重新读配置。
        // 已经 adopt 到运行中的 server 也不能再起一个，否则热重载一次就多一个进程。
        const nowCfg = loadConfig();
        if (userPaused || nowCfg.runtime.pausedByUser) return;
        if (serverStatus().status === 'running') return;
        startServer(nowCfg, { path: startPath, name: startName, modelId: startModelId })
          .then(() => bgSync())
          .catch(() => {});
      }, 1500);
    }
    return { ok: true, gateway: gatewayStatus(), server: serverStatus() };
  } catch (e) {
    bootError = e.message;
    return { ok: false, error: e.message };
  }
}

export async function snapshot(opts = {}) {
  const cfg = loadConfig();
  const hw = await detect({ force: Boolean(opts.forceHardware), modelsDir: cfg.modelsDir });
  const cache = readCatalogCache();
  const evalResult = evaluate(hw, hw?.disk?.freeGB ?? freeGB(cfg.modelsDir) ?? 0, cfg.customModels, cache.families);
  const models = scanModels(cfg, allFamilies(cfg.customModels, cache.families));
  const runtime = detectRuntime(cfg, Boolean(opts.forceRuntime));
  const server = serverStatus();
  const gateway = gatewayStatus();
  const harness = harnessStatus();
  const jobs = listJobs();
  const disk = {
    modelsDir: cfg.modelsDir,
    freeGB: freeGB(cfg.modelsDir),
    downloadDir: cfg.download?.dir || cfg.modelsDir,
    downloadFreeGB: freeGB(cfg.download?.dir || cfg.modelsDir),
  };
  // 下载完成/导入完成后，模型列表会变化；这里用 1.5s 节流把变化同步给 Harness。
  bgSync().catch(() => {});
  return {
    ok: true,
    version: VERSION,
    app: 'dsh-plugin-local-llm',
    pluginUpdate: pluginUpdateStatus(VERSION),
    at: new Date().toISOString(),
    config: publicConfig(cfg),
    configPath: configPath(),
    dataDir: DATA_DIR,
    platform: `${process.platform} ${os.release()}`,
    hardware: hw,
    disk,
    families: evalResult.families,
    recommended: evalResult.recommended,
    models,
    modelCount: models.length,
    downloaded: models,
    importedCount: models.filter((m) => m.imported).length,
    downloadedCount: models.filter((m) => !m.imported).length,
    jobs,
    server,
    sources: SOURCES,
    runtime: {
      ...runtime,
      job: runtimeJobInfo(),
      server,
      versionLabel: runtime.version || runtime.build || '',
    },
    gateway,
    harness,
    catalog: {
      updatedAt: cache.updatedAt,
      discoveredCount: cache.families.length,
      families: cache.families.length,
    },
    service: {
      booted,
      bootError,
      syncing,
      uptime: process.uptime(),
      watcher: {
        busy: watchBusy,
        busyMs: watchStartedAt ? Date.now() - watchStartedAt : 0,
        retryInMs: Math.max(0, watchRetryAt - Date.now()),
        lastDefaultModel,
        activeRequests: gatewayActiveRequests(),
        oldestRequestMs: gatewayOldestRequestMs(),
        watchdogBusy,
        watchdogFailStreak,
      },
    },
  };
}

async function resolveStart(cfg, body) {
  if (body.modelPath && !body.path) body = { ...body, path: body.modelPath };
  if (body.modelId || body.path || (body.familyId && body.quantId)) {
    const rec = findRecord(cfg, body);
    if (!rec) throw new Error('找不到要启动的模型');
    if (rec.path && fs.existsSync(rec.path) && fs.statSync(rec.path).isDirectory()) {
      const ggufs = fs.readdirSync(rec.path).filter((x) => /\.gguf$/i.test(x) && !/mmproj|imatrix|mtp|dspark/i.test(x));
      if (!ggufs.length) throw new Error('模型目录里没有 .gguf');
      rec.firstGguf = path.join(rec.path, ggufs.sort((a, b) => a.localeCompare(b))[0]);
    }
    return rec;
  }
  const first = currentModels(cfg)[0];
  if (!first) throw new Error('还没有下载或导入任何模型');
  return first;
}

function openFolder(p) {
  const target = path.resolve(p || DATA_DIR);
  if (!fs.existsSync(target)) throw new Error('目录不存在：' + target);
  if (process.platform === 'win32') spawn('explorer.exe', [target], { detached: true, stdio: 'ignore' }).unref();
  else if (process.platform === 'darwin') spawn('open', [target], { detached: true, stdio: 'ignore' }).unref();
  else spawn('xdg-open', [target], { detached: true, stdio: 'ignore' }).unref();
  return { ok: true, path: target };
}

function pickFileDialog() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      resolve({ ok: false, error: '当前平台暂不支持原生文件选择，请直接粘贴路径' });
      return;
    }
    const script = `
$ErrorActionPreference='SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding=[System.Text.Encoding]::UTF8
$d=New-Object System.Windows.Forms.OpenFileDialog
$d.Title='选择 GGUF 模型文件'
$d.Filter='GGUF 模型 (*.gguf)|*.gguf|所有文件 (*.*)|*.*'
$d.Multiselect=$false
if($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK){[Console]::Out.Write($d.FileName)}
`;
    const p = spawn('powershell.exe', ['-NoProfile', '-STA', '-Command', script], { windowsHide: false });
    let out = '';
    let err = '';
    p.stdout.setEncoding('utf8');
    p.stderr.setEncoding('utf8');
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => {
      try { p.kill(); } catch { /* ignore */ }
      resolve({ ok: false, error: '选择窗口超时' });
    }, 120000);
    p.on('close', () => {
      clearTimeout(timer);
      const file = out.trim();
      if (file) resolve({ ok: true, path: file });
      else resolve({ ok: false, canceled: true, error: err.trim().slice(0, 200) || null });
    });
  });
}

async function pickDirectory() {
  try {
    const dp = svc('directoryPicker');
    if (!dp) return { ok: false, error: '目录选择服务不可用，请直接粘贴路径' };
    const cap = await dp.capability();
    if (!cap || cap.kind !== 'native') return { ok: false, error: '当前是浏览器目录模式，请直接粘贴绝对路径' };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 120000);
    try {
      const p = await cap.pick(ctrl.signal);
      return p ? { ok: true, path: p } : { ok: false, canceled: true };
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

const SAFE_PATCH_KEYS = new Set([
  'modelsDir', 'extraModelDirs', 'source', 'hfToken', 'download', 'runtime', 'gateway', 'harness',
  'apiKey', 'customModels', 'importedModels', 'placements', 'enabled',
]);

function sanitizePatch(body) {
  const patch = {};
  for (const [k, v] of Object.entries(body || {})) {
    if (SAFE_PATCH_KEYS.has(k)) patch[k] = v;
  }
  return patch;
}

export async function action(body = {}) {
  const type = String(body.type || body.action || '').trim();
  const cfg = loadConfig();
  switch (type) {
    case 'snapshot':
    case 'state':
    case 'status':
      return snapshot(body);

    case 'pluginUpdateStatus':
      return { ok: true, ...pluginUpdateStatus(VERSION) };

    case 'pluginUpdateCheck':
      return { ok: true, ...(await checkPluginUpdate(VERSION, { force: true })) };

    case 'pluginUpdateApply': {
      const result = await applyPluginUpdate(VERSION);
      return { ok: true, ...result };
    }

    case 'pluginUpdateSetUrl': {
      const result = setPluginUpdateUrl(body.url);
      return { ok: true, ...result, status: pluginUpdateStatus(VERSION) };
    }

    case 'patch': {
      const patch = sanitizePatch(body.patch || {});
      if (!Object.keys(patch).length) throw new Error('没有可写入的字段');
      const next = patchConfig(patch);
      // 路径/上下文变化后 provider 的 model 列表要跟着更新。
      setTimeout(() => { bgSync().catch(() => {}); }, 400);
      return { ok: true, config: publicConfig(next) };
    }

    case 'detect':
      return { ok: true, hardware: await detect({ force: true, modelsDir: loadConfig().modelsDir }) };

    case 'recommend': {
      const hw = await detect({ force: Boolean(body.force), modelsDir: cfg.modelsDir });
      const cache = readCatalogCache();
      return { ok: true, ...evaluate(hw, hw?.disk?.freeGB ?? 0, cfg.customModels, cache.families) };
    }

    case 'download': {
      const { family, quant } = describe(body.familyId, body.quantId, cfg.customModels, readCatalogCache().families);
      const job = await startDownload(cfg, family, quant, { dir: body.dir, source: body.source, force: Boolean(body.force) });
      return { ok: true, job, jobs: listJobs() };
    }

    case 'cancel':
      return { ok: true, job: cancelDownload(body.familyId, body.quantId) };

    case 'remove': {
      let familyId = body.familyId;
      let quantId = body.quantId || body.id;
      if (body.modelId) {
        const rec = currentModels(cfg).find((m) => m.modelId === body.modelId || m.quantId === body.modelId);
        if (rec) {
          familyId = rec.familyId;
          quantId = rec.quantId;
        }
      }
      if (!familyId || !quantId) throw new Error('缺少要删除的模型 id');
      const result = removeModel(cfg, familyId, quantId, families(cfg));
      if (result.removed) {
        await resetDefaultIfMissing(currentModels(cfg).map((m) => m.modelId)).catch(() => {});
        setTimeout(() => { bgSync().catch(() => {}); }, 300);
      }
      return { ok: true, ...result };
    }

    case 'import': {
      const added = importPath(cfg, body.path);
      setTimeout(() => { bgSync().catch(() => {}); }, 500);
      return { ok: true, added, count: added.length };
    }

    case 'removeImported': {
      const result = removeImported(cfg, body.id || body.quantId, { deleteFiles: Boolean(body.deleteFiles) });
      await resetDefaultIfMissing(currentModels(loadConfig()).map((m) => m.modelId)).catch(() => {});
      setTimeout(() => { bgSync().catch(() => {}); }, 300);
      return { ok: true, ...result };
    }

    case 'start': {
      clearManualStop();
      userPaused = false;
      patchConfig({ runtime: { pausedByUser: false } });
      const rec = await resolveStart(cfg, body);
      if (rec.familyId && rec.familyId !== 'imported' && rec.quantId) {
        const hit = currentModels(cfg).find((m) => m.familyId === rec.familyId && m.quantId === rec.quantId);
        if (hit) rec.firstGguf = hit.firstGguf;
      }
      const model = { path: rec.firstGguf || rec.path, name: `${rec.familyName || '本地'} ${rec.label || ''}`.trim(), modelId: rec.modelId, familyId: rec.familyId, quantId: rec.quantId };
      patchConfig({ runtime: { lastModelPath: model.path } });
      switchBusy = true;
      watchGeneration += 1;
      if (!(await waitForWatchIdle(15000))) {
        switchBusy = false;
        throw new Error('上一个模型切换仍在进行，请稍后重试');
      }
      beginGatewayMaintenance();
      let server;
      try {
        // 手动启动/换模型时也先等旧请求跑完，不能把正在生成的 llama-server 直接杀掉。
        await waitForGatewayIdle(300000);
        server = await startServer(loadConfig(), model, { ctx: body.ctx, ngl: body.ngl, alias: rec.modelId, timeoutSec: body.timeoutSec });
      } finally {
        switchBusy = false;
        endGatewayMaintenance();
      }
      const ok = server.status === 'running';
      if (ok && body.setDefault) {
        try {
          await syncProvider(loadConfig(), currentModels(loadConfig()), { baseURL: gatewayBaseURL(), force: true });
          await setDefaultModel(rec.modelId, body.reasoningEffort || 'medium');
          lastDefaultModel = rec.modelId;
        } catch { /* 留待 watcher 下一轮纠正 */ }
      }
      setTimeout(() => { bgSync().catch(() => {}); }, 500);
      return { ok, server, harness: harnessStatus() };
    }

    case 'setContext': {
      const rec = findRecord(cfg, body);
      if (!rec) throw new Error('找不到要设置上下文的模型');
      let ctx = Math.floor(Number(body.ctx) || 0);
      if (!(ctx > 0)) throw new Error('上下文长度无效');
      const native = Number(rec.contextLength) || modelContextLength(rec.firstGguf || rec.path || '') || 0;
      if (native > 0) ctx = Math.min(ctx, native);
      ctx = Math.max(512, Math.min(1048576, ctx));
      const current = loadConfig();
      patchConfig({ runtime: { modelContexts: { ...(current.runtime.modelContexts || {}), [rec.modelId]: ctx } } });
      const fresh = loadConfig();
      const st = serverStatus();
      const samePath = st.modelPath && rec.firstGguf && path.resolve(st.modelPath) === path.resolve(rec.firstGguf);
      let server = st;
      if (st.status === 'running' && samePath) {
        if (!(await waitForGatewayIdle(15000))) throw new Error('当前仍在生成，等本次回答结束后再切换上下文');
        beginGatewayMaintenance();
        switchBusy = true;
        watchGeneration += 1;
        try {
          server = await restartServer(fresh, {
            path: rec.firstGguf || rec.path,
            name: `${rec.familyName || '本地'} ${rec.label || ''}`.trim(),
            modelId: rec.modelId,
            familyId: rec.familyId,
            quantId: rec.quantId,
          }, { ctx, alias: rec.modelId });
        } finally {
          switchBusy = false;
          endGatewayMaintenance();
        }
      }
      await syncProvider(fresh, currentModels(fresh), { baseURL: gatewayBaseURL(), force: true });
      return { ok: true, ctx, modelId: rec.modelId, restarted: server.status === 'running' && samePath, server: serverStatus(), harness: harnessStatus() };
    }

    case 'stop': {
      userPaused = true;
      markManualStop();
      patchConfig({ runtime: { pausedByUser: true } });
      const stopped = await stopServer();
      return { ok: true, server: serverStatus(), stopped };
    }

    case 'restart': {
      clearManualStop();
      userPaused = false;
      patchConfig({ runtime: { pausedByUser: false } });
      const rec = await resolveStart(cfg, body);
      const model = { path: rec.firstGguf || rec.path, name: `${rec.familyName || '本地'} ${rec.label || ''}`.trim(), modelId: rec.modelId };
      beginGatewayMaintenance();
      switchBusy = true;
      watchGeneration += 1;
      if (!(await waitForWatchIdle(15000))) {
        switchBusy = false;
        endGatewayMaintenance();
        throw new Error('上一个模型切换仍在进行，请稍后重试');
      }
      let server;
      try {
        const idle = await waitForGatewayIdle(300000);
        if (!idle) throw new Error('当前仍有本地请求在生成，重启已推迟，请稍后重试');
        server = await restartServer(loadConfig(), model, { ctx: body.ctx, ngl: body.ngl, alias: rec.modelId, timeoutSec: body.timeoutSec });
      } finally {
        switchBusy = false;
        endGatewayMaintenance();
      }
      return { ok: server.status === 'running', server };
    }

    case 'chat':
    case 'testChat': {
      const messages = body.messages || [
        { role: 'system', content: body.system || '你是运行在本机的离线助手，回答简洁、准确。' },
        { role: 'user', content: body.prompt || body.text || '你好，用一句话介绍你自己。' },
      ];
      if (body.start && serverStatus().status !== 'running') {
        const rec = await resolveStart(cfg, body);
        await startServer(loadConfig(), { path: rec.firstGguf || rec.path, name: rec.label || 'local', modelId: rec.modelId }, { alias: rec.modelId });
      }
      const result = await chat(loadConfig(), messages, {
        temperature: body.temperature,
        maxTokens: body.maxTokens,
        reasoningEffort: body.reasoningEffort || cfg.harness.reasoningEffort,
        timeoutMs: 180000,
      });
      return { ok: true, ...result };
    }

    case 'runtimeDownload': {
      const backend = body.backend || cfg.runtime.backend || 'cpu';
      const job = await downloadRuntime(loadConfig(), backend === 'auto' ? 'cpu' : backend);
      return { ok: true, job };
    }

    case 'runtimePath':
      if (body.path) {
        const next = patchConfig({ runtime: { path: String(body.path) } });
        return { ok: true, config: publicConfig(next), runtime: detectRuntime(next, true) };
      }
      throw new Error('缺少 path');

    case 'openFolder':
      return openFolder(body.path || cfg.modelsDir);

    case 'pickDirectory':
      return pickDirectory();

    case 'pickFile':
      return pickFileDialog();

    case 'addCustom': {
      const repo = String(body.repo || '').trim();
      if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) throw new Error('仓库格式应为 作者/仓库，例如 unsloth/Qwen3.5-9B-GGUF');
      const list = Array.isArray(cfg.customModels) ? cfg.customModels.slice() : [];
      const item = {
        id: String(body.id || repo.replace(/[^a-zA-Z0-9]/g, '-')).toLowerCase(),
        name: body.name || repo.split('/').pop(),
        repo,
        sourceRepo: body.sourceRepo || repo,
        quant: body.quant || '',
        quantLabel: body.quantLabel || body.quant || '',
        match: body.match || body.quant || '',
        gb: Number(body.gb) || 0,
        bits: Number(body.bits) || 4,
        params: body.params || '—',
        paramsB: Number(body.paramsB) || 7,
        mode: body.mode || 'dense',
      };
      const idx = list.findIndex((x) => x.id === item.id);
      if (idx >= 0) list[idx] = { ...list[idx], ...item };
      else list.push(item);
      const next = patchConfig({ customModels: list });
      return { ok: true, customModels: list, families: families(next) };
    }

    case 'removeCustom': {
      const list = (cfg.customModels || []).filter((x) => x.id !== body.id);
      const next = patchConfig({ customModels: list });
      return { ok: true, customModels: list, families: families(next) };
    }

    case 'refreshCatalog': {
      const result = await discoverCatalog({ force: Boolean(body.force) });
      return { ok: true, ...result, catalog: { updatedAt: result.updatedAt, discoveredCount: result.totalCached } };
    }

    case 'harnessSync': {
      const models = currentModels(cfg);
      const r = await syncProvider(cfg, models, { baseURL: gatewayBaseURL(), force: Boolean(body.force) });
      return { ok: true, ...r, harness: harnessStatus() };
    }

    case 'compactionDebug':
      return { ok: true, compaction: compactionDebug() };

    case 'setDefault': {
      const models = currentModels(cfg);
      const rec = findRecord(cfg, body);
      if (!rec) throw new Error('找不到要设为默认的模型');
      if (!models.some((m) => m.modelId === rec.modelId)) throw new Error('模型还没有下载/导入，不能设为默认');
      await syncProvider(cfg, models, { baseURL: gatewayBaseURL(), force: true });
      const result = await switchDefaultModel(cfg, rec, body.reasoningEffort || cfg.harness.reasoningEffort);
      return { ok: true, ...result, harness: harnessStatus() };
    }

    case 'restoreDefault': {
      const result = await restoreDefaultModel();
      return { ok: true, ...result, harness: harnessStatus() };
    }

    case 'gatewayRestart': {
      await stopGateway();
      await restartGateway(loadConfig());
      setTimeout(() => { bgSync().catch(() => {}); }, 200);
      return { ok: true, gateway: gatewayStatus() };
    }

    case 'serverLogs':
      return { ok: true, logs: serverStatus().logTail || [], logFile: serverStatus().logFile || '' };

    case 'configFile':
      return { ok: true, path: configPath(), dataDir: DATA_DIR };

    default:
      throw new Error('未知操作：' + (type || '(空)'));
  }
}

export { VERSION };

// 模块加载即开始监听；boot() 可能因为已有实例/HMR 不再执行，不能只依赖 boot。
startModelWatcher();




