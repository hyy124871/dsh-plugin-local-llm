// 本机体检：CPU / 内存 / 显卡 / 显存 / 目标盘空间。
// Windows 走一次 PowerShell(CIM) 取全量，nvidia-smi 有就用它校正显存；
// macOS / Linux 只取能取到的，取不到就留空，面板会显示"未知"。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DATA_DIR } from './settings.mjs';

const CACHE_FILE = path.join(DATA_DIR, 'hardware.json');
const SIX_HOURS = 6 * 60 * 60 * 1000;
let memo = null;
let psPath = '';

/** Electron 进程的 PATH 经常没有 System32，powershell.exe 会 ENOENT。 */
export function powershellExe() {
  if (psPath) return psPath;
  const root = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
  const candidates = [
    path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    'pwsh.exe',
    'powershell.exe',
  ];
  for (const c of candidates) {
    if (c.includes('\\') && !fs.existsSync(c)) continue;
    const r = spawnSync(c, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], {
      windowsHide: true, timeout: 8000, encoding: 'utf8',
    });
    if (!r.error && r.status === 0) {
      psPath = c;
      return c;
    }
  }
  psPath = 'powershell.exe';
  return psPath;
}

function gb(bytes) {
  return Math.round((Number(bytes) || 0) / 1073741824 * 10) / 10;
}

function psJson(script) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const r = spawnSync(powershellExe(), ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    windowsHide: true,
    timeout: 30000,
    maxBuffer: 8 * 1024 * 1024,
    encoding: 'utf8',
  });
  if (r.error) throw r.error;
  const text = String(r.stdout || '').trim();
  if (!text) throw new Error('硬件检测没有输出：' + String(r.stderr || '').slice(0, 200));
  return JSON.parse(text);
}

const WIN_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$cs  = Get-CimInstance Win32_ComputerSystem
$osv = Get-CimInstance Win32_OperatingSystem
$mem = @(Get-CimInstance Win32_PhysicalMemory | ForEach-Object { [pscustomobject]@{ capacity=[int64]$_.Capacity; speed=[int]$_.Speed; maker=$_.Manufacturer; part=$_.PartNumber } })
$gpus = @(Get-CimInstance Win32_VideoController | ForEach-Object { [pscustomobject]@{ name=$_.Name; driver=$_.DriverVersion; adapterMB=[math]::Round([double]$_.AdapterRAM/1MB,0) } })
$vram = @()
Get-ChildItem 'HKLM:\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}' -ErrorAction SilentlyContinue | ForEach-Object {
  $q = (Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction SilentlyContinue).'HardwareInformation.qwMemorySize'
  if ($q) { $vram += [int64]$q }
}
$out = [pscustomobject]@{
  cpuName = $cpu.Name
  cpuCores = [int]$cpu.NumberOfCores
  cpuThreads = [int]$cpu.NumberOfLogicalProcessors
  cpuMHz = [int]$cpu.MaxClockSpeed
  ramTotal = [int64]$cs.TotalPhysicalMemory
  ramFree = [int64]$osv.FreePhysicalMemory * 1024
  memModules = $mem
  gpus = $gpus
  vramRegistry = $vram
  osCaption = $osv.Caption
  osVersion = $osv.Version
  machine = ($cs.Manufacturer + ' ' + $cs.Model).Trim()
}
$out | ConvertTo-Json -Depth 6 -Compress
`;

function detectNvidia() {
  const r = spawnSync('nvidia-smi', ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader,nounits'], {
    windowsHide: true,
    timeout: 12000,
    encoding: 'utf8',
  });
  if (r.error || r.status !== 0 || !r.stdout) return [];
  return String(r.stdout)
    .split(/\r?\n/)
    .map((line) => line.split(',').map((s) => s.trim()))
    .filter((p) => p.length >= 2 && p[0])
    .map(([name, mb, driver]) => ({ name, vramGB: Math.round(Number(mb) / 1024 * 10) / 10, driver: driver || '' }));
}

function diskOf(p) {
  const target = (() => {
    let cur = p || os.homedir();
    while (cur && !fs.existsSync(cur)) {
      const up = path.dirname(cur);
      if (up === cur) break;
      cur = up;
    }
    return cur;
  })();
  try {
    const st = fs.statfsSync(target);
    const free = Number(st.bavail) * Number(st.bsize);
    const total = Number(st.blocks) * Number(st.bsize);
    return { path: target, freeGB: gb(free), totalGB: gb(total) };
  } catch {
    return { path: target, freeGB: null, totalGB: null };
  }
}

function classify(name) {
  const n = String(name || '').toLowerCase();
  if (/nvidia|geforce|rtx|quadro|tesla/.test(n)) return 'nvidia';
  if (/amd|radeon|rx\s/.test(n)) return 'amd';
  if (/intel|uhd graphics|iris/.test(n)) return 'intel';
  if (/apple m/.test(n)) return 'apple';
  return 'other';
}

function pickPrimary(gpus) {
  const order = { nvidia: 4, amd: 3, apple: 3, other: 2, intel: 1 };
  return gpus.slice().sort((a, b) => (order[b.vendor] - order[a.vendor]) || (b.vramGB - a.vramGB))[0] || null;
}

function backendOf(primary) {
  if (!primary) return 'cpu';
  // 2GB 级独显也能靠 -ngl 分层吃下一部分层；不再一刀切回 CPU。
  // 运行库未装时启动会明确报错，面板里可一键下载 CUDA/Vulkan。
  const vram = Number(primary.vramGB) || 0;
  if (primary.vendor === 'nvidia') return vram >= 1.5 ? 'cuda' : 'cpu';
  if (primary.vendor === 'apple') return 'metal';
  if (primary.vendor === 'amd') return vram >= 1.5 ? 'vulkan' : 'cpu';
  if (primary.vendor === 'intel') return vram >= 1.5 ? 'vulkan' : 'cpu';
  return 'cpu';
}

async function detectWindows(modelsDir) {
  const raw = psJson(WIN_SCRIPT);
  const nv = detectNvidia();
  const regVram = (raw.vramRegistry || []).map(Number).filter(Boolean);
  const regMaxGB = regVram.length ? Math.max(...regVram) / 1073741824 : 0;
  const gpus = (raw.gpus || []).map((g) => {
    const vendor = classify(g.name);
    let vramGB = Math.round((Number(g.adapterMB) || 0) / 1024 * 10) / 10;
    if (vendor === 'nvidia') {
      const match = nv.find((x) => x.name.toLowerCase() === String(g.name).toLowerCase()) || nv[0];
      if (match && match.vramGB > 0) vramGB = match.vramGB;
    } else if (gpusLength(raw) === 1 && regMaxGB > 0) {
      vramGB = Math.round(regMaxGB * 10) / 10;
    }
    return { name: g.name, vendor, vramGB, driver: g.driver || '' };
  });
  // 单显卡机器（尤其独显）时，注册表里的 qwMemorySize 比 WMI 的 4GB 截断值可信。
  if (gpus.length === 1 && regMaxGB > gpus[0].vramGB) {
    gpus[0].vramGB = Math.round(regMaxGB * 10) / 10;
  }
  const primary = pickPrimary(gpus);
  const modules = (raw.memModules || []).map((m) => ({
    capacityGB: gb(m.capacity),
    speedMHz: Number(m.speed) || 0,
    maker: String(m.maker || '').trim(),
    part: String(m.part || '').trim(),
  }));
  const ramGB = gb(raw.ramTotal || os.totalmem());
  const hw = {
    ok: true,
    at: Date.now(),
    platform: 'win32',
    os: `${raw.osCaption || 'Windows'} ${raw.osVersion || ''}`.trim(),
    machine: raw.machine || '',
    cpu: {
      name: String(raw.cpuName || os.cpus()[0]?.model || '').trim(),
      cores: Number(raw.cpuCores) || os.cpus().length,
      threads: Number(raw.cpuThreads) || os.cpus().length,
      mhz: Number(raw.cpuMHz) || 0,
    },
    ramGB,
    ramFreeGB: gb(raw.ramFree || os.freemem()),
    memModules: modules,
    gpus,
    vramGB: primary ? primary.vramGB : 0,
    primaryGpu: primary,
    backend: backendOf(primary),
    disk: diskOf(modelsDir),
    notes: [],
  };
  if (nv.length) hw.notes.push('显存由 nvidia-smi 校正');
  if (primary && ['nvidia', 'amd', 'intel'].includes(primary.vendor) && (Number(primary.vramGB) || 0) < 4) {
    hw.notes.push('显存小于 4GB，仍会尝试按层 offload（ngl 自动计算）；需要先装 CUDA/Vulkan 运行时');
  }
  if (!primary) hw.notes.push('未识别到独立显卡，将使用 CPU');
  return hw;
}

function gpusLength(raw) {
  return (raw.gpus || []).length;
}

function detectPosix(modelsDir) {
  const cpus = os.cpus();
  const gpus = [];
  if (process.platform === 'darwin') {
    const r = spawnSync('system_profiler', ['SPDisplaysDataType', '-json'], { timeout: 20000, encoding: 'utf8' });
    try {
      const data = JSON.parse(r.stdout || '{}');
      for (const d of data.SPDisplaysDataType || []) {
        gpus.push({
          name: d.sppci_model || d._name || 'GPU',
          vendor: classify(d.sppci_model || ''),
          vramGB: Number(String(d.spdisplays_vram || '').replace(/[^\d]/g, '')) || 0,
          driver: '',
        });
      }
    } catch {
      /* ignore */
    }
  } else {
    const nv = detectNvidia();
    for (const x of nv) gpus.push({ name: x.name, vendor: 'nvidia', vramGB: x.vramGB, driver: x.driver });
    if (!gpus.length) {
      const r = spawnSync('bash', ['-lc', "lspci 2>/dev/null | grep -Ei 'vga|3d|display' | head -4"], { timeout: 10000, encoding: 'utf8' });
      for (const line of String(r.stdout || '').split(/\r?\n/).filter(Boolean)) {
        const name = line.split(':').slice(2).join(':').trim() || line;
        gpus.push({ name, vendor: classify(name), vramGB: 0, driver: '' });
      }
    }
  }
  const primary = pickPrimary(gpus);
  return {
    ok: true,
    at: Date.now(),
    platform: process.platform,
    os: `${os.type()} ${os.release()}`,
    machine: '',
    cpu: { name: cpus[0]?.model || '', cores: cpus.length, threads: cpus.length, mhz: cpus[0]?.speed || 0 },
    ramGB: gb(os.totalmem()),
    ramFreeGB: gb(os.freemem()),
    memModules: [],
    gpus,
    vramGB: primary ? primary.vramGB : 0,
    primaryGpu: primary,
    backend: backendOf(primary),
    disk: diskOf(modelsDir),
    notes: ['非 Windows 平台，硬件信息为尽力采集'],
  };
}

/** 读缓存（6 小时内），force=true 时重新跑一遍。 */
export async function detect({ force = false, modelsDir } = {}) {
  if (!force) {
    if (memo && memo.ok !== false && Date.now() - memo.at < SIX_HOURS) {
      if (modelsDir && memo.disk?.path !== modelsDir) memo = { ...memo, disk: diskOf(modelsDir) };
      return memo;
    }
    try {
      const cached = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      if (cached && cached.ok !== false && Date.now() - cached.at < SIX_HOURS) {
        if (modelsDir) cached.disk = diskOf(modelsDir);
        memo = cached;
        return cached;
      }
    } catch {
      /* no cache */
    }
  }
  let hw;
  try {
    hw = process.platform === 'win32' ? await detectWindows(modelsDir) : detectPosix(modelsDir);
  } catch (e) {
    hw = {
      ok: false,
      at: Date.now(),
      platform: process.platform,
      os: `${os.type()} ${os.release()}`,
      error: e.message,
      cpu: { name: os.cpus()[0]?.model || '', cores: os.cpus().length, threads: os.cpus().length, mhz: 0 },
      ramGB: gb(os.totalmem()),
      ramFreeGB: gb(os.freemem()),
      memModules: [],
      gpus: [],
      vramGB: 0,
      primaryGpu: null,
      backend: 'cpu',
      disk: diskOf(modelsDir),
      notes: ['硬件检测失败：' + e.message],
    };
  }
  memo = hw;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(hw, null, 2), 'utf8');
  } catch {
    /* cache is best-effort */
  }
  return hw;
}

export function peek() {
  return memo;
}

export function diskFree(modelsDir) {
  return diskOf(modelsDir).freeGB;
}
