// dsh-plugin-local-llm —— DeepSeek Harness 插件（Cordis）。
//
// 宿主侧：1 个 local_llm 工具 + /api/local-llm/config 面板通道。
// 浏览器侧：lib/client.js 设置页「本地模型」分组页。
//
// 新增 0.2.0：本地网关（给 Harness llm-pi-ai 用）、自动写 provider/凭据、
// 本地 GGUF 导入、在线目录更新、运行时高级参数。

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { DATA_DIR, ensureDir, loadConfig } from './settings.mjs';
import { snapshot, action, boot, VERSION, setContext, setHostContext, startModelWatcher } from './service.mjs';
import { stopGateway } from './gateway.mjs';
import { discoverCatalog } from './catalog-update.mjs';

export const name = 'dsh-plugin-local-llm';
export const inject = ['tools'];

const require = createRequire(import.meta.url);
let DEFINE_TOOL_SOURCE = 'identity';

function paramsToSchema(parameters) {
  if (!parameters || typeof parameters !== 'object') return { type: 'object', properties: {}, additionalProperties: false };
  if (parameters.type === 'object' && parameters.properties) return parameters;
  const properties = {};
  const required = [];
  for (const [k, v] of Object.entries(parameters)) {
    if (!v || typeof v !== 'object') continue;
    const p = { ...v };
    if (p.required === true) required.push(k);
    delete p.required;
    if (p.type === 'json') delete p.type;
    properties[k] = p;
  }
  const schema = { type: 'object', properties, additionalProperties: false };
  if (required.length) schema.required = required;
  return schema;
}

function normalizeValueSchema(node) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === 'required' && typeof v === 'boolean') continue;
    if (k === 'properties' && v && typeof v === 'object' && !Array.isArray(v)) {
      const props = {};
      const req = Array.isArray(node.required) ? [...node.required] : [];
      for (const [pk, pv] of Object.entries(v)) {
        if (pv && typeof pv === 'object' && pv.required === true) {
          const { required: _ignored, ...rest } = pv;
          props[pk] = normalizeValueSchema(rest);
          if (!req.includes(pk)) req.push(pk);
        } else {
          props[pk] = normalizeValueSchema(pv);
        }
      }
      out.type = out.type || 'object';
      out.properties = props;
      if (req.length) out.required = req;
      continue;
    }
    if ((k === 'items' || k === 'additionalProperties') && v && typeof v === 'object') {
      out[k] = normalizeValueSchema(v);
      continue;
    }
    out[k] = v;
  }
  return out;
}

function miniDefineTool(options) {
  if (!options || typeof options !== 'object') throw new Error('defineTool: options must be an object');
  const output = options.output;
  if (!output || typeof output !== 'object' || typeof output.render !== 'function' || !output.schema) {
    throw new Error(`defineTool(${options.name}): output must be { schema, render }`);
  }
  return { ...options, parameters: paramsToSchema(options.parameters), output: { ...output, schema: normalizeValueSchema(output.schema) } };
}

function pickDefineTool() {
  try {
    const h = typeof globalThis !== 'undefined' ? globalThis.harness : undefined;
    if (h && typeof h.defineTool === 'function') {
      DEFINE_TOOL_SOURCE = 'harness.defineTool';
      return h.defineTool;
    }
  } catch {
    /* ignore */
  }
  try {
    const m = require('@deepseek-ai/dsh-tools');
    const fn = (m && m.defineTool) || (m && m.default && m.default.defineTool);
    if (typeof fn === 'function') {
      DEFINE_TOOL_SOURCE = 'dsh-tools';
      return fn;
    }
  } catch {
    /* profile 里这包可能缺间接依赖 */
  }
  DEFINE_TOOL_SOURCE = 'mini';
  return miniDefineTool;
}

const defineTool = pickDefineTool();

function out(summary, details = {}) {
  return { summary, details: JSON.stringify(details) };
}

function outputDef() {
  return {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        summary: { type: 'string', required: true },
        details: { type: 'string', required: true },
      },
    },
    render(_args, value) {
      return value?.summary || '';
    },
  };
}

function hwLine(hw) {
  if (!hw) return '硬件未知';
  const gpu = hw.primaryGpu ? `${hw.primaryGpu.name} ${hw.vramGB}GB` : '无独显';
  return `${hw.cpu?.name || 'CPU'} · ${hw.cpu?.cores || '?'}C/${hw.cpu?.threads || '?'}T · 内存 ${hw.ramGB}GB · ${gpu} · 可用磁盘 ${hw.disk?.freeGB ?? '?'}GB`;
}

function serverLine(s) {
  const st = s.runtime?.server || s.server || {};
  if (st.status === 'running') return `运行中 · ${st.apiBase}（${st.modelName}，端口 ${st.port}）`;
  if (st.status === 'loading') return '模型加载中';
  if (st.status === 'error') return `启动失败：${st.error || '看日志'}`;
  return '未启动';
}

function localLlmTool() {
  return defineTool({
    name: 'local_llm',
    description:
      '管理本机 llama.cpp 本地大模型：检测硬件、按显存/内存推荐 GGUF 量化档，从 hf-mirror/魔搭/HF 官方下载，导入本地 GGUF 文件或文件夹，启停 llama-server，把本地模型自动接入 Harness 官方模型下拉，并可直接用本地模型对话。action=status/recommend/list/download/import/start/stop/restart/chat/refresh/harness/default/gateway/runtime。',
    parameters: {
      action: {
        type: 'string',
        enum: ['status', 'recommend', 'list', 'download', 'import', 'start', 'stop', 'restart', 'chat', 'refresh', 'harness', 'default', 'gateway', 'runtime', 'remove'],
        required: true,
        description: 'status=现状；recommend=推荐；list=模型目录；download=下载；import=导入本地文件/文件夹；start/stop/restart=启停；chat=本地对话；refresh=在线更新模型库；harness=同步到官方模型下拉；default=设为默认模型；gateway=重启本地网关；runtime=下载 llama.cpp 运行时；remove=删除模型',
      },
      family_id: { type: 'string', description: '模型 id，如 qwen3.5-9b / qwen3.5-27b / deepseek-v4-pro' },
      quant_id: { type: 'string', description: '量化档 id，如 UD-IQ3_XXS / Q4_K_M' },
      model_id: { type: 'string', description: '已下载/导入模型的 stable id，可在 list 或 status 结果里看到' },
      path: { type: 'string', description: 'import 时的本地 .gguf 文件或文件夹绝对路径；start 时也可直接指定' },
      prompt: { type: 'string', description: 'chat 时的用户输入' },
      system: { type: 'string', description: 'chat 时的系统提示，可选' },
      max_tokens: { type: 'number', description: 'chat 最大输出 token，默认 512' },
      source: { type: 'string', enum: ['auto', 'hf-mirror', 'hf', 'modelscope'], description: '下载源，默认按设置' },
      dir: { type: 'string', description: 'download 时自定义下载目录；省略用模型目录' },
      effort: { type: 'string', enum: ['off', 'low', 'medium', 'high'], description: '思考强度；default 时用设置里的默认' },
      set_default: { type: 'boolean', description: 'start/default 时是否设为 Harness 默认模型' },
      backend: { type: 'string', enum: ['auto', 'cpu', 'cuda', 'vulkan'], description: 'runtime 下载后端' },
      delete_files: { type: 'boolean', description: 'remove 导入模型时是否同时删除原文件（仅受管目录内生效）' },
    },
    output: outputDef(),
    async execute(args) {
      const a = String(args.action || 'status');
      if (a === 'status') {
        const s = await snapshot();
        return out(
          `本机：${hwLine(s.hardware)}\n本地服务：${serverLine(s)}；llama.cpp：${s.runtime.installed ? s.runtime.version || s.runtime.exe : '未安装'}；已下载/导入 ${s.modelCount} 个模型；网关：${s.gateway.running ? s.gateway.baseURL : '未启动'}；Harness：${s.harness.configured ? '已接入 ' + s.harness.modelCount + ' 个模型' : '未接入'}。`,
          {
            hardware: s.hardware,
            runtime: s.runtime,
            server: s.runtime.server,
            gateway: s.gateway,
            harness: s.harness,
            recommended: s.recommended,
            models: s.models,
            jobs: s.jobs.filter((j) => j.status === 'running' || j.status === 'done').slice(0, 6),
          },
        );
      }
      if (a === 'recommend') {
        const s = await snapshot();
        if (!s.recommended) return out('这台机器上没有能跑的量化档；可以下载小尺寸/1-bit 档到磁盘，但内存不够会非常慢。', { hardware: s.hardware });
        const r = s.recommended;
        return out(
          `推荐 ${r.name} · ${r.label}（约 ${r.gb}GB）：${r.reason}。\n下载：local_llm download family_id=${r.familyId} quant_id=${r.quantId}；启动：local_llm start family_id=${r.familyId} quant_id=${r.quantId}。`,
          { recommended: r, hardware: s.hardware },
        );
      }
      if (a === 'list') {
        const s = await snapshot();
        const lines = s.families.map((f) => {
          const best = f.quants.filter((q) => q.fit === 'gpu' || q.fit === 'ram').sort((x, y) => y.bits - x.bits)[0];
          return `${f.name}（${f.params} ${f.arch}，${f.tag}）：${f.quants.length} 档${best ? `，本机最高可跑 ${best.label}` : f.bestFit === 'disk' ? '，本机只能落盘' : '，本机装不下'}`;
        });
        return out(`模型目录（${s.families.length} 个家族，缓存更新 ${s.catalog.updatedAt || '从未'}）：\n` + lines.join('\n'), {
          families: s.families.map((f) => ({ id: f.id, name: f.name, params: f.params, tag: f.tag, bestFit: f.bestFit, quants: f.quants.map((q) => ({ id: q.id, label: q.label, gb: q.gb, fit: q.fit })) })),
          models: s.models,
        });
      }
      if (a === 'download') {
        let s = await snapshot();
        const rec = s.recommended || {};
        const familyId = args.family_id || rec.familyId;
        const quantId = args.quant_id || rec.quantId;
        if (!familyId || !quantId) return out('没有可下载的档：先 list 看目录，或明确给 family_id / quant_id。');
        const r = await action({ action: 'download', familyId, quantId, source: args.source, dir: args.dir });
        const job = r.job;
        if (!job) return out('下载任务已存在，但当前没有可展示的进度。', { familyId, quantId });
        return out(`已开始下载 ${job.name} · ${job.label}（${job.files} 个文件，${Math.round((job.totalBytes || 0) / 1073741824 * 10) / 10}GB，源 ${job.source}）。进度可在设置页看，或用 local_llm status 轮询。`, { job });
      }
      if (a === 'import') {
        if (!args.path) return out('import 需要 path（.gguf 文件或文件夹绝对路径）。');
        const r = await action({ action: 'import', path: args.path });
        return out(`已导入 ${r.count} 个模型：${r.added.map((x) => x.name).join('、')}。已自动尝试接入 Harness。`, { added: r.added });
      }
      if (a === 'start') {
        let s = await snapshot();
        const rec = s.recommended || {};
        const familyId = args.family_id || (args.model_id ? undefined : rec.familyId);
        const quantId = args.quant_id || (args.model_id ? undefined : rec.quantId);
        if (!args.model_id && !args.path && (!familyId || !quantId)) return out('没有可启动的模型：先 list/download，或给 family_id + quant_id。');
        const r = await action({ action: 'start', familyId, quantId, modelId: args.model_id, path: args.path, setDefault: Boolean(args.set_default), reasoningEffort: args.effort });
        const st = r.server;
        if (st.status === 'error') return out(`启动失败：${st.error}\n最近日志：${(st.logTail || []).slice(-6).join(' | ')}`, { server: st });
        return out(
          `llama.cpp 已启动：${st.modelName} · ${st.apiBase}（端口 ${st.port}，ctx ${st.ctx}，ngl ${st.ngl}，线程 ${st.threads}）。${r.harness.configured ? '已接入 Harness 模型下拉。' : '网关已就绪，稍后自动接入 Harness。'}`,
          { server: st, harness: r.harness },
        );
      }
      if (a === 'stop') {
        const r = await action({ action: 'stop' });
        return out(`已停止本地服务${r.stopped?.modelName ? '：' + r.stopped.modelName : ''}。`, { server: r.server });
      }
      if (a === 'restart') {
        const r = await action({ action: 'restart', familyId: args.family_id, quantId: args.quant_id, modelId: args.model_id, path: args.path });
        return out(r.ok ? `已重启：${r.server.modelName} · ${r.server.apiBase}` : `重启失败：${r.server.error || '看日志'}`, { server: r.server });
      }
      if (a === 'chat') {
        const prompt = String(args.prompt || '').trim();
        if (!prompt) return out('chat 需要 prompt。');
        const messages = [];
        if (args.system) messages.push({ role: 'system', content: String(args.system) });
        messages.push({ role: 'user', content: prompt });
        const r = await action({ action: 'chat', messages, maxTokens: args.max_tokens || 512, reasoningEffort: args.effort, start: true, familyId: args.family_id, quantId: args.quant_id, modelId: args.model_id });
        return out(`${r.text || '(空回复)'}`, { model: r.model, usage: r.usage, reasoning: r.reasoning });
      }
      if (a === 'refresh') {
        const r = await action({ action: 'refreshCatalog', force: true });
        const added = r.added || [];
        return out(`模型库已更新：新增 ${added.length} 个家族，刷新 ${(r.updated || []).length} 个，缓存共 ${r.totalCached} 个。${added.length ? '新增：' + added.map((x) => x.name).join('、') : ''}`, { added, updated: r.updated, updatedAt: r.updatedAt });
      }
      if (a === 'harness') {
        const r = await action({ action: 'harnessSync', force: true });
        return out(`Harness 接入：${r.configured ? '已注册 ' + r.models + ' 个本地模型 · ' + r.baseURL : '还没有本地模型'}。${r.harness?.isLocalDefault ? '当前默认模型：' + r.harness.defaultModel + '（' + r.harness.defaultReasoningEffort + '）' : '可在官方模型下拉中选择本地模型。'}`, { harness: r.harness, baseURL: r.baseURL });
      }
      if (a === 'default') {
        if (!args.model_id) return out('default 需要 model_id。');
        const r = await action({ action: 'setDefault', modelId: args.model_id, reasoningEffort: args.effort || 'medium' });
        return out(`已把 ${args.model_id} 设为 Harness 默认模型（思考强度 ${r.reasoningEffort}）。`, { harness: r.harness });
      }
      if (a === 'gateway') {
        const r = await action({ action: 'gatewayRestart' });
        return out(`本地网关已重启：${r.gateway.running ? r.gateway.baseURL : '失败：' + (r.gateway.error || '看日志')}`, { gateway: r.gateway });
      }
      if (a === 'runtime') {
        const r = await action({ action: 'runtimeDownload', backend: args.backend || 'cpu' });
        return out(`llama.cpp 运行时下载已开始（${r.job?.backend || args.backend || 'cpu'}）。进度可在设置页看。`, { job: r.job });
      }
      if (a === 'remove') {
        if (!args.family_id || (!args.quant_id && !args.model_id)) return out('remove 需要 family_id + quant_id，或 model_id。');
        const r = await action({ action: 'remove', familyId: args.family_id, quantId: args.quant_id, modelId: args.model_id, deleteFiles: Boolean(args.delete_files) });
        return out(r.removed ? `已删除 ${args.family_id}/${args.quant_id || args.model_id}。` : '没有找到这个模型。', { result: r });
      }
      return out('未知 action：' + a);
    },
  });
}

function readJsonBody(req, limit = 2 << 20) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy?.();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error('bad json: ' + e.message));
      }
    });
    req.on('error', reject);
  });
}

function writeBootLog(lines) {
  try {
    ensureDir(DATA_DIR);
    const file = path.join(DATA_DIR, 'boot.log');
    const stamp = new Date().toISOString();
    fs.writeFileSync(file, `[${stamp}] ${lines.join('\n')}\n`, 'utf8');
  } catch {
    /* ignore */
  }
}

export function apply(ctx, config = {}) {
  setContext(ctx);
  // HMR 重新加载插件时不一定会重跑 boot，但模型菜单监听必须在每次 apply 都挂上。
  startModelWatcher();
  const bootLines = ['version=' + VERSION, 'defineTool=' + DEFINE_TOOL_SOURCE];
  try {
    const tool = localLlmTool();
    const dispose = ctx.tools.register(tool);
    bootLines.push('tool=local_llm registered');
    try {
      ctx.effect(() => dispose, 'local-llm: tool');
    } catch {
      /* older hosts */
    }
  } catch (e) {
    bootLines.push('tool registration failed: ' + e.message);
    console.warn('[local-llm] 工具注册失败：' + e.message);
  }

  // Harness 自动接入需要 configEditor + credentials；独立 CLI 宿主没有也照常启动。
  try {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['configEditor', 'credentials'], (child) => {
        setHostContext(child);
        bootLines.push('host=configEditor+credentials ready');
        boot().then((r) => {
          writeBootLog([...bootLines, 'gateway=' + (r.gateway?.running ? r.gateway.baseURL : 'off'), 'adopt=' + (r.server?.adopted ? 'running' : 'none'), 'route=/api/local-llm/config']);
        }).catch((e) => writeBootLog([...bootLines, 'boot failed: ' + e.message]));
      });
    }
  } catch (e) {
    bootLines.push('harness host skipped: ' + e.message);
  }

  // 兜底：即使 configEditor 注入晚到，也先把网关和已有 server 拉起来。
  setTimeout(() => {
    boot().then((r) => {
      if (!r.already) writeBootLog([...bootLines, 'boot=' + JSON.stringify({ ok: r.ok, error: r.error || null, gateway: r.gateway?.running })]);
    }).catch((e) => writeBootLog([...bootLines, 'boot failed: ' + e.message]));
  }, 50);

  // 模型库自动更新：默认每 24 小时最多一次，延迟启动避免拖慢面板。
  setTimeout(() => {
    try {
      const cfg = loadConfig();
      if (cfg.catalogAutoUpdate === false) return;
      discoverCatalog().then((r) => {
        if (!r.skipped) console.log('[local-llm] 模型库自动检查：新增 ' + r.added.length + ' 个家族');
      }).catch((e) => console.warn('[local-llm] 模型库自动检查失败：' + e.message));
    } catch (e) {
      console.warn('[local-llm] 模型库自动检查跳过：' + e.message);
    }
  }, 45000);

  try {
    ctx.effect(() => () => stopGateway(), 'local-llm: gateway');
  } catch {
    /* older hosts */
  }

  try {
    if (typeof ctx.inject !== 'function') throw new Error('宿主 ctx 没有 inject');
    ctx.inject(['webServer'], (webCtx) => {
      const dispose = webCtx.webServer.register({
        kind: 'exact',
        path: '/api/local-llm/config',
        handler: async (req, res) => {
          const send = (code, obj) => {
            res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
            res.end(JSON.stringify(obj));
          };
          try {
            if (req.method === 'GET') {
              const s = await snapshot();
              return send(200, s);
            }
            if (req.method !== 'POST') return send(405, { ok: false, error: 'only GET/POST' });
            const body = await readJsonBody(req);
            if (body.patch) {
              const s = await action({ action: 'patch', patch: body.patch });
              return send(200, s);
            }
            const s = await action(body);
            return send(200, s);
          } catch (e) {
            console.warn('[local-llm] 面板请求失败：' + e.message);
            return send(500, { ok: false, error: e.message });
          }
        },
      });
      try {
        ctx.effect(() => dispose, 'local-llm: webServer');
      } catch {
        /* ignore */
      }
    });
  } catch (e) {
    bootLines.push('webServer skipped: ' + e.message);
    console.warn('[local-llm] 设置路由未挂载：' + e.message);
  }

  writeBootLog(bootLines);
}

export default { name, inject, apply };
