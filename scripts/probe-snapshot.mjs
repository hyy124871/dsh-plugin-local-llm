import { snapshot } from '../src/service.mjs';
const s = await snapshot({ forceHw: true });
console.log(JSON.stringify({
  version: s.version,
  hw: { cpu: s.hardware.cpu, ram: s.hardware.ramGB, gpu: s.hardware.primaryGpu, vram: s.hardware.vramGB, disk: s.hardware.disk, backend: s.hardware.backend, notes: s.hardware.notes },
  diskFree: s.diskFreeGB,
  runtime: s.runtime,
  server: { status: s.server.status, api: s.server.apiBase },
  recommended: s.recommended,
  families: s.families.map(f => ({ id: f.id, bestFit: f.bestFit, quants: f.quants.length, top: f.quants.filter(q => q.fit === 'ram' || q.fit === 'gpu').map(q => q.label) })),
  downloaded: s.downloaded.length,
}, null, 2));
