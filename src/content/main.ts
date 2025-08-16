/// <reference lib="dom" />
declare const chrome: any;

import { buildUI, UIRefs } from './ui';
import { setPanelProgress, hidePanelProgress, setMiniBadge, clearMiniBadge } from './hud';
import {
  DEFAULT_SETTINGS, DEFAULT_LIMIT, clampInt,
  loadSettings, saveSettings, type Settings
} from '../modules/settings';
import {
  fetchRawWithConcurrency,
  filterTasks,
  extendSoraTasks,
  SoraExtendedGeneration,
  emptySoraExtendedTasksMap,
} from '../modules/sora_api';
import {
  downloadAllToOPFS, writeZipFromOPFS, opfsRemoveDir, writeManifestsToOPFS, writeScriptToOPFS
} from '../modules/zip_store';
import * as SoraTypes from '../modules/sora_types'
import * as BatchManifest from '../modules/manifest'
import { generateJSONManifest } from '../modules/manifest';


// ---------- Messaging helper ----------
type SendFn = (p: any) => Promise<any>;
const send: SendFn = (p) => new Promise((res) => chrome.runtime.sendMessage(p, res));

// ---------- State ----------
let refs!: UIRefs;
let settings: Settings = { ...DEFAULT_SETTINGS };
let userCaps = { can_download_without_watermark: false };
let isReady = false;
let lastJsonManifest: BatchManifest.JSONManifest = { task_type: '', tasks: [], pruned: [], failures: [], mode: 'final', quality: 'source' }
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
    : 'Zip & Download';
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
    if ((!lastJsonManifest.tasks?.length) && (!lastJsonManifest.pruned?.length) && (!lastJsonManifest.failures?.length)) {
      alert('Nothing to export yet.'); return;
    }
    const ts = new Date().toISOString().replace(/[:\-]|\.\d{3}Z/g, '').slice(0, 15);
    const jsonManifestString = BatchManifest.JSONManifestToJSON(lastJsonManifest);
    triggerDownload(new Blob([jsonManifestString], { type: 'application/json' }), `sora_manifest_${ts}.json`);
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


function outPrintln(text: string) {
  refs.out.value += `${text}\n`;
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
    outPrintln(`# Fetching & filtering list...`)
    refs.status.textContent = 'Step 1/3: Fetching & filtering list...';

    const resList = await send({ type: 'FETCH_LIST', limit: listLimit, tasktype: refs.tasktype.value });
    if (!resList?.ok) throw new Error(resList?.error || 'List fetch failed');
    const _tasks: SoraTypes.Task[] = Array.isArray(resList.json?.task_responses) ? resList.json.task_responses : [];
    const tasks = extendSoraTasks(_tasks);

    let totalGenerations = 0;
    for (const t of tasks) {
      totalGenerations += t.generations.length;
    }

    const filteredTasks = filterTasks(tasks)
    outPrintln(`# Task type: ${refs.tasktype.value}`)
    outPrintln(`# Base total tasks: ${tasks.length}`)
    outPrintln(`# Base total generations: ${totalGenerations}`)
    outPrintln(`# Valid tasks: ${filteredTasks.tasks.length}`)
    outPrintln(`# Pruning log: ${filteredTasks.pruning_log.length}`)
    outPrintln(`#   Skipped tasks: ${filteredTasks.pruning_log.filter(p => p.kind === 'total').length}`)
    outPrintln(`#   Partially filtered tasks: ${filteredTasks.pruning_log.filter(p => p.kind === 'partial').length}`)
    outPrintln(`# Skipped generations: ${filteredTasks.skipped_generations.length}`)
    outPrintln(`# Valid generations: ${filteredTasks.tasks.reduce((acc, t) => acc + t.generations.length, 0)}`)


    const validTasksCount = filteredTasks.tasks.length;
    const valid: SoraExtendedGeneration[] = filteredTasks.tasks.map(t => t.generations).flat();
    refs.status.textContent = `${valid.length} valid generations found.`;

    let resolved: SoraExtendedGeneration[] = []
    let failures: { id: string; reason: string }[] = [];

    if (valid.length) {

      ///////// URL EXTRACTION /////////
      if (refs.tasktype.value === 'images') {
        outPrintln(`# Extracting URLs directly (Images mode)...`)
        refs.status.textContent = 'Step 2/3: Extracting URLs directly (Images mode)...';

        resolved = valid.map((gen) => {
          const url = (gen.url || null);
          if (url) {
            gen.result_url = url;
            return gen;
          }
          return null as any;
        }).filter(Boolean);
        setPanelProgress(refs, 100, 'Extracted URLs', '');
        setLauncherPct(100);
      }
      else if (settings.fastDownload) {
        outPrintln(`# Extracting URLs directly (Fast mode)...`)
        refs.status.textContent = 'Step 2/3: Extracting URLs directly (fast mode)...';

        resolved = valid.map((gen) => {
          const q = settings.fastDownloadQuality;
          const url = (gen.encodings as any)?.[q]?.path || (gen as any)?.url
            || gen?.encodings?.source?.path || gen?.encodings?.md?.path || gen?.encodings?.ld?.path || null;
          if (url) {
            gen.result_url = url;
            return gen;
          }
          return null as any;
        }).filter(Boolean);

        setPanelProgress(refs, 100, 'Extracted URLs', '');
        setLauncherPct(100);
      } else {
        outPrintln(`# Fetching RAW URLs (Final mode)...`)
        refs.status.textContent = 'Step 2/3: Fetching RAW URLs (Final mode)...';
        // Show HUD + mini badge during /raw
        setPanelProgress(refs, 0, 'Fetching URLs (0/0)', '');
        setMiniBadge(refs, `URL 0/0`, 'dl');

        const { successes, failures: f } =
          await fetchRawWithConcurrency(valid, settings.workers, (text, pct) => {
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

        outPrintln(`# Raw Fetch Successes: ${successes.length}`)
        outPrintln(`#            Failures: ${f.length}`)

        resolved = successes.map(s => s.generation);
        failures = f.map(f => ({ id: f.generation.id, reason: f.reason }));
      }
      outPrintln(`# Generations URL extraction complete.`)
      outPrintln(`#    ${resolved.length}/${valid.length} successfully extracted`)
      outPrintln(`#    ${valid.length - resolved.length}/${valid.length} missed`)
      outPrintln(`#    ${failures.length}/${valid.length} explicitely failed`)
      /////////////// URL EXTRACTION END ///////////////


      ///////// MANIFEST GENERATION /////////
      const generateMode = refs.tasktype.value === 'images' ? 'images' : settings.fastDownload ? 'fast' : 'final';
      const generateQuality = settings.fastDownload ? settings.fastDownloadQuality : 'n/a';
      const taskMap = emptySoraExtendedTasksMap(filteredTasks.tasks);
      for (const res of resolved) {
        taskMap.get(res.task_id)?.generations.push(res);
      }
      const resolvedTasks = Array.from(taskMap.values());
      lastJsonManifest = generateJSONManifest(refs.tasktype.value, resolvedTasks, filteredTasks.pruning_log, generateMode, generateQuality, failures);
      outPrintln(`# Manifest generated.`)

      ///////// DIRECT DL //////////////////////////////
      const doDirect = settings.directDownload && validTasksCount <= settings.directMaxTasks;
      if (doDirect) {
        outPrintln(`# Direct Download started...`)
        directRunning = true; updateRunLabel();
        opActive = true; setMiniBadge(refs, '', 'dl');


        // Phase A: DL → OPFS
        outPrintln(`# Downloading ${resolved.length} file(s) locally...`)
        refs.status.textContent = `Downloading ${resolved.length} file(s) locally…`;
        const acDL = new AbortController(); currentAbort = acDL;
        const { root, dir, dirName, metas } = await downloadAllToOPFS({
          items: resolved.map(r => ({ url: r.result_url, filename: r.result_filename })),
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
        outPrintln(`# Downloaded ${metas.length} file(s) locally...`)

        if (settings.directZipManifest) {
          outPrintln(`# Writing manifest to OPFS...`)
          const jsonMeta = await writeManifestsToOPFS(lastJsonManifest);
          metas.push(jsonMeta);
        }
        if (settings.directZipScript) {
          const onceScript = generateScript(
            resolved,
            generateMode,
            settings.fastDownload ? settings.fastDownloadQuality : 'n/a',
            failures,
            settings.dryRun,
            refs.out.value.split('\n')
          );
          outPrintln(`# Writing script to OPFS...`)
          const scriptMeta = await writeScriptToOPFS(onceScript);
          metas.push(scriptMeta);
        }

        // Phase B: ZIP → one browser download
        outPrintln(`# Preparing ZIP...`)
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
        outPrintln(`# Final browser download...`)
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

      }
      /////////////// DIRECT DL END ///////////////

      // Script fallback
      const script = generateScript(
        resolved,
        generateMode,
        settings.fastDownload ? settings.fastDownloadQuality : 'n/a',
        failures,
        settings.dryRun,
        refs.out.value.split('\n')
      );
      refs.out.value = script;
      lastScript = script;


      let finalStatus = `Done! Script for ${resolved.length} videos.`;
      if (failures.length) finalStatus += ` (${failures.length} failed).`;
      if (doDirect) finalStatus += ` Direct mode used.`;
      refs.status.textContent = finalStatus;

      refs.copyBtn.style.display = resolved.length > 0 ? 'inline-block' : 'none';
      refs.exportBtn.style.display = resolved.length > 0 ? 'inline-block' : 'none';

    } else {
      outPrintln(`# No valid video generations found.`)
      refs.status.textContent = 'No valid video generations found.';
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
  downloadRows: SoraExtendedGeneration[],
  mode: 'fast' | 'final' | 'images',
  quality: string,
  failures: { id: string, reason: string }[],
  dryRun: boolean,
  log: string[]
) {
  const tasktypeDesc = mode === 'images' ? "Images" : mode === 'fast' ? `Fast Download (Watermarked, ${quality})` : "Final Quality (No Watermark)";
  const hdr = [
    '#!/bin/bash',
    `# Download script for ${downloadRows.length} Sora ${mode === 'images' ? 'images' : 'videos'}`,
    `# Mode: ${tasktypeDesc}`,
    `# Format: curl`,
    `# Generated: ${new Date().toISOString()}`,
    ``,
  ];
  if (log.length) {
    hdr.push(`# ----- LOG ----`);
    hdr.push(...log);
    hdr.push('');
    hdr.push('# --- SCRIPT ---');
  }
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
    blocks.push(`curl -L -C - --fail --retry 5 --retry-delay 2 -o "${row.result_filename}" "${row.result_url.replace(/"/g, '\\"')}"`);
  }
  if (dryRun) {
    blocks.push(`EOF`);
  }
  blocks.push(``, `echo "Download completed!"`);
  return [...hdr, ...blocks].join('\n');
}

function triggerDownload(blob: Blob, filename: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = filename; refs.root.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 800);
}