/// <reference lib="dom" />
declare const chrome: any;

import { buildUI, UIRefs } from './ui';
import { setPanelProgress, hidePanelProgress, setMiniBadge, clearMiniBadge } from './hud';
import {
  DEFAULT_SETTINGS, DEFAULT_LIMIT, clampInt,
  loadSettings, saveSettings, type Settings
} from '../modules/settings';
import {
  filterGenerations, countValidTasks, fetchRawWithConcurrency,
  type Task
} from '../modules/sora_api';
import {
  downloadAllToOPFS, writeZipFromOPFS, opfsRemoveDir
} from '../modules/zip_store';

// ---------- Messaging helper ----------
type SendFn = (p: any) => Promise<any>;
const send: SendFn = (p) => new Promise((res) => chrome.runtime.sendMessage(p, res));

// ---------- State ----------
let refs!: UIRefs;
let settings: Settings = { ...DEFAULT_SETTINGS };
let userCaps = { can_download_without_watermark: false };
let isReady = false;

let directRunning = false;
let opActive = false;
let currentAbort: AbortController | null = null;

// ---------- Inject bearer hook ----------
(function injectHook() {
  const s = document.createElement('script');
  s.src = chrome.runtime.getURL('pageHook.js');
  (document.head || document.documentElement).appendChild(s);
  s.onload = () => s.remove();
})();

window.addEventListener('sora-token', async (ev: any) => {
  try {
    await send({ type: 'SET_TOKEN', token: ev.detail });
    const res = await send({ type: 'FETCH_PARAMS' });
    if (res?.ok && res.json) {
      const cap = res.json;
      userCaps.can_download_without_watermark =
        !!(cap?.can_download_without_watermark || cap?.capabilities?.can_download_without_watermark);
      isReady = true;
      renderAppView();
    }
  } catch {}
});

window.addEventListener('load', async () => {
  settings = await loadSettings();
  refs = buildUI();
  wireUI();
  renderNoTokenView();
  updateRunLabel();
});

// ---------- UI wiring ----------
function wireUI() {
  // radios
  refs.modeFinal?.addEventListener('change', () => toggleFast(false));
  refs.modeFast ?.addEventListener('change', () => toggleFast(true));

  // open / close
  refs.launch?.addEventListener('click', () => {
    refs.panel.style.display = 'flex';
    (refs.launch as HTMLElement).style.display = 'none';
    clearMiniBadge(refs);
    isReady ? renderAppView() : renderNoTokenView();
  });
  refs.hdrClose?.addEventListener('click', () => {
    refs.panel.style.display = 'none';
    (refs.launch as HTMLElement).style.display = 'flex';
    // re-évalue le badge si une op est en cours
    setMiniBadge(refs, refs.badge.textContent || '', undefined);
  });

  // settings open/close
  refs.btnSettings?.addEventListener('click', () => {
    populateSettings();
    refs.settings.style.display = 'block';
  });
  // le X de fermeture dans le panel settings (existe dans le markup ui.ts)
  refs.root.getElementById('sora-settings-close-button')
    ?.addEventListener('click', () => { refs.settings.style.display = 'none'; });

  // save settings
  refs.btnSave?.addEventListener('click', async () => {
    settings.workers             = clampInt(refs.parallel?.value, 1, 20, DEFAULT_SETTINGS.workers);
    settings.fastDownload        = !!refs.modeFast?.checked;
    settings.fastDownloadQuality = (refs.fastq?.value as any) || settings.fastDownloadQuality;
    settings.limit               = clampInt(refs.limit?.value, 1, DEFAULT_LIMIT, DEFAULT_SETTINGS.limit);
    settings.dryRun              = !!refs.dry?.checked;

    settings.directDownload = !!refs.direct?.checked;
    settings.directMaxTasks = clampInt(refs.maxTasks?.value, 1, 100, DEFAULT_SETTINGS.directMaxTasks);
    settings.directParallel = clampInt(refs.dParallel?.value, 1, 6, DEFAULT_SETTINGS.directParallel);
    settings.directSaveAs   = !!refs.saveAs?.checked;
    settings.directZip      = !!refs.zip?.checked;

    await saveSettings(settings);
    refs.settings.style.display = 'none';
    updateRunLabel();
  });

  // copy script
  refs.copyBtn?.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(refs.out.value); }
    catch {
      const sel = document.getSelection(); const r = document.createRange();
      r.selectNodeContents(refs.out); sel?.removeAllRanges(); sel?.addRange(r);
      document.execCommand('copy'); sel?.removeAllRanges();
    }
    refs.copyBtn.textContent = 'Copied!';
    setTimeout(() => refs.copyBtn.textContent = 'Copy Script', 1500);
  });

  // stop
  refs.stopBtn?.addEventListener('click', async () => {
    try { await send({ type: 'CANCEL_DIRECT_DOWNLOAD' }); } catch {}
    try { currentAbort?.abort(); } catch {}
    opActive = false;
    hidePanelProgress(refs);
    clearMiniBadge(refs);
    directRunning = false;
    updateRunLabel();
  });

  // run
  refs.runBtn?.addEventListener('click', runOnce);

  // background progress relay
  chrome.runtime.onMessage.addListener((msg: any) => {
    if (msg?.type !== 'DIRECT_PROGRESS') return;
    const { phase } = msg;
    if (phase === 'start') refs.status.textContent = `Direct: queued ${msg.total} item(s)…`;
    else if (phase === 'progress') {
      const p = msg.totalBytes ? Math.round((msg.bytesReceived / msg.totalBytes) * 100) : null;
      refs.status.textContent = `Direct: downloading ${msg.file}${p!=null?' ('+p+'%)':''}`;
    } else if (phase === 'item') {
      const base = `Direct: ${msg.state} — ${msg.file}`;
      refs.status.textContent = (typeof msg.done === 'number' && typeof msg.total === 'number')
        ? `${base} (${msg.done}/${msg.total})` : base;
    } else if (phase === 'cancel_start') {
      refs.status.textContent = 'Direct: cancel requested…';
    } else if (phase === 'cancel_done' || phase === 'done') {
      refs.status.textContent = `Direct: completed ${msg.done ?? ''}${msg.total ? '/' + msg.total : ''}`;
      directRunning = false; updateRunLabel();
    }
  });
}

// ---------- View helpers (single implementations) ----------
function renderNoTokenView() {
  refs.awaitBox.style.display = 'flex';
  refs.appBox.style.display = 'none';
  refs.btnSettings.style.display = 'none';
}

function renderAppView() {
  refs.awaitBox.style.display = 'none';
  refs.appBox.style.display = 'flex';
  refs.btnSettings.style.display = 'inline-block';
  const txt = refs.status?.textContent ?? '';
  if (txt.includes('Awaiting')) refs.status!.textContent = 'Ready.';
  updateSettingsUI();
}

function updateSettingsUI() {
  const canNoWM = !!userCaps?.can_download_without_watermark;
  if (!canNoWM) { refs.modeFinal && (refs.modeFinal.disabled = true); settings.fastDownload = true; }
  else          { refs.modeFinal && (refs.modeFinal.disabled = false); }
  populateSettings();
  updateRunLabel();
}

function populateSettings() {
  refs.parallel && (refs.parallel.value = String(settings.workers));
  refs.modeFinal && (refs.modeFinal.checked = !settings.fastDownload);
  refs.modeFast  && (refs.modeFast.checked  =  settings.fastDownload);
  refs.fastq     && (refs.fastq.value       = settings.fastDownloadQuality);
  refs.limit     && (refs.limit.value       = String(settings.limit));
  refs.dry       && (refs.dry.checked       = settings.dryRun);

  refs.direct    && (refs.direct.checked    = settings.directDownload);
  refs.maxTasks  && (refs.maxTasks.value    = String(settings.directMaxTasks));
  refs.dParallel && (refs.dParallel.value   = String(settings.directParallel));
  refs.saveAs    && (refs.saveAs.checked    = settings.directSaveAs);
  refs.zip       && (refs.zip.checked       = settings.directZip);

  toggleFast(settings.fastDownload);
  applyDirectDisable(settings.directDownload);
  updateRunLabel();
}

function toggleFast(isFast: boolean) {
  refs.parallelRow?.classList.toggle('sora-setting-inactive', isFast);
  refs.fastqRow?.classList.toggle('sora-setting-inactive', !isFast);
}

function applyDirectDisable(enabled: boolean) {
  refs.limitRow?.classList.toggle('sora-setting-inactive', enabled);
  if (refs.limit) refs.limit.disabled = enabled;
}

function updateRunLabel() {
  refs.runBtn.textContent = !settings.directDownload
    ? 'Generate Download Script'
    : (settings.directZip ? 'Zip & Download' : 'Direct Download');
  refs.stopBtn.style.display = directRunning ? 'inline-block' : 'none';
}

// ---------- Run flow ----------
async function runOnce() {
  refs.runBtn.disabled = true;
  refs.copyBtn.style.display = 'none';
  refs.exportBtn.style.display = 'none';
  refs.out.value = '';
  refs.runBtn.textContent = 'In progress...';

  refs.ring.style.animation = 'spin 1.2s linear infinite';
  refs.ring.style.border = '3px solid transparent';

  try {
    const listLimit = settings.directDownload ? settings.directMaxTasks : settings.limit;

    refs.status.textContent = 'Step 1/3: Fetching & filtering list...';

    const resList = await send({ type: 'FETCH_LIST', limit: listLimit });
    if (!resList?.ok) throw new Error(resList?.error || 'List fetch failed');
    const tasks: Task[] = Array.isArray(resList.json?.task_responses) ? resList.json.task_responses : [];

    const { valid, skipped } = filterGenerations(tasks);
    const validTasksCount = countValidTasks(tasks);
    refs.status.textContent = `${valid.length} valid generations found.`;

    let rows: { id: string; url: string; filename: string }[] = [];
    let failures: { id: string; reason: string }[] = [];

    if (valid.length) {
      if (settings.fastDownload) {
        refs.status.textContent = 'Step 2/3: Extracting URLs directly (fast mode)...';
        rows = valid.map((gen) => {
          const q = settings.fastDownloadQuality;
          const url = (gen.encodings as any)?.[q]?.path || (gen as any)?.url
            || gen?.encodings?.source?.path || gen?.encodings?.md?.path || gen?.encodings?.ld?.path || null;
        return url ? { id: gen.id, url, filename: `sora_${gen.id}.mp4` } : null as any;
        }).filter(Boolean);
      } else {
        refs.status.textContent = 'Step 2/3: Fetching URLs...';
        const ids = valid.map(g => g.id);
        const { successes, failures: f } =
          await fetchRawWithConcurrency(ids, settings.workers, (t,p)=> { refs.launch.title = t; }, send);
        rows = successes.map(s => ({ id: s.id, url: s.url, filename: `sora_${s.id}.mp4` }));
        failures = f;
      }

      const doDirect = settings.directDownload && validTasksCount <= settings.directMaxTasks;
      if (doDirect) {
        directRunning = true; updateRunLabel();
        opActive = true; setMiniBadge(refs, '', 'dl');

        if (settings.directZip) {
          // Phase A: DL → OPFS
          refs.status.textContent = `Downloading ${rows.length} file(s) locally…`;
          const acDL = new AbortController(); currentAbort = acDL;
          const { root, dir, dirName, metas } = await downloadAllToOPFS({
            items: rows.map(r => ({ url: r.url, filename: r.filename })),
            signal: acDL.signal,
            onStatus: ({phase, file, index, total}) => {
              if (phase === 'dl-progress') {
                setPanelProgress(refs, (index-1)/total*100, `Downloading ${index}/${total}`, file);
                setMiniBadge(refs, `DL ${index}/${total}`, 'dl');
              }
              if (phase === 'dl-file-done') {
                setPanelProgress(refs, index/total*100, `Downloaded ${index}/${total}`, file);
                setMiniBadge(refs, `DL ${index}/${total}`, 'dl');
              }
            }
          });

          // Phase B: ZIP → one browser download
          const acZIP = new AbortController(); currentAbort = acZIP;
          setPanelProgress(refs, undefined, `Preparing ZIP…`, '');
          setMiniBadge(refs, `ZIP 0/${metas.length}`, 'zip');

          const zipName = `${dirName}.zip`;
          const zipHandle = await dir.getFileHandle(zipName, { create: true });

          await writeZipFromOPFS({
            metas,
            saveHandle: zipHandle,
            signal: acZIP.signal,
            onStatus: ({phase, file, done, total}) => {
              if (phase === 'zip-progress') {
                setPanelProgress(refs, undefined, `Zipping ${Number(done||0)+1}/${total}`, file);
                setMiniBadge(refs, `ZIP ${Number(done||0)+1}/${total}`, 'zip');
              }
              if (phase === 'zip-file-done') {
                setPanelProgress(refs, (Number(done||0)/Number(total||1))*100, `Zipped ${done}/${total}`, file);
                setMiniBadge(refs, `ZIP ${done}/${total}`, 'zip');
              }
              if (phase === 'zip-done') {
                setPanelProgress(refs, 100, `ZIP completed (${total} files)`, '');
                clearMiniBadge(refs);
              }
              if (phase === 'cancel_done') {
                hidePanelProgress(refs); clearMiniBadge(refs);
              }
            }
          });

          // final download
          const zipFile = await (await dir.getFileHandle(zipName)).getFile();
          const blobUrl = URL.createObjectURL(zipFile);
          const a = document.createElement('a');
          a.href = blobUrl; a.download = zipName; refs.root.appendChild(a); a.click();
          setTimeout(() => { URL.revokeObjectURL(blobUrl); a.remove(); }, 2000);

          // Cleanup OPFS
          try { await opfsRemoveDir(root, dirName); } catch {}

          currentAbort = null;
          directRunning = false; updateRunLabel();
          opActive = false; hidePanelProgress(refs); clearMiniBadge(refs);

        } else {
          // Direct via chrome.downloads
          refs.status.textContent = `Direct: starting downloads for ${validTasksCount} task(s) (parallel ${settings.directParallel})…`;
          await send({ type: 'START_DIRECT_DOWNLOAD', items: rows, parallel: settings.directParallel, saveAs: settings.directSaveAs });
        }
      }

      // Script fallback
      const script = generateScript(rows, settings.fastDownload ? 'fast' : 'final',
        settings.fastDownload ? settings.fastDownloadQuality : 'n/a', failures, settings.dryRun);
      refs.out.value = script;

      let finalStatus = `Done! Script for ${rows.length} videos.`;
      if (failures.length) finalStatus += ` (${failures.length} failed).`;
      if (doDirect) finalStatus += ` Direct mode used.`;
      refs.status.textContent = finalStatus;

      refs.copyBtn.style.display = rows.length > 0 ? 'inline-block' : 'none';
      refs.exportBtn.style.display = rows.length > 0 ? 'inline-block' : 'none';

    } else {
      refs.status.textContent = 'No valid video generations found.';
      refs.out.value = '# No valid videos found.';
    }

  } catch (err: any) {
    refs.status.textContent = `ERROR: ${err.message || err}`;
    refs.out.value = `An error occurred.\n\n${err.stack || String(err)}`;
    opActive = false; hidePanelProgress(refs); clearMiniBadge(refs);

  } finally {
    refs.runBtn.disabled = false;
    updateRunLabel();
    refs.launch.title = 'Open Sora Batch Downloader';
    refs.ring.style.animation = '';
    refs.ring.style.backgroundImage = '';
    refs.ring.style.border = '2px solid #444';
    currentAbort = null;
  }
}

// ---------- helpers ----------
function generateScript(
  downloadRows: {id:string,url:string,filename:string}[],
  mode: 'fast'|'final',
  quality: string,
  failures: {id:string,reason:string}[],
  dryRun: boolean
) {
  const hdr = [
    '#!/bin/bash',
    `# Download script for ${downloadRows.length} Sora videos`,
    `# Mode: ${mode === 'fast' ? `Fast Download (Watermarked, ${quality})` : 'Final Quality (No Watermark)'}`,
    `# Format: curl`,
    `# Generated: ${new Date().toISOString()}`,
    ``
  ];
  const blocks: string[] = [];
  if (failures?.length) {
    blocks.push(`# --- FAILED during URL fetch ---`);
    for (const f of failures) blocks.push(`# ${f.id}: ${f.reason}`);
    blocks.push('');
  }
  if (!downloadRows.length) return [...hdr, ...blocks, '# No videos to download.'].join('\n');
  blocks.push(`echo "Starting download of ${downloadRows.length} videos..."`, ``);
  const cmdPrefix = dryRun ? '# ' : '';
  for (const row of downloadRows) {
    const fname = `sora_${row.id}.mp4`;
    blocks.push(`${cmdPrefix}curl -L -C - --fail --retry 5 --retry-delay 2 -o "${fname}" "${row.url.replace(/"/g,'\\"')}"`);
  }
  blocks.push(``, `echo "Download completed!"`);
  return [...hdr, ...blocks].join('\n');
}
