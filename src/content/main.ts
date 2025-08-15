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
  downloadAllToOPFS, writeZipFromOPFS, opfsRemoveDir, writeManifestsToOPFS, writeScriptToOPFS
} from '../modules/zip_store';

// ---------- Messaging helper ----------
type SendFn = (p: any) => Promise<any>;
const send: SendFn = (p) => new Promise((res) => chrome.runtime.sendMessage(p, res));

// ---------- State ----------
let refs!: UIRefs;
let settings: Settings = { ...DEFAULT_SETTINGS };
let userCaps = { can_download_without_watermark: false };
let isReady = false;
let lastManifest = { rows: [], skipped: [], failures: [], mode: 'final', quality: 'source' } as { rows: { id: string; filename: string; url: string }[]; skipped: string[]; failures: { id: string; reason: string }[]; mode: string; quality: string };
let lastScript = '';

let directRunning = false;
let opActive = false;
let currentAbort: AbortController | null = null;
let settingsOpen = false; // avoid overwriting inputs while editing

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
  } catch { }
});

window.addEventListener('load', async () => {
  settings = await loadSettings();
  refs = await buildUI();
  wireUI();
  renderNoTokenView();
  updateRunLabel();
});

// ---------- UI helpers ----------
function setLauncherPct(p?: number) {
  if (typeof p === 'number') {
    const v = Math.max(0, Math.min(100, p));
    refs.ring.style.backgroundImage = `conic-gradient(#0d6efd ${v}%, #444 ${v}%)`;
  } else {
    refs.ring.style.backgroundImage = '';
    refs.ring.style.border = '2px solid #444';
    refs.ring.style.borderTopColor = '#0d6efd';
  }
}

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
  else { refs.modeFinal && (refs.modeFinal.disabled = false); }
  if (!settingsOpen) populateSettings();
  updateRunLabel();
}

function populateSettings() {
  refs.parallel && (refs.parallel.value = String(settings.workers));
  refs.modeFinal && (refs.modeFinal.checked = !settings.fastDownload);
  refs.modeFast && (refs.modeFast.checked = settings.fastDownload);
  refs.fastq && (refs.fastq.value = settings.fastDownloadQuality);
  refs.limit && (refs.limit.value = String(settings.limit));
  refs.dry && (refs.dry.checked = settings.dryRun);

  refs.direct && (refs.direct.checked = settings.directDownload);
  refs.maxTasks && (refs.maxTasks.value = String(settings.directMaxTasks));
  refs.dParallel && (refs.dParallel.value = String(settings.directParallel));
  refs.manifestZip && (refs.manifestZip.checked = settings.directZipManifest);
  refs.scriptZip && (refs.scriptZip.checked = settings.directZipScript);
  settings.directZip = true;
  settings.directSaveAs = false;

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

// ---------- Wiring ----------
function wireUI() {
  // radios
  refs.modeFinal?.addEventListener('change', () => toggleFast(false));
  refs.modeFast?.addEventListener('change', () => toggleFast(true));
  if (refs.direct) {
    refs.direct.addEventListener('change', () => applyDirectDisable(refs.direct!.checked));
  }

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
    if (!opActive) {
      clearMiniBadge(refs);
    } else {
      setMiniBadge(refs, refs.badge.textContent || '', undefined);
    }
  });

  // settings open/close
  refs.btnSettings?.addEventListener('click', () => {
    settingsOpen = true;
    populateSettings();
    refs.settings.style.display = 'block';
  });
  refs.root.getElementById('sora-settings-close-button')
    ?.addEventListener('click', () => { refs.settings.style.display = 'none'; settingsOpen = false; });

  // save settings
  refs.btnSave?.addEventListener('click', async () => {
    settings.workers = clampInt(refs.parallel?.value, 1, 20, DEFAULT_SETTINGS.workers);
    settings.fastDownload = !!refs.modeFast?.checked;
    settings.fastDownloadQuality = (refs.fastq?.value as any) || settings.fastDownloadQuality;
    settings.limit = clampInt(refs.limit?.value, 1, DEFAULT_LIMIT, DEFAULT_SETTINGS.limit);
    settings.dryRun = !!refs.dry?.checked;

    settings.directDownload = !!refs.direct?.checked;
    settings.directMaxTasks = clampInt(refs.maxTasks?.value, 1, 100, DEFAULT_SETTINGS.directMaxTasks);
    settings.directParallel = clampInt(refs.dParallel?.value, 1, 6, DEFAULT_SETTINGS.directParallel);
    settings.directSaveAs = false;
    settings.directZip = true;

    await saveSettings(settings);
    refs.settings.style.display = 'none';
    settingsOpen = false;
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
    try { await send({ type: 'CANCEL_DIRECT_DOWNLOAD' }); } catch { }
    try { currentAbort?.abort(); } catch { }
    opActive = false;
    hidePanelProgress(refs);
    clearMiniBadge(refs);
    directRunning = false;
    updateRunLabel();
    setLauncherPct(undefined);
  });


  // Export manifest 
  refs.exportBtn?.addEventListener('click', () => {
    if ((!lastManifest.rows?.length) && (!lastManifest.skipped?.length) && (!lastManifest.failures?.length)) {
      alert('Nothing to export yet.'); return;
    }
    const ts = new Date().toISOString().replace(/[:\-]|\.\d{3}Z/g, '').slice(0, 15);
    const csvHeader = ['id', 'filename', 'url', 'mode', 'quality'];
    const toCSV = (v: string) => `"${String(v ?? '').replaceAll('"', '""')}"`;
    const csvRows = [csvHeader.join(',')].concat(lastManifest.rows.map(r =>
      [r.id, toCSV(r.filename), toCSV(r.url), lastManifest.mode, lastManifest.quality].join(',')
    ));
    triggerDownload(new Blob([csvRows.join('\n')], { type: 'text/csv' }), `sora_manifest_${ts}.csv`);
    triggerDownload(new Blob([JSON.stringify(lastManifest, null, 2)], { type: 'application/json' }), `sora_manifest_${ts}.json`);
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
      refs.status.textContent = `Direct: downloading ${msg.file}${p != null ? ' (' + p + '%)' : ''}`;
    } else if (phase === 'item') {
      const base = `Direct: ${msg.state} — ${msg.file}`;
      refs.status.textContent = (typeof msg.done === 'number' && typeof msg.total === 'number')
        ? `${base} (${msg.done}/${msg.total})` : base;
    } else if (phase === 'cancel_start') {
      refs.status.textContent = 'Direct: cancel requested…';
    } else if (phase === 'cancel_done' || phase === 'done') {
      refs.status.textContent = `Direct: completed ${msg.done ?? ''}${msg.total ? '/' + msg.total : ''}`;
      directRunning = false; updateRunLabel();
      setLauncherPct(undefined);
    }
  });
}



// ---------- Run flow ----------
async function runOnce() {
  refs.runBtn.disabled = true;
  refs.tasktype.disabled = true;
  refs.settingsBtn.disabled = true;
  refs.copyBtn.style.display = 'none';
  refs.exportBtn.style.display = 'none';
  refs.out.value = '';
  refs.runBtn.textContent = 'In progress...';

  // launcher visual
  refs.ring.style.animation = 'spin 1.2s linear infinite';
  refs.ring.style.border = '3px solid transparent';
  setLauncherPct(0);

  try {
    const listLimit = settings.directDownload ? settings.directMaxTasks : settings.limit;

    refs.status.textContent = 'Step 1/3: Fetching & filtering list...';

    const resList = await send({ type: 'FETCH_LIST', limit: listLimit, tasktype: refs.tasktype.value });
    if (!resList?.ok) throw new Error(resList?.error || 'List fetch failed');
    const tasks: Task[] = Array.isArray(resList.json?.task_responses) ? resList.json.task_responses : [];

    const { valid } = filterGenerations(tasks);
    const validTasksCount = countValidTasks(tasks);
    refs.status.textContent = `${valid.length} valid generations found.`;

    let rows: { id: string; url: string; filename: string }[] = [];
    let failures: { id: string; reason: string }[] = [];

    if (valid.length) {
      if (refs.tasktype.value === 'images') {
        refs.status.textContent = 'Step 2/3: Extracting URLs directly (Images mode)...';
        rows = valid.map((gen) => {
          const url = (gen.url || null);
          return url ? { id: gen.id, url, filename: `sora_${gen.id}.png` } : null as any;
        }).filter(Boolean);
        setPanelProgress(refs, 100, 'Extracted URLs', '');
        setLauncherPct(100);
      }
      else if (settings.fastDownload) {
        refs.status.textContent = 'Step 2/3: Extracting URLs directly (fast mode)...';
        rows = valid.map((gen) => {
          const q = settings.fastDownloadQuality;
          const url = (gen.encodings as any)?.[q]?.path || (gen as any)?.url
            || gen?.encodings?.source?.path || gen?.encodings?.md?.path || gen?.encodings?.ld?.path || null;
          return url ? { id: gen.id, url, filename: `sora_${gen.id}.mp4` } : null as any;
        }).filter(Boolean);
        // step instantly “complete” → show 100%
        setPanelProgress(refs, 100, 'Extracted URLs', '');
        setLauncherPct(100);
      } else {
        refs.status.textContent = 'Step 2/3: Fetching URLs...';
        // Show HUD + mini badge during /raw
        setPanelProgress(refs, 0, 'Fetching URLs (0/0)', '');
        setMiniBadge(refs, `URL 0/0`, 'dl');

        const ids = valid.map(g => g.id);
        const { successes, failures: f } =
          await fetchRawWithConcurrency(ids, settings.workers, (text, pct) => {
            // Parse "(x/y)" to display counts
            const m = /(\d+)\s*\/\s*(\d+)\)/.exec(text);
            if (m) {
              const x = Number(m[1]), y = Number(m[2]);
              setPanelProgress(refs, pct, `Fetching URLs (${x}/${y})`, '');
              setMiniBadge(refs, `URL ${x}/${y}`, 'dl');
              setLauncherPct(pct);
            } else {
              setPanelProgress(refs, pct, 'Fetching URLs', '');
              setLauncherPct(pct);
            }
          }, send);

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
            onStatus: ({ phase, file, index, total }) => {
              if (phase === 'dl-progress') {
                const pct = ((index - 1) / total) * 100;
                setPanelProgress(refs, pct, `Downloading ${index}/${total}`, file);
                setMiniBadge(refs, `DL ${index}/${total}`, 'dl');
                setLauncherPct(pct);
              }
              if (phase === 'dl-file-done') {
                const pct = (index / total) * 100;
                setPanelProgress(refs, pct, `Downloaded ${index}/${total}`, file);
                setMiniBadge(refs, `DL ${index}/${total}`, 'dl');
                setLauncherPct(pct);
              }
            }
          });

          if (settings.directZipManifest || settings.directZipScript) {
            const generateMode = refs.tasktype.value === 'images' ? 'images' : settings.fastDownload ? 'fast' : 'final';
            if (settings.directZipManifest) {
              const onceManifest = generateManifest(rows, generateMode, settings.fastDownload ? settings.fastDownloadQuality : 'n/a', failures);
              const { csvMeta, jsonMeta } = await writeManifestsToOPFS(onceManifest);
              metas.push(csvMeta, jsonMeta);
            }
            if (settings.directZipScript) {
              const onceScript = generateScript(
                rows,
                generateMode,
                settings.fastDownload ? settings.fastDownloadQuality : 'n/a',
                failures,
                settings.dryRun
              );
              const scriptMeta = await writeScriptToOPFS(onceScript);
              metas.push(scriptMeta);
            }
          }

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
            onStatus: ({ phase, file, done, total }) => {
              if (phase === 'zip-progress') {
                setPanelProgress(refs, undefined, `Zipping ${Number(done || 0) + 1}/${total}`, file);
                setMiniBadge(refs, `ZIP ${Number(done || 0) + 1}/${total}`, 'zip');
              }
              if (phase === 'zip-file-done') {
                const pct = (Number(done || 0) / Number(total || 1)) * 100;
                setPanelProgress(refs, pct, `Zipped ${done}/${total}`, file);
                setMiniBadge(refs, `ZIP ${done}/${total}`, 'zip');
                setLauncherPct(pct);
              }
              if (phase === 'zip-done') {
                setPanelProgress(refs, 100, `ZIP completed (${total} files)`, '');
                clearMiniBadge(refs);
                setLauncherPct(100);
              }
              if (phase === 'cancel_done') {
                hidePanelProgress(refs); clearMiniBadge(refs);
              }
            }
          });

          // final browser download
          const zipFile = await (await dir.getFileHandle(zipName)).getFile();
          const blobUrl = URL.createObjectURL(zipFile);
          const a = document.createElement('a');
          a.href = blobUrl; a.download = zipName; refs.root.appendChild(a); a.click();
          setTimeout(() => { URL.revokeObjectURL(blobUrl); a.remove(); }, 2000);

          // Cleanup OPFS
          try { await opfsRemoveDir(root, dirName); } catch { }

          currentAbort = null;
          directRunning = false; updateRunLabel();
          opActive = false; hidePanelProgress(refs); clearMiniBadge(refs);
          setLauncherPct(undefined);

        } else {
          // Direct via chrome.downloads
          refs.status.textContent = `Direct: starting downloads for ${validTasksCount} task(s) (parallel ${settings.directParallel})…`;
          await send({ type: 'START_DIRECT_DOWNLOAD', items: rows, parallel: settings.directParallel, saveAs: settings.directSaveAs });
        }
      }

      const generateMode = refs.tasktype.value === 'images' ? 'images' : settings.fastDownload ? 'fast' : 'final';
      // Script fallback
      const script = generateScript(
        rows,
        generateMode,
        settings.fastDownload ? settings.fastDownloadQuality : 'n/a',
        failures,
        settings.dryRun
      );
      refs.out.value = script;
      lastScript = script;
      lastManifest = generateManifest(rows, generateMode, settings.fastDownload ? settings.fastDownloadQuality : 'n/a', failures);

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
    refs.tasktype.disabled = false;
    refs.settingsBtn.disabled = false;
    updateRunLabel();
    hidePanelProgress(refs); clearMiniBadge(refs);
    refs.launch.title = 'Open Sora Batch Downloader';
    refs.ring.style.animation = '';
    // leave ring fill as-is if 100% just happened; else clear
    setLauncherPct(undefined);
    currentAbort = null;
  }
}

// ---------- helpers ----------
function generateScript(
  downloadRows: { id: string, url: string, filename: string }[],
  mode: 'fast' | 'final' | 'images',
  quality: string,
  failures: { id: string, reason: string }[],
  dryRun: boolean
) {
  const tasktypeDesc = mode === 'images' ? "Images" : mode === 'fast' ? `Fast Download (Watermarked, ${quality})` : "Final Quality (No Watermark)";
  const hdr = [
    '#!/bin/bash',
    `# Download script for ${downloadRows.length} Sora ${mode === 'images' ? 'images' : 'videos'}`,
    `# Mode: ${tasktypeDesc}`,
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
  blocks.push(`echo "Starting download of ${downloadRows.length} ${mode === 'images' ? 'images' : 'videos'}..."`, ``);
  if (dryRun) {
    blocks.push(`echo "Dry run, skipping download, printing curl commands instead..."`);
    blocks.push(`cat << 'EOF'`);
  }
  for (const row of downloadRows) {
    let fname = `sora_${row.id}.mp4`;
    if (refs.tasktype.value === 'images') {
      fname = `sora_${row.id}.png`;
    }
    blocks.push(`curl -L -C - --fail --retry 5 --retry-delay 2 -o "${fname}" "${row.url.replace(/"/g, '\\"')}"`);
  }
  if (dryRun) {
    blocks.push(`EOF`);
  }
  blocks.push(``, `echo "Download completed!"`);
  return [...hdr, ...blocks].join('\n');
}

function generateManifest(downloadRows: { id: string, url: string, filename: string }[],
  mode: 'fast' | 'final' | 'images',
  quality: string,
  failures: { id: string, reason: string }[]) {
  const manifest = { rows: [], skipped: [], failures: [], mode: 'final', quality: 'source' } as { rows: { id: string; filename: string; url: string }[]; skipped: string[]; failures: { id: string; reason: string }[]; mode: string; quality: string };
  manifest.rows = downloadRows.map(r => ({ id: r.id, filename: r.filename, url: r.url }));
  manifest.failures = failures;
  manifest.mode = mode;
  manifest.quality = quality;
  return manifest;
}

function triggerDownload(blob: Blob, filename: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = filename; refs.root.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 800);
}