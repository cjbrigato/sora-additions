// @ts-nocheck
import { createRoot } from "react-dom/client";
import App from "./App";

// content.js — v0.5.3 (hotfix)
// DL → OPFS → ZIP (STORE) → single browser download
// HUD in panel + mini badge on launcher; Stop is reliable; safe listeners.

(() => {
    'use strict';
  
    // ---------- Messaging ----------
    const API = {
      list:        (limit)                   => ({ type: 'FETCH_LIST', limit }),
      params:      ()                        => ({ type: 'FETCH_PARAMS' }),
      setToken:    (token)                   => ({ type: 'SET_TOKEN', token }),
      rawOne:      (id)                      => ({ type: 'FETCH_RAW_ONE', id }),
      startDirect: (items, parallel, saveAs) => ({ type: 'START_DIRECT_DOWNLOAD', items, parallel, saveAs }),
      cancelDirect:()                        => ({ type: 'CANCEL_DIRECT_DOWNLOAD' })
    };
  
    // ---------- Settings ----------
    const DEFAULT_LIMIT = 100;
    const DEFAULT_SETTINGS = {
      workers: 8,
      fastDownload: false,
      fastDownloadQuality: 'source',
      limit: DEFAULT_LIMIT,
      dryRun: false,
  
      directDownload: false,
      directMaxTasks: 20,
      directParallel: 3,
      directSaveAs: false, // chrome.downloads per-file Save As
      directZip: true      // ZIP batch (one Save As at the end)
    };
  
    let currentSettings = { ...DEFAULT_SETTINGS };
    let userCapabilities = { can_download_without_watermark: false };
    let isAppInitialized = false;
  
    let directRunning = false;
    let opActive = false;        // any DL/ZIP op in progress?
    let currentAbort = null;     // AbortController for DL/ZIP phase
  
    // ---------- ZIP STORE (content-side, Save As only at the end) ----------
    const CRC_TABLE = (() => {
      const t = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        t[n] = c >>> 0;
      }
      return t;
    })();
    function crc32Update(crc, chunk) {
      crc = crc ^ 0xFFFFFFFF;
      for (let i = 0; i < chunk.length; i++) crc = CRC_TABLE[(crc ^ chunk[i]) & 0xFF] ^ (crc >>> 8);
      return (crc ^ 0xFFFFFFFF) >>> 0;
    }
    const te = new TextEncoder();
    function dosDateTime(d = new Date()) {
      const dt = new Uint16Array(2);
      dt[0] = ((d.getHours() & 0x1F) << 11) | ((d.getMinutes() & 0x3F) << 5) | (Math.floor(d.getSeconds()/2) & 0x1F);
      dt[1] = (((d.getFullYear()-1980) & 0x7F) << 9) | (((d.getMonth()+1) & 0x0F) << 5) | (d.getDate() & 0x1F);
      return dt;
    }
    async function writeBuf(w, buf) { await w.write(buf); }
  
    // OPFS helpers
    async function opfsBatchRoot() {
      const root = await navigator.storage.getDirectory();
      const dirName = `sora_batch_${Date.now()}`;
      const dir = await root.getDirectoryHandle(dirName, { create: true });
      return { root, dir, dirName };
    }
    async function opfsRemoveDir(root, name) {
      try { await root.removeEntry(name, { recursive: true }); } catch {}
    }
  
    // Download each item to OPFS, compute CRC32 + size
    async function downloadAllToOPFS({ items, onStatus, signal }) {
      const { root, dir, dirName } = await opfsBatchRoot();
      const metas = [];
      let idx = 0;
      for (const it of items) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        const safeName = it.filename.replace(/[\\/:*?"<>|]/g, '_').slice(0, 180);
        const fh = await dir.getFileHandle(safeName, { create: true });
        const w = await fh.createWritable();
  
        let crc = 0, size = 0;
        const res = await fetch(it.url, { signal });
        if (!res.ok || !res.body) { await w.close(); throw new Error(`Fetch failed: ${safeName}`); }
        const reader = res.body.getReader();
  
        while (true) {
          if (signal?.aborted) { await w.close(); throw new DOMException('Aborted', 'AbortError'); }
          const { value, done } = await reader.read();
          if (done) break;
          const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
          crc = crc32Update(crc, chunk);
          size += chunk.length;
          await w.write(chunk);
          onStatus?.({ phase: 'dl-progress', file: safeName, index: idx+1, total: items.length });
        }
        await w.close();
        metas.push({ name: safeName, size, crc, handle: fh });
        idx++;
        onStatus?.({ phase: 'dl-file-done', file: safeName, index: idx, total: items.length });
      }
      return { root, dir, dirName, metas };
    }
  
    // Write ZIP (STORE) from OPFS files to final handle (no compression).
    // NOTE: classic PKZIP (no ZIP64) – upgrade if single file >4GB or very large offsets.
    async function writeZipFromOPFS({ metas, saveHandle, onStatus, signal }) {
      const writable = await saveHandle.createWritable();
      let offset = 0;
      const central = [];
      const now = dosDateTime();
  
      let done = 0;
      for (const m of metas) {
        if (signal?.aborted) { await writable.close(); throw new DOMException('Aborted', 'AbortError'); }
        const nameBytes = te.encode(m.name);
  
        // Local File Header (crc & sizes known → no data descriptor)
        const LFH = new Uint8Array(30 + nameBytes.length);
        const dv = new DataView(LFH.buffer);
        dv.setUint32(0, 0x04034b50, true);
        dv.setUint16(4, 20, true);     // version needed
        dv.setUint16(6, 0, true);      // flags
        dv.setUint16(8, 0, true);      // method STORE
        dv.setUint16(10, now[0], true);
        dv.setUint16(12, now[1], true);
        dv.setUint32(14, m.crc >>> 0, true);
        dv.setUint32(18, m.size >>> 0, true);
        dv.setUint32(22, m.size >>> 0, true);
        dv.setUint16(26, nameBytes.length, true);
        dv.setUint16(28, 0, true);
        LFH.set(nameBytes, 30);
  
        await writeBuf(writable, LFH);
        const localHeaderOffset = offset;
        offset += LFH.length;
  
        // stream file
        const file = await m.handle.getFile();
        const reader = file.stream().getReader();
        while (true) {
          if (signal?.aborted) { await writable.close(); throw new DOMException('Aborted', 'AbortError'); }
          const { value, done: rdDone } = await reader.read();
          if (rdDone) break;
          const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
          await writeBuf(writable, chunk);
          offset += chunk.length;
          onStatus?.({ phase: 'zip-progress', file: m.name });
        }
  
        // Central Directory entry
        const CEN = new Uint8Array(46 + nameBytes.length);
        const cdv = new DataView(CEN.buffer);
        cdv.setUint32(0, 0x02014b50, true);
        cdv.setUint16(4, 20, true);  // version made by
        cdv.setUint16(6, 20, true);  // version needed
        cdv.setUint16(8, 0, true);
        cdv.setUint16(10, 0, true);  // STORE
        cdv.setUint16(12, now[0], true);
        cdv.setUint16(14, now[1], true);
        cdv.setUint32(16, m.crc >>> 0, true);
        cdv.setUint32(20, m.size >>> 0, true);
        cdv.setUint32(24, m.size >>> 0, true);
        cdv.setUint16(28, nameBytes.length, true);
        cdv.setUint16(30, 0, true);
        cdv.setUint16(32, 0, true);
        cdv.setUint16(34, 0, true);
        cdv.setUint16(36, 0, true);
        cdv.setUint32(38, 0, true);
        cdv.setUint32(42, localHeaderOffset >>> 0, true);
        CEN.set(nameBytes, 46);
        central.push(CEN);
  
        done++;
        onStatus?.({ phase: 'zip-file-done', file: m.name, done, total: metas.length });
      }
  
      // central dir
      let cdSize = 0, cdOffset = offset;
      for (const c of central) { await writeBuf(writable, c); cdSize += c.length; }
      offset += cdSize;
  
      // EOCD
      const EOCD = new Uint8Array(22);
      const edv = new DataView(EOCD.buffer);
      edv.setUint32(0, 0x06054b50, true);
      edv.setUint16(4, 0, true);
      edv.setUint16(6, 0, true);
      edv.setUint16(8, central.length, true);
      edv.setUint16(10, central.length, true);
      edv.setUint32(12, cdSize >>> 0, true);
      edv.setUint32(16, cdOffset >>> 0, true);
      edv.setUint16(20, 0, true);
      await writeBuf(writable, EOCD);
  
      await writable.close();
      onStatus?.({ phase: 'zip-done' });
    }
  
    // ---------- Inject fetch hook in page to capture bearer ----------
    const inj = document.createElement('script');
    inj.src = chrome.runtime.getURL('pageHook.js');
    (document.head || document.documentElement).appendChild(inj);
    inj.onload = () => inj.remove();
  
    window.addEventListener('sora-token', async (ev) => {
      try {
        await send(API.setToken(ev.detail));
        const res = await send(API.params());
        if (res.ok && res.json) {
          const cap = res.json;
          const canNoWM = Boolean(cap?.can_download_without_watermark || cap?.capabilities?.can_download_without_watermark);
          userCapabilities = { can_download_without_watermark: canNoWM };
          isAppInitialized = true;
          renderAppView();
        }
      } catch {}
    });
  
    function send(payload) {
      return new Promise((resolve) => chrome.runtime.sendMessage(payload, resolve));
    }
  
    // ---------- Settings storage ----------
    async function loadSettings() {
      return new Promise((resolve) => {
        chrome.storage.sync.get('soraDownloaderSettings', (data) => {
          try {
            const saved = data?.soraDownloaderSettings ? JSON.parse(data.soraDownloaderSettings) : {};
          if (saved.directMaxItems && !saved.directMaxTasks) saved.directMaxTasks = saved.directMaxItems;
            currentSettings = { ...DEFAULT_SETTINGS, ...saved };
            currentSettings.limit          = clampInt(currentSettings.limit, 1, DEFAULT_LIMIT, DEFAULT_SETTINGS.limit);
            currentSettings.directMaxTasks = clampInt(currentSettings.directMaxTasks, 1, 100, DEFAULT_SETTINGS.directMaxTasks);
            currentSettings.directParallel = clampInt(currentSettings.directParallel, 1, 6, DEFAULT_SETTINGS.directParallel);
            currentSettings.directSaveAs   = !!currentSettings.directSaveAs;
            currentSettings.directZip      = !!currentSettings.directZip;
          } catch { currentSettings = { ...DEFAULT_SETTINGS }; }
          resolve();
        });
      });
    }
    async function saveSettings() {
      return new Promise((resolve) => {
        chrome.storage.sync.set({ soraDownloaderSettings: JSON.stringify(currentSettings) }, resolve);
      });
    }
  
    // ---------- UI ----------
    window.addEventListener('load', async () => {
      await loadSettings();
      injectShadowUI();
    });
  
    function injectShadowUI() {
      const host = document.createElement('div');
      host.style.all = 'initial';
      document.body.appendChild(host);
      const root = host.attachShadow({ mode: 'open' });
  
    createRoot(root).render(<App />);

      // ---- bind
      const ui = {};
      ui.root           = root;
      ui.launcher       = root.getElementById('sora-launcher-button');
      ui.launcherBorder = root.getElementById('sora-launcher-border');
      ui.panel          = root.getElementById('sora-downloader-panel');
      ui.noTokenView    = root.getElementById('sora-no-token-view');
      ui.appView        = root.getElementById('sora-app-view');
      ui.settingsBtn    = root.getElementById('sora-settings-button');
      ui.closeBtn       = root.getElementById('sora-close-button');
      ui.runBtn         = root.getElementById('sora-run-button');
      ui.stopBtn        = root.getElementById('sora-stop-button');
      ui.statusDiv      = root.getElementById('sora-status');
      ui.resultTA       = root.getElementById('sora-result-textarea');
      ui.copyBtn        = root.getElementById('sora-copy-button');
      ui.exportBtn      = root.getElementById('sora-export-manifest-btn');
  
      // Settings elements (classic)
      ui.settingsPanel  = root.getElementById('sora-settings-panel');
      ui.settingsSave   = root.getElementById('sora-settings-save-button');
      ui.modeFinalRadio = root.getElementById('sora-mode-final');
      ui.modeFastRadio  = root.getElementById('sora-mode-fast');
      ui.fastQualitySel = root.getElementById('sora-fast-quality-select');
      ui.parallelInput  = root.getElementById('sora-parallel-input');
      ui.limitRow       = root.getElementById('sora-limit-row');
      ui.limitInput     = root.getElementById('sora-limit-input');
      ui.dryRunCheckbox = root.getElementById('sora-dryrun-checkbox');
      ui.fastQualityContainer = root.getElementById('sora-fast-quality-container');
      ui.parallelContainer    = root.getElementById('sora-parallel-container');
  
      // Direct controls
      // (Optional UI — if you have these inputs in your settings panel, wire them here)
      const chkDirect         = root.getElementById('sora-direct-checkbox');
      const inpDirectMaxTasks = root.getElementById('sora-direct-max');
      const inpDirectParallel = root.getElementById('sora-direct-parallel');
      const chkDirectSaveAs   = root.getElementById('sora-direct-saveas');
      const chkDirectZip      = root.getElementById('sora-direct-zip');
  
      // Progress HUD
      const progressWrap = root.getElementById('sora-progress');
      const ringEl  = root.getElementById('sb-ring');
      const mainLine= root.getElementById('sb-main');
      const subLine = root.getElementById('sb-sub');
      const mini    = root.getElementById('sora-mini-badge');
  
      function setPanelProgress(pct, main, sub){
        progressWrap.style.display = 'flex';
        if (typeof pct === 'number') ringEl.style.setProperty('--pct', `${Math.max(0,Math.min(100,pct))}%`);
        mainLine.textContent = main || '';
        subLine.textContent  = sub  || '';
      }
      function hidePanelProgress(){ progressWrap.style.display = 'none'; }
      function setMiniBadge(text, phase){
        mini.textContent = text || '';
        mini.classList.remove('dl','zip');
        if (phase === 'dl') mini.classList.add('dl');
        else if (phase === 'zip') mini.classList.add('zip');
        mini.style.display = (opActive && ui.panel.style.display === 'none') ? 'inline-block' : 'none';
      }
      function clearMiniBadge(){ mini.style.display = 'none'; mini.textContent = ''; mini.classList.remove('dl','zip'); }
  
      function renderNoTokenView() {
        ui.noTokenView.style.display = 'flex';
        ui.appView.style.display = 'none';
        ui.settingsBtn.style.display = 'none';
      }
      function renderAppView() {
        if (!isAppInitialized) return;
        ui.noTokenView.style.display = 'none';
        ui.appView.style.display = 'flex';
        ui.settingsBtn.style.display = 'inline-block';
        if (ui.statusDiv.textContent.includes('permissions') || ui.statusDiv.textContent.includes('Awaiting')) {
          ui.statusDiv.textContent = 'Ready.';
        }
        updateSettingsUI();
      }
  
      function updateSettingsUI() {
        const canNoWM = !!userCapabilities?.can_download_without_watermark;
        if (!canNoWM) { ui.modeFinalRadio && (ui.modeFinalRadio.disabled = true); currentSettings.fastDownload = true; }
        else          { ui.modeFinalRadio && (ui.modeFinalRadio.disabled = false); }
        populateSettingsPanel();
        updateRunButtonLabel();
      }
  
      function populateSettingsPanel() {
        if (ui.parallelInput)  ui.parallelInput.value  = currentSettings.workers;
        if (ui.modeFinalRadio) ui.modeFinalRadio.checked = !currentSettings.fastDownload;
        if (ui.modeFastRadio)  ui.modeFastRadio.checked  =  currentSettings.fastDownload;
        if (ui.fastQualitySel) ui.fastQualitySel.value   = currentSettings.fastDownloadQuality;
        if (ui.limitInput)     ui.limitInput.value       = currentSettings.limit;
        if (ui.dryRunCheckbox) ui.dryRunCheckbox.checked = currentSettings.dryRun;
  
        // Direct UI (if present)
        if (chkDirect)         chkDirect.checked         = currentSettings.directDownload;
        if (inpDirectMaxTasks) inpDirectMaxTasks.value   = currentSettings.directMaxTasks;
        if (inpDirectParallel) inpDirectParallel.value   = currentSettings.directParallel;
        if (chkDirectSaveAs)   chkDirectSaveAs.checked   = currentSettings.directSaveAs;
        if (chkDirectZip)      chkDirectZip.checked      = currentSettings.directZip;
  
        toggleSettingsInteractivity(currentSettings.fastDownload);
        applyDirectDisable(currentSettings.directDownload);
        updateRunButtonLabel();
      }
  
      function toggleSettingsInteractivity(isFast) {
        ui.parallelContainer?.classList.toggle('sora-setting-inactive', isFast);
        ui.fastQualityContainer?.classList.toggle('sora-setting-inactive', !isFast);
      }
      function applyDirectDisable(enabled) {
        ui.limitRow?.classList.toggle('sora-setting-inactive', enabled);
        if (ui.limitInput) ui.limitInput.disabled = !!enabled;
      }
      function updateRunButtonLabel() {
        ui.runBtn.textContent = !currentSettings.directDownload
          ? 'Generate Download Script'
          : (currentSettings.directZip ? 'Zip & Download' : 'Direct Download');
        ui.stopBtn.style.display = directRunning ? 'inline-block' : 'none';
      }
  
      // Safe listeners (guards)
      ui.modeFinalRadio?.addEventListener('change', () => toggleSettingsInteractivity(false));
      ui.modeFastRadio?.addEventListener('change', () => toggleSettingsInteractivity(true));
  
      ui.launcher?.addEventListener('click', () => {
        ui.panel.style.display = 'flex';
        ui.launcher.style.display = 'none';
        clearMiniBadge();
        isAppInitialized ? renderAppView() : renderNoTokenView();
      });
      ui.closeBtn?.addEventListener('click', () => {
        ui.panel.style.display = 'none';
        ui.launcher.style.display = 'flex';
        setMiniBadge(mini.textContent); // re-evaluate visibility
      });
  
      ui.settingsBtn?.addEventListener('click', () => {
        populateSettingsPanel();
        ui.settingsPanel.style.display = 'block';
      });
      root.getElementById('sora-settings-close-button')?.addEventListener('click', () => {
        ui.settingsPanel.style.display = 'none';
      });
  
      // Direct toggles (if the checkbox exists)
      chkDirect?.addEventListener('change', () => {
        currentSettings.directDownload = !!chkDirect.checked;
        applyDirectDisable(currentSettings.directDownload);
        updateRunButtonLabel();
      });
  
      ui.settingsSave?.addEventListener('click', async () => {
        currentSettings.workers                  = clampInt(ui.parallelInput?.value, 1, 20, DEFAULT_SETTINGS.workers);
        currentSettings.fastDownload             = !!ui.modeFastRadio?.checked;
        currentSettings.fastDownloadQuality      = ui.fastQualitySel?.value || currentSettings.fastDownloadQuality;
        currentSettings.limit                    = clampInt(ui.limitInput?.value, 1, DEFAULT_LIMIT, DEFAULT_SETTINGS.limit);
        currentSettings.dryRun                   = !!ui.dryRunCheckbox?.checked;
  
        if (chkDirect)         currentSettings.directDownload = !!chkDirect.checked;
        if (inpDirectMaxTasks) currentSettings.directMaxTasks = clampInt(inpDirectMaxTasks.value, 1, 100, DEFAULT_SETTINGS.directMaxTasks);
        if (inpDirectParallel) currentSettings.directParallel = clampInt(inpDirectParallel.value, 1, 6, DEFAULT_SETTINGS.directParallel);
        if (chkDirectSaveAs)   currentSettings.directSaveAs   = !!chkDirectSaveAs.checked;
        if (chkDirectZip)      currentSettings.directZip      = !!chkDirectZip.checked;
  
        await saveSettings();
        ui.settingsPanel.style.display = 'none';
        updateRunButtonLabel();
      });
  
      ui.copyBtn?.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(ui.resultTA.value); }
        catch {
          const sel = document.getSelection(), range = document.createRange();
          range.selectNodeContents(ui.resultTA); sel.removeAllRanges(); sel.addRange(range);
          document.execCommand('copy'); sel.removeAllRanges();
        }
        ui.copyBtn.textContent = 'Copied!'; setTimeout(() => ui.copyBtn.textContent = 'Copy Script', 1500);
      });
  
      ui.stopBtn?.addEventListener('click', async () => {
        try { await send(API.cancelDirect()); } catch {}
        try { currentAbort?.abort(); } catch {}
        opActive = false;
        hidePanelProgress();
        clearMiniBadge();
        directRunning = false; updateRunButtonLabel();
      });
  
      // Export manifest (unchanged)
      let lastManifest = { rows: [], skipped: [], failures: [], mode: 'final', quality: 'source' };
      ui.exportBtn?.addEventListener('click', () => {
        if ((!lastManifest.rows?.length) && (!lastManifest.skipped?.length) && (!lastManifest.failures?.length)) {
          alert('Nothing to export yet.'); return;
        }
        const ts = new Date().toISOString().replace(/[:\-]|\.\d{3}Z/g,'').slice(0,15);
        const csvHeader = ['id','filename','url','mode','quality'];
        const toCSV = (v) => `"${String(v??'').replaceAll('"','""')}"`;
        const csvRows = [csvHeader.join(',')].concat(lastManifest.rows.map(r =>
          [r.id, toCSV(r.filename), toCSV(r.url), lastManifest.mode, lastManifest.quality].join(',')
        ));
        triggerDownload(new Blob([csvRows.join('\n')], {type:'text/csv'}), `sora_manifest_${ts}.csv`);
        triggerDownload(new Blob([JSON.stringify(lastManifest, null, 2)], {type:'application/json'}), `sora_manifest_${ts}.json`);
      });
      function triggerDownload(blob, filename) {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob); a.download = filename; ui.root.appendChild(a); a.click();
        setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 800);
      }
  
      // ---------------- Run ----------------
      ui.runBtn?.addEventListener('click', async () => {
        ui.runBtn.disabled = true;
        ui.copyBtn && (ui.copyBtn.style.display = 'none');
        ui.exportBtn && (ui.exportBtn.style.display = 'none');
        ui.resultTA.value = '';
        ui.runBtn.textContent = 'In progress...';
  
        ui.launcherBorder.style.animation = 'sb-spin 1.2s linear infinite';
        ui.launcherBorder.style.border = '3px solid transparent';
  
        const updateProgressUI = (text, pct) => {
          ui.launcher.title = text;
          if (typeof pct === 'number') {
            ui.launcherBorder.style.backgroundImage = `conic-gradient(#0d6efd ${pct}%, #444 ${pct}%)`;
          } else {
            ui.launcherBorder.style.backgroundImage = '';
            ui.launcherBorder.style.border = '2px solid #444';
            ui.launcherBorder.style.borderTopColor = '#0d6efd';
          }
        };
  
        try {
          const listLimit = currentSettings.directDownload ? currentSettings.directMaxTasks : currentSettings.limit;
  
          updateProgressUI('Step 1/3: Fetching & filtering list...', -1);
          ui.statusDiv.textContent = 'Step 1/3: Fetching & filtering list...';
  
          const resList = await send(API.list(listLimit));
          if (!resList?.ok) throw new Error(resList?.error || 'List fetch failed');
          const tasks = Array.isArray(resList.json?.task_responses) ? resList.json.task_responses : [];
  
          const { valid, skipped } = filterGenerations(tasks);
          const validTasksCount = countValidTasks(tasks);
          ui.statusDiv.textContent = `${valid.length} valid generations found.`;
  
          let rows = [];
          let failures = [];
  
          if (valid.length) {
            if (currentSettings.fastDownload) {
              ui.statusDiv.textContent = 'Step 2/3: Extracting URLs directly (fast mode)...';
              updateProgressUI('Extracting URLs (fast)...', 100);
              rows = valid.map(gen => {
                const q = currentSettings.fastDownloadQuality;
                const url = gen?.encodings?.[q]?.path || gen?.url || gen?.encodings?.source?.path || gen?.encodings?.md?.path || gen?.encodings?.ld?.path || null;
                return url ? { id: gen.id, url, filename: fileNameFor(gen.id) } : null;
              }).filter(Boolean);
            } else {
              ui.statusDiv.textContent = 'Step 2/3: Fetching URLs...';
              const ids = valid.map(g => g.id);
              const { successes, failures: f } = await fetchRawWithConcurrency(ids, currentSettings.workers, (t,p)=>updateProgressUI(t,p));
              rows = successes.map(s => ({ id: s.id, url: s.url, filename: fileNameFor(s.id) }));
              failures = f;
            }
  
            lastManifest = {
              rows, skipped, failures,
              mode: currentSettings.fastDownload ? 'fast' : 'final',
              quality: currentSettings.fastDownload ? currentSettings.fastDownloadQuality : 'n/a'
            };
  
            const doDirect = currentSettings.directDownload && validTasksCount <= currentSettings.directMaxTasks;
            if (doDirect) {
              directRunning = true; updateRunButtonLabel();
              opActive = true; setMiniBadge('', 'dl');
  
              if (currentSettings.directZip) {
                // Phase A: DL → OPFS
                ui.statusDiv.textContent = `Downloading ${rows.length} file(s) locally…`;
                const acDL = new AbortController(); currentAbort = acDL;
                const { root, dir, dirName, metas } = await downloadAllToOPFS({
                  items: rows.map(r => ({ url: r.url, filename: r.filename })),
                  signal: acDL.signal,
                  onStatus: ({phase, file, index, total}) => {
                    if (phase === 'dl-progress') {
                      setPanelProgress((index-1)/total*100, `Downloading ${index}/${total}`, file);
                      setMiniBadge(`DL ${index}/${total}`, 'dl');
                    }
                    if (phase === 'dl-file-done') {
                      setPanelProgress(index/total*100, `Downloaded ${index}/${total}`, file);
                      setMiniBadge(`DL ${index}/${total}`, 'dl');
                    }
                  }
                });
  
                // Phase B: ZIP (OPFS → single file) then one browser download
                const acZIP = new AbortController(); currentAbort = acZIP;
                setPanelProgress(undefined, `Preparing ZIP…`, '');
                setMiniBadge(`ZIP 0/${metas.length}`, 'zip');
  
                const zipName = `${dirName}.zip`;
                const zipHandle = await dir.getFileHandle(zipName, { create: true });
  
                await writeZipFromOPFS({
                  metas,
                  saveHandle: zipHandle,
                  signal: acZIP.signal,
                  onStatus: ({phase, file, done, total}) => {
                    if (phase === 'zip-progress') {
                      setPanelProgress(undefined, `Zipping ${done+1}/${total}`, file);
                      setMiniBadge(`ZIP ${done+1}/${total}`, 'zip');
                    }
                    if (phase === 'zip-file-done') {
                      setPanelProgress((done/total)*100, `Zipped ${done}/${total}`, file);
                      setMiniBadge(`ZIP ${done}/${total}`, 'zip');
                    }
                    if (phase === 'zip-done') {
                      setPanelProgress(100, `ZIP completed (${total} files)`, '');
                      clearMiniBadge();
                    }
                    if (phase === 'cancel_done') {
                      hidePanelProgress(); clearMiniBadge();
                    }
                  }
                });
  
                // Trigger final browser download
                const zipFile = await zipHandle.getFile();
                const url = URL.createObjectURL(zipFile);
                const a = document.createElement('a');
                a.href = url; a.download = zipName; ui.root.appendChild(a); a.click();
                setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 2000);
  
                // Cleanup OPFS
                try { await opfsRemoveDir(root, dirName); } catch {}
  
                currentAbort = null;
                directRunning = false; updateRunButtonLabel();
                opActive = false; hidePanelProgress(); clearMiniBadge();
  
              } else {
                // Direct via chrome.downloads
                ui.statusDiv.textContent = `Direct: starting downloads for ${validTasksCount} task(s) (parallel ${currentSettings.directParallel})…`;
                await send(API.startDirect(
                  rows.map(r => ({ url: r.url, filename: r.filename })),
                  currentSettings.directParallel,
                  currentSettings.directSaveAs
                ));
              }
            }
  
            // Always generate script as fallback
            const script = generateScript(rows, lastManifest.mode, lastManifest.quality, skipped, failures, currentSettings.dryRun);
            ui.resultTA.value = script;
  
            let finalStatus = `Done! Script for ${rows.length} videos.`;
            const totalSkipped = skipped.length + failures.length;
            if (totalSkipped > 0) finalStatus += ` (${totalSkipped} skipped/failed).`;
            if (doDirect) finalStatus += ` Direct mode used for ${validTasksCount} task(s).`;
            ui.statusDiv.textContent = finalStatus;
  
            ui.copyBtn && (ui.copyBtn.style.display = rows.length > 0 ? 'inline-block' : 'none');
            ui.exportBtn && (ui.exportBtn.style.display = rows.length > 0 ? 'inline-block' : 'none');
  
          } else {
            ui.statusDiv.textContent = 'No valid video generations found.';
            ui.resultTA.value = ['# No valid videos found.', '# Skipped tasks/generations:', ...skipped.map(f => `# - ${f.id}: ${f.reason}`)].join('\n');
          }
  
        } catch (err) {
          ui.statusDiv.textContent = `ERROR: ${err.message || err}`;
          ui.resultTA.value = `An error occurred.\n\n${err.stack || String(err)}`;
          opActive = false; hidePanelProgress(); clearMiniBadge();
        } finally {
          ui.runBtn.disabled = false;
          updateRunButtonLabel();
          ui.launcher.title = 'Open Sora Batch Downloader';
          ui.launcherBorder.style.animation = '';
          ui.launcherBorder.style.backgroundImage = '';
          ui.launcherBorder.style.border = '2px solid #444';
          currentAbort = null;
        }
      });
  
      // Direct progress relays (from background)
      chrome.runtime.onMessage.addListener((msg) => {
        if (msg?.type !== 'DIRECT_PROGRESS') return;
        const { phase } = msg;
        if (phase === 'start') ui.statusDiv.textContent = `Direct: queued ${msg.total} item(s)…`;
        else if (phase === 'progress') {
          const p = msg.totalBytes ? Math.round((msg.bytesReceived / msg.totalBytes) * 100) : null;
          ui.statusDiv.textContent = `Direct: downloading ${msg.file}${p!=null?' ('+p+'%)':''}`;
        } else if (phase === 'item') {
          const base = `Direct: ${msg.state} — ${msg.file}`;
          ui.statusDiv.textContent = (typeof msg.done === 'number' && typeof msg.total === 'number')
            ? `${base} (${msg.done}/${msg.total})` : base;
        } else if (phase === 'cancel_start') {
          ui.statusDiv.textContent = 'Direct: cancel requested…';
        } else if (phase === 'cancel_done' || phase === 'done') {
          ui.statusDiv.textContent = `Direct: completed ${msg.done ?? ''}${msg.total ? '/' + msg.total : ''}`;
          directRunning = false; updateRunButtonLabel();
        }
      });
  
      // init
      renderNoTokenView();
      updateRunButtonLabel();
    }
  
    // ---------- helpers (common) ----------
    function clampInt(v, min, max, fallback) {
      const n = parseInt(v ?? '', 10);
      if (Number.isFinite(n)) return Math.min(Math.max(n, min), max);
      return fallback;
    }
  
    function filterGenerations(tasks) {
      const valid = [], skipped = [];
      for (const task of tasks) {
        if (task?.status !== 'succeeded') { skipped.push({ id: task?.id, reason: task?.failure_reason || 'Task not succeeded' }); continue; }
        const gens = task?.generations;
        if (!Array.isArray(gens) || gens.length === 0) {
          skipped.push({ id: task?.id, reason: task?.moderation_result?.is_output_rejection ? 'Content policy rejection' : 'No generations' });
          continue;
        }
        for (const gen of gens) {
          const e = gen?.encodings;
          const ok = e?.source?.path || e?.md?.path || e?.ld?.path;
          if (ok) { valid.push(gen); } else { skipped.push({ id: gen?.id || task?.id, reason: 'Missing video file (encodings)' }); }
        }
      }
      return { valid, skipped };
    }
  
    function countValidTasks(tasks) {
      if (!Array.isArray(tasks)) return 0;
      let count = 0;
      for (const t of tasks) {
        if (t?.status !== 'succeeded') continue;
        const gens = t?.generations;
        if (!Array.isArray(gens) || gens.length === 0) continue;
        let ok = false;
        for (const g of gens) {
          const e = g?.encodings;
          if (e?.source?.path || e?.md?.path || e?.ld?.path) { ok = true; break; }
        }
        if (ok) count++;
      }
      return count;
    }
  
    async function fetchRawWithConcurrency(ids, concurrency, onProgress) {
      const queue = ids.slice();
      const successes = [], failures = [];
      let processed = 0, total = ids.length;
  
      async function worker() {
        while (queue.length) {
          const id = queue.shift();
          const res = await send(API.rawOne(id));
          if (res?.ok && res.url) successes.push({ id, url: res.url });
          else failures.push({ id, reason: res?.error || 'Unknown error' });
  
          processed++;
          const pct = total ? (processed / total) * 100 : 0;
          const txt = `Step 2/3: Fetching URLs (${processed}/${total})`;
          onProgress?.(txt, pct);
        }
      }
      await Promise.all(Array(Math.min(concurrency, Math.max(1, total))).fill(0).map(worker));
      successes.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
      return { successes, failures };
    }
  
    function fileNameFor(id) { return `sora_${id}.mp4`; }
    function safeName(s) {
      return String(s||'').normalize('NFKD').replace(/[\/\\?%*:|"<>]/g,'_').replace(/\s+/g,' ').trim().slice(0,120);
    }
    function generateScript(downloadRows, mode, quality, skipped, failures, dryRun) {
      const hdr = [
        '#!/bin/bash',
        `# Download script for ${downloadRows.length} Sora videos`,
        `# Mode: ${mode === 'fast' ? `Fast Download (Watermarked, ${quality})` : 'Final Quality (No Watermark)'}`,
        `# Format: curl`,
        `# Generated: ${new Date().toISOString()}`,
        ``
      ];
      const blocks = [];
      if (skipped.length) { blocks.push(`# --- SKIPPED (pre-check) ---`); for (const s of skipped) blocks.push(`# ${s.id}: ${s.reason}`); blocks.push(''); }
      if (failures.length) { blocks.push(`# --- FAILED during URL fetch ---`); for (const f of failures) blocks.push(`# ${f.id}: ${f.reason}`); blocks.push(''); }
      if (!downloadRows.length) return [...hdr, ...blocks, '# No videos to download.'].join('\n');
  
      blocks.push(`echo "Starting download of ${downloadRows.length} videos..."`, ``);
      const cmdPrefix = dryRun ? '# ' : '';
      for (const row of downloadRows) {
        const fname = safeName(fileNameFor(row.id));
        blocks.push(`${cmdPrefix}curl -L -C - --fail --retry 5 --retry-delay 2 -o "${fname}" "${row.url.replace(/"/g,'\\"')}"`);
      }
      blocks.push(``, `echo "Download completed!"`);
      return [...hdr, ...blocks].join('\n');
    }
  })();
