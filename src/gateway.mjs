// 本地 OpenAI 兼容网关：固定监听 127.0.0.1，给 Harness 的 llm-pi-ai 提供稳定端点。
// 它按 Harness 传来的 model id 找到本地 GGUF，必要时自动启动/切换 llama-server，
// 再把请求原样（含 SSE 流）转发过去。网关本身不要求 API Key，密钥由插件内部注入。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { loadConfig, patchConfig, readCatalogCache, DATA_DIR } from './settings.mjs';
import { allFamilies } from './catalog.mjs';
import { scanModels } from './download.mjs';
import { startServer, stopServer, serverStatus, adoptServer, apiBase, healthCheck } from './runtime.mjs';

let gateway = null;
let gatewayError = null;
let switching = Promise.resolve();
let requestCount = 0;
let activeRequests = 0;
let activeSeq = 0;
const activeSince = new Map();
let maintenance = null;
let releaseMaintenance = null;

/** 模型切换期间先关门：新请求排到 barrier 后面，避免请求刚拿到旧 server 就被换模型打断。 */
export function beginGatewayMaintenance() {
  if (!maintenance) {
    maintenance = new Promise((resolve) => { releaseMaintenance = resolve; });
  }
}

export function endGatewayMaintenance() {
  if (releaseMaintenance) releaseMaintenance();
  releaseMaintenance = null;
  maintenance = null;
}

export function gatewayActiveRequests() {
  return activeRequests;
}

/** 最老的在飞请求已持续多久；用于诊断“切模型前为什么一直在等”。 */
export function gatewayOldestRequestMs() {
  let oldest = 0;
  for (const at of activeSince.values()) {
    if (!oldest || at < oldest) oldest = at;
  }
  return oldest ? Date.now() - oldest : 0;
}

export async function waitForGatewayIdle(timeoutMs = 120000) {
  const deadline = Date.now() + Math.max(1000, timeoutMs);
  while (activeRequests > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return activeRequests === 0;
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  });
    res.end(body);
}

function readBody(req, limit = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch (e) {
        reject(new Error('bad json: ' + e.message));
      }
    });
    req.on('error', reject);
  });
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((p) => (typeof p === 'string' ? p : (p && p.text) || '')).join('');
  }
  return content == null ? '' : String(content);
}

function isSkillCatalog(msg) {
  if (!msg) return false;
  const source = msg.source || (msg.metadata && msg.metadata.source);
  if (source && source.kind === 'skill-catalog') return true;
  const text = contentText(msg.content);
  return text.includes('<available_skills>') || text.includes('skill-catalog');
}

function isInjectedContext(msg) {
  if (!msg) return false;
  const source = msg.source || (msg.metadata && msg.metadata.source);
  if (source && (source.kind === 'skill-catalog' || source.kind === 'runtime-context' || source.kind === 'time-context')) return true;
  const text = contentText(msg.content);
  return text.includes('<available_skills>')
    || text.includes('<system-reminder>')
    || text.includes('<current-date>')
    || text.includes('runtime-context')
    || text.includes('time-context')
    || text.includes('skill-catalog');
}

function cleanMessage(msg) {
  const copy = { ...msg };
  delete copy.tool_calls;
  delete copy.tool_call_id;
  delete copy.name;
  const text = contentText(copy.content);
  copy.content = text;
  return copy;
}

function preparePayload(body, cfg, st) {
  const payload = { ...body, model: st.modelName };
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const originalChars = JSON.stringify({ messages, tools }).length;
  // 本地小模型在 CPU 上只有几 tok/s；Harness 压缩/长上下文请求常带 16K+ 的
  // max_tokens，一旦模型开始长篇生成，用户会几分钟看不到结尾，还会把后面的
  // 模型切换卡在 activeRequests 上。这里给输出设硬上限，优先保证响应时间。
  const askedTokens = Number(payload.max_tokens ?? payload.max_completion_tokens);
  const ctx = Math.max(4096, Number(st.ctx) || 8192);
  const normalCap = Math.max(1024, Number(cfg.gateway.maxOutputTokens) || 32768);
  const leanCap = Math.max(1024, Number(cfg.gateway.leanMaxOutputTokens) || 4096);
  const hardLimit = originalChars > (Number(cfg.gateway.leanThresholdChars) || 18000)
    ? leanCap
    : Math.max(2048, Math.min(normalCap, Math.floor(ctx / 4)));
  if (!Number.isFinite(askedTokens) || askedTokens <= 0) {
    payload.max_tokens = hardLimit;
  } else if (askedTokens > hardLimit) {
    payload.max_tokens = hardLimit;
  }
  const threshold = Number(cfg.gateway.leanThresholdChars) || 18000;
  const lean = cfg.gateway.leanPrompt !== false && originalChars > threshold;
  const stats = {
    at: new Date().toISOString(),
    model: st.modelName,
    originalChars,
    tools: tools.length,
    messages: messages.length,
    lean: false,
    leanChars: originalChars,
    droppedCatalog: 0,
    droppedContext: 0,
    droppedToolMessages: 0,
    droppedTools: false,
    maxTokens: payload.max_tokens,
    askedTokens: Number.isFinite(askedTokens) ? askedTokens : 0,
  };
  // 本地小模型在 CPU 上生成 reasoning_content 会先吃掉几百上千 token，界面长时间
  // 只显示“深度求索中”。默认直答；模型不支持这两个字段时下面会 400 回退重试。
  payload.reasoning_effort = 'none';
  payload.chat_template_kwargs = { ...(payload.chat_template_kwargs || {}), enable_thinking: false };
  stats.noThinking = true;
  if (!lean) return { payload, stats };

  // 本地小模型一旦进入 reasoning，会在 reasoning_content 里写几百上千 token，
  // Harness 界面只显示“深度求索中”，看起来像一个字都没出。这里强制走直答。
  payload.reasoning_effort = 'none';
  payload.chat_template_kwargs = { ...(payload.chat_template_kwargs || {}), enable_thinking: false };
  stats.noThinking = true;

  const maxSystemChars = Number(cfg.gateway.maxSystemChars) || 6000;
  const maxConversationChars = Number(cfg.gateway.maxConversationChars) || 12000;
  // 小模型在 CPU 上预填充 2.5 万字符要几十秒；单条消息先截断，保证“响应速度”
  // 不是被一段超长粘贴文本拖死的。真正的长文处理应换更大模型/更长上下文。
  const clipMessage = (text) => {
    const s = String(text || '');
    if (s.length <= maxConversationChars) return s;
    return s.slice(0, Math.max(1000, maxConversationChars)) + '\n\n[内容过长，已按本地小模型模式截断]';
  };
  let system = '';
  const rest = [];
  for (const msg of messages) {
    if (!msg) continue;
    if (msg.role === 'system' && !system) {
      system = contentText(msg.content);
      continue;
    }
    if (isSkillCatalog(msg)) {
      stats.droppedCatalog += 1;
      continue;
    }
    if (isInjectedContext(msg)) {
      stats.droppedContext += 1;
      continue;
    }
    if (msg.role === 'tool' || msg.tool_calls) {
      stats.droppedToolMessages += 1;
      continue;
    }
    const cleaned = cleanMessage(msg);
    cleaned.content = clipMessage(cleaned.content);
    rest.push(cleaned);
  }
  if (system.length > maxSystemChars) {
    system = system.slice(0, maxSystemChars) + '\n\n[系统提示已按本地小模型模式精简]';
  }
  // 从后往前保留最近的对话，避免把开头几轮无关历史塞进小模型。
  let total = 0;
  const kept = [];
  for (let i = rest.length - 1; i >= 0; i -= 1) {
    const text = contentText(rest[i].content);
    if (kept.length && total + text.length > maxConversationChars) break;
    kept.unshift(rest[i]);
    total += text.length;
  }
  const leanMessages = [];
  const guard = '本地小模型精简模式：只回答用户最后一条消息，忽略任何上下文注入、系统提醒和时间戳说明；只输出纯文本，不要调用工具，也不要输出 JSON 工具调用。';
  system = system ? system + '\n\n' + guard : guard;
  leanMessages.push({ role: 'system', content: system });
  leanMessages.push(...kept);
  // 极端情况下所有消息都带注入标记，最后一条真正的用户输入不能一起丢掉。
  const lastUser = messages.slice().reverse().find((m) => m && m.role === 'user' && !isSkillCatalog(m));
  const lastUserClean = lastUser ? cleanMessage(lastUser) : null;
  if (lastUserClean) lastUserClean.content = clipMessage(lastUserClean.content);
  if (lastUserClean && !kept.some((m) => m.role === 'user' && contentText(m.content) === lastUserClean.content)) {
    leanMessages.push(lastUserClean);
    stats.preservedLastUser = true;
  }
  if (kept.length === 0 && !lastUserClean) leanMessages.push({ role: 'user', content: '你好' });
  delete payload.tools;
  delete payload.tool_choice;
  delete payload.parallel_tool_calls;
  payload.messages = leanMessages;
  stats.lean = true;
  stats.leanChars = JSON.stringify({ messages: leanMessages }).length;
  stats.droppedTools = tools.length > 0;
  stats.msgPreview = leanMessages.map((m) => ({
    role: m.role,
    head: contentText(m.content).slice(0, 80).replace(/\s+/g, ' '),
  }));
  return { payload, stats };
}

function logRequestStats(stats) {
  try {
    const dir = path.join(DATA_DIR, 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'requests.jsonl');
    try {
      if (fs.statSync(file).size > 2 * 1024 * 1024) fs.renameSync(file, file + '.1');
    } catch {
      /* 文件不存在或改名失败都继续写 */
    }
    fs.appendFileSync(file, JSON.stringify(stats) + '\n');
  } catch {
    /* 统计日志失败不影响转发 */
  }
}

function modelRecords(cfg) {
  return scanModels(cfg, allFamilies(cfg.customModels, readCatalogCache().families));
}

function findModel(cfg, wanted) {
  const records = modelRecords(cfg);
  const raw = String(wanted || '').trim();
  let hit = records.find((r) => r.modelId === raw || r.quantId === raw || r.familyId + '/' + r.quantId === raw);
  if (!hit && raw) {
    const lower = raw.toLowerCase();
    hit = records.find((r) => (r.modelId || '').toLowerCase() === lower || (r.label || '').toLowerCase() === lower || (r.familyName + ' ' + r.label).toLowerCase() === lower);
  }
  if (!hit && records.length === 1) hit = records[0];
  return { hit, records };
}

function enqueue(fn) {
  const run = switching.then(fn, fn);
  switching = run.catch(() => {});
  return run;
}

let switchHandler = null;

/** 服务层注册：真实切换本地模型后，同步 provider/compaction 并让 Harness 丢掉旧模型缓存。 */
export function setSwitchHandler(fn) {
  switchHandler = typeof fn === 'function' ? fn : null;
}

async function ensureModel(cfg, rec) {
  return enqueue(async () => {
    // 先接管别的进程/上一次启动的 llama-server，避免重复启动占端口。
    const current = (await adoptServer(cfg)) || serverStatus();
    const samePath = current.status === 'running' && current.modelPath && rec.firstGguf &&
      current.modelPath.toLowerCase() === rec.firstGguf.toLowerCase();
    if (samePath) {
      const healthy = await healthCheck(current.port);
      if (healthy.ok) return current;
    }
    // 不再先 stop：startServer 内部会先在新端口拉起候选模型，健康后再回收旧进程。
    const fresh = loadConfig();
    const server = await startServer(fresh, {
      path: rec.firstGguf,
      name: `${rec.familyName} ${rec.label}`.trim(),
      modelId: rec.modelId,
      familyId: rec.familyId,
      quantId: rec.quantId,
    }, { alias: rec.modelId, timeoutSec: Number(fresh.runtime.timeoutSec) || 600 });
    if (!samePath && switchHandler) {
      await switchHandler(rec.modelId, server).catch(() => {});
    }
    return server;
  });
}

async function requestUpstream(cfg, st, payload) {
  requestCount += 1;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(60000, (Number(cfg.runtime.timeoutSec) || 600) * 1000));
  try {
    return await fetch(`${apiBase(st.port)}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${cfg.apiKey || 'llm-local'}`,
        accept: 'text/event-stream, application/json',
      },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function pipeUpstream(upstream, res) {
  const headers = {
    'content-type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  };
  const len = upstream.headers.get('content-length');
  if (len && !String(headers['content-type']).includes('text/event-stream')) headers['content-length'] = len;
  res.writeHead(upstream.status, headers);
  if (upstream.body) {
    await pipeline(Readable.fromWeb(upstream.body), res);
  } else {
    res.end();
  }
}

function retryPause(attempt) {
  // 退避 + 少量抖动：给正在换模型/回收显存的 llama-server 一点时间，也避免固定节奏撞在同一状态。
  const ms = 350 * attempt + Math.floor(Math.random() * 250);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function retryOnSameServer(cfg, st, payload, attempts = 2) {
  let upstream = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    await retryPause(attempt);
    upstream = await requestUpstream(cfg, st, payload);
    if (![502, 503, 504].includes(upstream.status)) return upstream;
    try { await upstream.body?.cancel(); } catch { /* ignore */ }
  }
  return upstream;
}

async function proxyChat(req, res, cfg) {
  const body = await readBody(req);
  const wanted = body.model || body.model_id || '';
  const { hit, records } = findModel(cfg, wanted);
  if (!hit) {
    return json(res, 404, {
      error: {
        message: records.length
          ? `本地模型「${wanted || '(空)'}」不在已下载列表里。请先在「本地模型」设置页下载或导入模型。`
          : '本地还没有下载或导入任何模型。请先在「本地模型」设置页下载或导入模型。',
        type: 'local_model_not_found',
      },
    });
  }
  let payload = null;
  let activeSt = null;
  try {
    const st = await ensureModel(cfg, hit);
    if (!st || st.status !== 'running' || !st.port) {
      return json(res, 503, { error: { message: '本地模型启动失败：' + (st?.error || '未知错误'), type: 'local_model_start_failed' } });
    }
    activeSt = st;
    const prepared = preparePayload(body, cfg, st);
    logRequestStats(prepared.stats);
    payload = prepared.payload;
    // 有些模型模板不接受 reasoning_effort；先原样发，400 时去掉再试一次。
    let upstream = await requestUpstream(cfg, st, payload);
    if (upstream.status === 400 && ('reasoning_effort' in payload || payload.chat_template_kwargs)) {
      const text = await upstream.text().catch(() => '');
      void text;
      const copy = { ...payload };
      delete copy.reasoning_effort;
      if (copy.chat_template_kwargs) {
        const kwargs = { ...copy.chat_template_kwargs };
        delete kwargs.enable_thinking;
        if (Object.keys(kwargs).length) copy.chat_template_kwargs = kwargs;
        else delete copy.chat_template_kwargs;
      }
      upstream = await requestUpstream(cfg, st, copy);
    }
    // llama-server 在刚启动、正在换模型或显存抖动时会短暂回 502/503/504。
    // 先在同一实例上退避重试两次；仍失败才重建，避免一次抖动就付 8–10 秒的模型重载代价。
    if ([502, 503, 504].includes(upstream.status)) {
      try { await upstream.body?.cancel(); } catch { /* ignore */ }
      upstream = await retryOnSameServer(cfg, st, payload, 2);
      if ([502, 503, 504].includes(upstream.status)) {
        try {
          await stopServer();
          const st2 = await ensureModel(cfg, hit);
          if (st2 && st2.status === 'running') upstream = await requestUpstream(cfg, st2, payload);
        } catch { /* 保留原始 upstream 状态，下面照常转发错误 */ }
      }
    }
    await pipeUpstream(upstream, res);
  } catch (e) {
    // 停止服务/切模型后的第一个请求偶尔会碰到还在退出的旧端口：先同实例退避重试，再考虑重启。
    if (!res.headersSent && payload && /fetch failed|ECONN|socket|connect|aborted|terminated/i.test(String(e.message || ''))) {
      try {
        if (activeSt && activeSt.status === 'running' && activeSt.port) {
          const upstream2 = await retryOnSameServer(cfg, activeSt, payload, 2);
          if (upstream2 && ![502, 503, 504].includes(upstream2.status)) {
            await pipeUpstream(upstream2, res);
            return;
          }
        }
        await stopServer();
        const st2 = await ensureModel(cfg, hit);
        const upstream3 = await requestUpstream(cfg, st2, payload);
        await pipeUpstream(upstream3, res);
        return;
      } catch (retryError) {
        if (!res.headersSent) json(res, 502, { error: { message: '本地网关转发失败：' + retryError.message, type: 'local_gateway_error' } });
        return;
      }
    }
    if (!res.headersSent) json(res, 502, { error: { message: '本地网关转发失败：' + e.message, type: 'local_gateway_error' } });
  }
}

async function handle(req, res) {
  const cfg = loadConfig();
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const pathname = url.pathname.replace(/\/+$/, '') || '/';
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'authorization,content-type',
      'access-control-max-age': '86400',
    });
    return res.end();
  }
  if (req.method === 'GET' && (pathname === '/' || pathname === '/health')) {
    return json(res, 200, {
      status: 'ok',
      service: 'dsh-plugin-local-llm gateway',
      models: modelRecords(cfg).length,
      llama: serverStatus(),
    });
  }
  if (req.method === 'GET' && pathname === '/v1/models') {
    const records = modelRecords(cfg);
    return json(res, 200, {
      object: 'list',
      data: records.map((r) => ({
        id: r.modelId,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'local-llm',
        name: `${r.familyName} ${r.label}`.trim(),
      })),
    });
  }
  if (req.method === 'GET' && pathname.startsWith('/v1/models/')) {
    const id = decodeURIComponent(pathname.slice('/v1/models/'.length));
    const { hit } = findModel(cfg, id);
    if (!hit) return json(res, 404, { error: { message: 'model not found', type: 'invalid_request_error' } });
    return json(res, 200, { id: hit.modelId, object: 'model', owned_by: 'local-llm', name: `${hit.familyName} ${hit.label}`.trim() });
  }
  if (req.method === 'POST' && (pathname === '/v1/chat/completions' || pathname === '/chat/completions')) {
    if (maintenance) await maintenance;
    const ticket = ++activeSeq;
    activeSince.set(ticket, Date.now());
    activeRequests += 1;
    try {
      return await proxyChat(req, res, cfg);
    } catch (e) {
      if (!res.headersSent) return json(res, 500, { error: { message: e.message, type: 'local_gateway_error' } });
      try { res.end(); } catch { /* ignore */ }
      return;
    } finally {
      activeSince.delete(ticket);
      activeRequests = Math.max(0, activeRequests - 1);
    }
  }
  if (req.method === 'POST' && pathname === '/v1/completions') {
    // 少数客户端走旧 completions 协议；直接转发给当前模型。
    const body = await readBody(req);
    const { hit } = findModel(cfg, body.model || '');
    if (!hit) return json(res, 404, { error: { message: 'model not found' } });
    const st = await ensureModel(cfg, hit);
    if (!st || st.status !== 'running') return json(res, 503, { error: { message: st?.error || 'start failed' } });
    const upstream = await fetch(`${apiBase(st.port)}/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey || 'llm-local'}` },
      body: JSON.stringify({ ...body, model: st.modelName }),
    });
    res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') || 'application/json' });
    if (upstream.body) await pipeline(Readable.fromWeb(upstream.body), res);
    else res.end();
    return;
  }
  json(res, 404, { error: { message: 'not found', type: 'invalid_request_url' } });
}

function listen(port) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      handle(req, res).catch((e) => {
        try { if (!res.headersSent) json(res, 500, { error: { message: e.message } }); } catch { /* ignore */ }
      });
    });
    srv.once('error', reject);
    srv.listen(port, '127.0.0.1', () => resolve(srv));
  });
}

export async function startGateway(cfg) {
  if (gateway && gateway.listening) return gatewayStatus();
  gatewayError = null;
  const preferred = Number(cfg.gateway?.port) || 18081;
  let lastErr = null;
  for (let i = 0; i < 12; i++) {
    try {
      const srv = await listen(preferred + i);
      gateway = srv;
      patchConfig({ gateway: { actualPort: preferred + i } });
      return gatewayStatus();
    } catch (e) {
      lastErr = e;
    }
  }
  gatewayError = lastErr ? lastErr.message : 'no free port';
  return gatewayStatus();
  }

export function stopGateway() {
  if (!gateway) return gatewayStatus();
  try {
    gateway.close();
  } catch {
    /* ignore */
  }
  gateway = null;
  return gatewayStatus();
}

export async function restartGateway(cfg) {
  stopGateway();
  return startGateway(cfg);
}

export function gatewayStatus() {
  const cfg = loadConfig();
  const actual = gateway && gateway.listening ? gateway.address()?.port : null;
  const port = actual || Number(cfg.gateway?.actualPort) || 0;
  return {
    running: Boolean(gateway && gateway.listening),
    port: actual || null,
    baseURL: actual ? `http://127.0.0.1:${actual}/v1` : '',
    configuredPort: Number(cfg.gateway?.port) || 18081,
    error: gatewayError,
    requests: requestCount,
    models: actual ? modelRecords(cfg).length : 0,
  };
}

/** 给 Harness provider 用：网关实际监听地址。 */
export function gatewayBaseURL() {
  const s = gatewayStatus();
  return s.baseURL;
}
