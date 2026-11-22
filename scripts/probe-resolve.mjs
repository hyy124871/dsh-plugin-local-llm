import { listRepoFiles, pickQuantFiles, fileUrl } from '../src/download.mjs';
import { FAMILIES } from '../src/catalog.mjs';
const cfg = { source: 'hf-mirror', hfToken: '' };
for (const [fid, qid] of [['qwen3.8-27b','UD-Q2_K_XL'], ['qwen3.8-flash-next','UD-Q4_K_XL'], ['deepseek-v4.1-flash-1017','UD-IQ1_S'], ['glm-5.3-flash','UD-IQ1_S']]) {
  const f = FAMILIES.find(x => x.id === fid);
  const q = f.quants.find(x => x.id === qid);
  try {
    const all = await listRepoFiles(f.repo, cfg);
    const files = pickQuantFiles(all, q, f);
    const gb = files.reduce((s, x) => s + x.size, 0) / 1073741824;
    console.log(`OK ${fid}/${qid}: ${files.length} files, ${gb.toFixed(1)} GB`);
    console.log('   first:', files[0].path, '|', fileUrl(cfg, f.repo, files[0].path).slice(0, 120));
  } catch (e) { console.log(`ERR ${fid}/${qid}:`, e.message); }
}
