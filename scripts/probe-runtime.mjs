// 真实下载 llama.cpp CPU 预编译包到临时 HOME，验证镜像回退 / 解压 / exe 定位。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-runtime-'));
process.env.LOCAL_LLM_HOME = home;

const { loadConfig } = await import('../src/settings.mjs');
const { downloadRuntime, runtimeJobInfo, detectRuntime, runtimeVersion } = await import('../src/runtime.mjs');

console.log('temp home =', home);
const cfg = loadConfig();
const job = await downloadRuntime(cfg, 'cpu');
console.log('job started:', job.status, job.backend);

const deadline = Date.now() + 240 * 1000;
let info = runtimeJobInfo();
while (Date.now() < deadline) {
  info = runtimeJobInfo();
  if (!info || ['done', 'error'].includes(info.status)) break;
  await new Promise((r) => setTimeout(r, 3000));
  console.log('progress', info.status, info.percent + '%', info.bytes, '/', info.totalBytes);
}
console.log('final job:', JSON.stringify(info));
const cfg2 = loadConfig();
const rt = detectRuntime(cfg2, true);
console.log('runtime:', JSON.stringify({ installed: rt.installed, exe: rt.exe, build: rt.build }));
if (rt.installed) {
  console.log('version:', runtimeVersion(rt.exe));
  console.log('exe size:', fs.statSync(rt.exe).size);
}
process.exit(info && info.status === 'done' && rt.installed ? 0 : 1);
