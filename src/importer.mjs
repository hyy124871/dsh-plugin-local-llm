// 本地 GGUF 导入：单文件、文件夹、分片；导入条目写进 config.json，
// 不复制、不移动用户文件，启动时直接用原路径。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { expandHome, patchConfig } from './settings.mjs';

const SKIP = /(mmproj|imatrix|mtp[-_]|dspark|bf16|f16|fp16|fp32)/i;
const SHARD = /^(.+?)-(\d{5})-of-(\d{5})\.gguf$/i;

function isGguf(name) {
  return /\.gguf$/i.test(name) && !SKIP.test(name);
}

function walk(dir, out = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.isFile() && isGguf(e.name)) out.push(full);
  }
  return out;
}

function slug(s) {
  return String(s || 'model')
    .replace(/\.gguf$/i, '')
    .replace(/[^\w.\-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 46)
    .toLowerCase() || 'model';
}

function shortHash(s) {
  return crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 6);
}

function groupFiles(files) {
  const groups = new Map();
  for (const file of files) {
    const dir = path.dirname(file);
    const base0 = path.basename(file);
    const m = base0.match(SHARD);
    const base = m ? m[1] : base0.replace(/\.gguf$/i, '');
    const key = dir + '|' + base.toLowerCase();
    if (!groups.has(key)) groups.set(key, { dir, base, files: [] });
    groups.get(key).files.push(file);
  }
  return [...groups.values()].map((g) => {
    const sorted = g.files.slice().sort((a, b) => a.localeCompare(b));
    const bytes = sorted.reduce((sum, f) => {
      try {
        return sum + fs.statSync(f).size;
      } catch {
        return sum;
      }
    }, 0);
    const id = 'imp-' + slug(g.base) + '-' + shortHash(g.dir + '|' + g.base);
    return {
      id,
      name: g.base.replace(/\.gguf$/i, ''),
      label: g.base.replace(/\.gguf$/i, ''),
      base: g.base,
      path: g.files.length === 1 ? sorted[0] : g.dir,
      dir: g.dir,
      files: sorted.map((f) => path.basename(f)),
      firstGguf: sorted[0],
      bytes,
      gb: Math.round((bytes / 1073741824) * 100) / 100,
      shards: sorted.length,
      source: 'imported',
      createdAt: new Date().toISOString(),
    };
  });
}

export function inspectPath(input) {
  const p = expandHome(String(input || '').trim());
  if (!p) throw new Error('请填写模型文件或文件夹路径');
  let st;
  try {
    st = fs.statSync(p);
  } catch {
    throw new Error('路径不存在：' + p);
  }
  let files = [];
  if (st.isFile()) {
    if (!/\.gguf$/i.test(p)) throw new Error('不是 .gguf 文件：' + p);
    files = [p];
  } else if (st.isDirectory()) {
    files = walk(p);
  } else {
    throw new Error('不是普通文件或文件夹：' + p);
  }
  if (!files.length) throw new Error('这个位置没有可用的 .gguf（已跳过 mmproj / imatrix / MTP 草稿头）');
  return groupFiles(files);
}

export function importPath(cfg, input) {
  const groups = inspectPath(input);
  const list = Array.isArray(cfg.importedModels) ? cfg.importedModels.slice() : [];
  const added = [];
  for (const g of groups) {
    const idx = list.findIndex((x) => x.id === g.id || (x.path === g.path && x.base === g.base));
    if (idx >= 0) {
      list[idx] = { ...list[idx], ...g, createdAt: list[idx].createdAt || g.createdAt };
      added.push(list[idx]);
    } else {
      list.push(g);
      added.push(g);
    }
  }
  patchConfig({ importedModels: list });
  return added;
}

export function removeImported(cfg, id, opts = {}) {
  const list = Array.isArray(cfg.importedModels) ? cfg.importedModels : [];
  const hit = list.find((x) => x.id === id);
  if (!hit) return { removed: false };
  const next = list.filter((x) => x.id !== id);
  patchConfig({ importedModels: next });
  let filesDeleted = 0;
  if (opts.deleteFiles) {
    const allowed = [cfg.modelsDir, ...(cfg.extraModelDirs || [])].filter(Boolean).map((x) => path.resolve(expandHome(x)));
    for (const file of hit.files || []) {
      const full = path.resolve(hit.dir || path.dirname(hit.path), file);
      if (!allowed.some((root) => full === root || full.startsWith(root + path.sep))) continue;
      try {
        fs.rmSync(full, { force: true });
        filesDeleted += 1;
      } catch {
        /* ignore */
      }
    }
  }
  return { removed: true, id, filesDeleted };
}

export function scanImported(cfg) {
  const out = [];
  const list = Array.isArray(cfg.importedModels) ? cfg.importedModels : [];
  for (const item of list) {
    if (!item || !item.id || !item.path) continue;
    try {
      if (fs.existsSync(item.path)) {
        const st = fs.statSync(item.path);
        if (st.isFile()) {
          out.push({
            familyId: 'imported',
            familyName: '本地导入',
            quantId: item.id,
            label: item.label || item.name || item.id,
            dir: path.dirname(item.path),
            gb: Math.round((st.size / 1073741824) * 100) / 100,
            bytes: st.size,
            files: 1,
            firstGguf: item.path,
            complete: true,
            source: 'imported',
            imported: true,
            modelId: 'local-' + item.id,
            path: item.path,
          });
          continue;
        }
      }
      // 目录被移动/改名后，按原文件名在记录目录里重新找。
      if (item.dir && fs.existsSync(item.dir)) {
        const files = walk(item.dir).filter((f) => (item.files || []).includes(path.basename(f)));
        if (files.length) {
          const bytes = files.reduce((s, f) => s + fs.statSync(f).size, 0);
          const first = files.slice().sort((a, b) => a.localeCompare(b))[0];
          out.push({
            familyId: 'imported',
            familyName: '本地导入',
            quantId: item.id,
            label: item.label || item.name || item.id,
            dir: item.dir,
            gb: Math.round((bytes / 1073741824) * 100) / 100,
            bytes,
            files: files.length,
            firstGguf: first,
            complete: true,
            source: 'imported',
            imported: true,
            modelId: 'local-' + item.id,
            path: first,
          });
        }
      }
    } catch {
      /* 跳过坏掉的导入条目 */
    }
  }
  return out;
}

export function findImported(cfg, id) {
  return scanImported(cfg).find((x) => x.quantId === id || x.modelId === id) || null;
}
