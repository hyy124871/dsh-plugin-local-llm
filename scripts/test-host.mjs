// 宿主契约自测：mock ctx + 真 HTTP 路由 + 工具注册。
// 用 LOCAL_LLM_HOME 指到 temp 目录，绝不碰用户真实配置。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-local-llm-test-'));
process.env.LOCAL_LLM_HOME = home;
process.env.DSH_LOCAL_LLM_TEST = '1';

const tools = [];
globalThis.harness = {
  defineTool(options) {
    tools.push(options);
    return options;
  },
};

const { apply } = await import('../src/index.mjs');
let route = null;
const effects = [];
const ctx = {
  tools: {
    register(t) {
      return () => {};
    },
  },
  effect(fn, label) {
    const d = fn();
    effects.push({ label, d });
  },
  inject(names, cb) {
    if (names.includes('webServer')) cb({ webServer: { register(opts) { route = opts; return () => {}; } } });
  },
};

apply(ctx);
await new Promise((r) => setTimeout(r, 300));
if (!tools.length) throw new Error('工具没有注册');
if (!route) throw new Error('HTTP 路由没有注册');
console.log('tool:', tools[0].name, '| params:', Object.keys(tools[0].parameters).join(','));

const srv = http.createServer((req, res) => route.handler(req, res));
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const base = 'http://127.0.0.1:' + srv.address().port;
const get = async () => {
  const r = await fetch(base + '/api/local-llm/config');
  const j = await r.json();
  if (!r.ok || j.ok === false) throw new Error('GET failed: ' + JSON.stringify(j).slice(0, 200));
  return j;
};
const post = async (body) => {
  const r = await fetch(base + '/api/local-llm/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok || j.ok === false) throw new Error('POST failed: ' + JSON.stringify(j).slice(0, 300));
  return j;
};

const s = await get();
console.log('GET ok | hw:', s.hardware.cpu.cores + 'C/' + s.hardware.cpu.threads + 'T', s.hardware.ramGB + 'GB', s.hardware.primaryGpu?.name, s.hardware.vramGB + 'GB');
console.log('recommended:', s.recommended && s.recommended.name, s.recommended && s.recommended.label, '| families:', s.families.length);

const st = await post({ action: 'state' });
console.log('POST state ok | server:', st.server.status);
await post({ patch: { modelsDir: path.join(home, 'models') } });
console.log('modelsDir -> temp');

const toolResult = await tools[0].execute({ action: 'recommend' });
console.log('tool recommend |', toolResult.summary);

const patched = await post({ patch: { source: 'hf' } });
console.log('patch source ->', patched.config.source);
await post({ patch: { source: 'hf-mirror' } });

const custom = await post({ action: 'addCustom', name: 'Test Tiny', repo: 'unsloth/Qwen3.8-27B-GGUF', quant: 'UD-IQ1_S', match: 'UD-IQ1_S', gb: 5.8 });
console.log('custom added ->', custom.families.length, 'families');
const cleaned = await post({ action: 'removeCustom', id: custom.families[custom.families.length - 1].id });
console.log('custom removed ->', cleaned.families.length, 'families');

// 导入：本地假文件走完整 importer 流程，不联网、不等待大文件下载
const modelsDir = path.join(home, 'models');
fs.mkdirSync(modelsDir, { recursive: true });
const tiny = path.join(modelsDir, 'tiny-probe.gguf');
fs.writeFileSync(tiny, Buffer.alloc(1024));
const imported = await post({ action: 'import', path: tiny });
console.log('imported:', imported.count, imported.added && imported.added[0] && imported.added[0].id);
const importedId = imported.added[0].id;
const afterImport = await get();
const impModel = afterImport.models.find((m) => m.modelId === importedId);
console.log('scan imported:', impModel && impModel.imported, impModel && impModel.gb + 'GB');
await post({ action: 'removeImported', id: importedId, deleteFiles: false });
console.log('imported removed');

srv.close();
fs.rmSync(home, { recursive: true, force: true });
console.log('SELFTEST PASS');
