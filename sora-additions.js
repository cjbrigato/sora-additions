// ==UserScript==
// @name         Sora Batch Downloader (Generator) v0.3
// @namespace    https://github.com/cjbrigato/tampermonkey-sora-additions
// @version      0.3.0
// @description  Generate robust bash scripts to download your Sora videos in batch (self-service only, no scraping beyond your session).
// @author       Le Porteur 2o & The Tisseur
// @match        https://sora.chatgpt.com/*
// @run-at       document-start
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_setClipboard
// @grant        GM_registerMenuCommand
// ==/UserScript==
(function() {
    'use strict';
  
    /*** ----------------------- Config & State ----------------------- ***/
    const API_BASE_URL = 'https://sora.chatgpt.com/backend';
    // Limit volontairement borné à 100 max ; tu peux le réduire via settings, mais pas l'augmenter
    const DEFAULT_LIMIT = 100;
  
    const ENDPOINTS = {
      list: (limit) => `${API_BASE_URL}/video_gen?limit=${Math.min(Math.max(1, limit|0 || DEFAULT_LIMIT), DEFAULT_LIMIT)}&task_type_filters=videos`,
      raw:  (id)    => `${API_BASE_URL}/generations/${id}/raw`,
      params:       `${API_BASE_URL}/parameters`,
    };
  
    let SORA_BEARER_TOKEN = null;
    let userCapabilities = { can_download_without_watermark: false };
    let isAppInitialized = false;
  
    const DEFAULT_SETTINGS = {
      workers: 8,                // nombre de requêtes RAW en parallèle (final mode seulement)
      fastDownload: false,       // fast = watermark (encodings source/md/ld)
      fastDownloadQuality: 'source', // 'source' | 'md' | 'ld'
      limit: DEFAULT_LIMIT,      // borné à 100 max
      dryRun: false              // si true, commente les curls (pour inspection)
    };
    let currentSettings = {...DEFAULT_SETTINGS};
  
    /*** ------------------- Robust fetch interception ------------------ ***/
    const originalFetch = unsafeWindow.fetch;
    unsafeWindow.fetch = async function(...args) {
      try {
        const [input, init] = args;
        let auth = null;
  
        // Case 1: input is a Request
        if (input instanceof Request && input.headers && typeof input.headers.get === 'function') {
          auth = input.headers.get('authorization') || input.headers.get('Authorization');
        }
  
        // Case 2: init.headers present
        if (!auth && init && init.headers) {
          if (init.headers instanceof Headers) {
            auth = init.headers.get('authorization') || init.headers.get('Authorization');
          } else if (typeof init.headers === 'object') {
            for (const k of Object.keys(init.headers)) {
              if (k.toLowerCase() === 'authorization') { auth = init.headers[k]; break; }
            }
          }
        }
  
        if (!SORA_BEARER_TOKEN && auth && typeof auth === 'string' && auth.startsWith('Bearer ')) {
          SORA_BEARER_TOKEN = auth.slice('Bearer '.length);
          console.log('[Sora DL] Bearer token intercepted.');
          initializeApp();
        }
      } catch (e) {
        // no-op (ne rien log avec headers)
      }
      return originalFetch.apply(this, args);
    };
  
    function fetchWithToken(url, token, init={}) {
      const headers = new Headers(init.headers || {});
      if (!headers.get('authorization')) headers.set('authorization', `Bearer ${token}`);
      return fetch(url, {...init, headers});
    }
  
    /*** ---------------------- App Initialization ---------------------- ***/
    async function initializeApp() {
      if (isAppInitialized || !SORA_BEARER_TOKEN) return;
      try {
        const response = await fetchWithToken(ENDPOINTS.params, SORA_BEARER_TOKEN);
        if (!response.ok) throw new Error(`API Error (parameters): ${response.status}`);
        const cap = await response.json();
        const canNoWM = Boolean(
          cap?.can_download_without_watermark ||
          cap?.capabilities?.can_download_without_watermark
        );
        userCapabilities = { can_download_without_watermark: canNoWM };
        isAppInitialized = true;
        console.log('[Sora DL] Capabilities loaded:', userCapabilities);
        renderAppView();
      } catch (err) {
        console.error('[Sora DL] Failed to initialize app.', err);
        const statusDiv = document.querySelector('#sora-status');
        if (statusDiv) statusDiv.textContent = 'Error loading user permissions.';
      }
    }
  
    /*** --------------------------- UI Setup --------------------------- ***/
    window.addEventListener('load', async () => {
      await loadSettings();
      injectUI();
    });
  
    async function loadSettings() {
      try {
        const saved = JSON.parse(await GM_getValue('soraDownloaderSettings', JSON.stringify(DEFAULT_SETTINGS)));
        currentSettings = { ...DEFAULT_SETTINGS, ...saved };
        // hard cap
        currentSettings.limit = Math.min(Math.max(1, currentSettings.limit|0), DEFAULT_SETTINGS.limit);
      } catch {
        currentSettings = {...DEFAULT_SETTINGS};
      }
    }
    async function saveSettings() {
      await GM_setValue('soraDownloaderSettings', JSON.stringify(currentSettings));
    }
  
    function injectUI() {
      GM_addStyle(`
        #sora-launcher-button{
          position: fixed; right: 18px; bottom: 18px; width: 56px; height: 56px;
          border-radius: 50%; background:#111; color:#fff; display:flex; align-items:center; justify-content:center;
          box-shadow:0 8px 24px rgba(0,0,0,.35); cursor:pointer; z-index: 999999;
          border: 2px solid #444;
        }
        #sora-launcher-button:hover{ background:#151515; }
        #sora-launcher-border{
          position:absolute; inset:2px; border-radius:50%;
        }
        #sora-downloader-panel{
          position: fixed; right: 18px; bottom: 86px; width: 560px; max-height: 74vh;
          display:none; flex-direction:column; gap:12px; background:#1e1e1e; color:#eee;
          border:1px solid #444; border-radius:12px; padding:12px; z-index: 999999; overflow: hidden;
        }
        #sora-panel-header{
          display:flex; align-items:center; justify-content:space-between; gap:8px; border-bottom:1px solid #333; padding-bottom:6px;
        }
        #sora-close-button{ cursor:pointer; font-size:22px; padding:4px 8px; }
        #sora-close-button:hover{ color:#f55; }
        #sora-settings-button{
          background:transparent; border:1px solid #444; color:#ddd; padding:4px 8px; border-radius:8px; cursor:pointer;
        }
        #sora-settings-button:hover{ border-color:#777; color:#fff; }
        #sora-no-token-view{
          display:flex; align-items:center; justify-content:center; flex-direction:column; gap:8px; min-height:120px;
        }
        .sora-spinner{
          width: 40px; height: 40px; border: 4px solid #444; border-top-color: #3a86ff; border-radius: 50%;
          animation: sora-button-spin 1s linear infinite;
        }
        .sora-subtext{ font-size:12px; color:#aaa; max-width: 86%; text-align:center; }
        @keyframes sora-button-spin{ from{ transform: rotate(0deg);} to{ transform: rotate(360deg);} }
        #sora-app-view{ display:none; flex-direction:column; gap:10px; width:100%; }
        #sora-status{ font-size:13px; color:#bbb; }
        #sora-result-textarea{
          width:100%; height: 280px; background:#0b0b0b; color:#b8ffb8; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
          border:1px solid #333; border-radius:10px; padding:10px; white-space:pre; overflow:auto;
        }
        .sora-row{ display:flex; gap:8px; align-items:center; }
        .sora-btn{
          background:#0d6efd; color:#fff; border:none; padding:8px 12px; border-radius:8px; cursor:pointer;
        }
        .sora-btn.secondary{ background:#2c2c2c; color:#ddd; border:1px solid #444; }
        .sora-btn:disabled{ opacity:0.6; cursor:not-allowed; }
        #sora-settings-panel{
          position: absolute; inset: 12px; background: #1a1a1a; border:1px solid #333; border-radius:10px; padding:10px; display:none;
          overflow:auto;
        }
        .sora-settings-content{ display:flex; flex-direction:column; gap:14px; }
        #sora-settings-header{ display:flex; align-items:center; justify-content:space-between; }
        #sora-settings-close-button{ cursor:pointer; font-size:20px; padding:2px 8px; }
        .sora-setting-row{ display:flex; justify-content:space-between; gap:8px; align-items:center; }
        .sora-setting-row > label { color:#ccc; }
        .sora-setting-group{ border-top:1px solid #333; padding-top:10px; }
        .sora-setting-inactive{ opacity:0.5; }
        .sora-disabled-option, .sora-disabled-option *{ cursor:not-allowed; opacity:0.6; }
        input[type="number"], select{
          background:#111; color:#eee; border:1px solid #444; border-radius:6px; padding:6px; min-width: 120px;
        }
      `);
  
      const launcher = document.createElement('div');
      launcher.id = 'sora-launcher-button';
      launcher.innerHTML = `
        <div id="sora-launcher-border"></div>
        <svg id="sora-launcher-icon" width="26" height="26" viewBox="0 0 24 24" fill="none">
          <path d="M12 4V16M12 16L8 12M12 16L16 12" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M4 20H20" stroke="white" stroke-width="2" stroke-linecap="round"/>
        </svg>
      `;
      launcher.title = 'Open Sora Batch Downloader';
      document.body.appendChild(launcher);
  
      const panel = document.createElement('div');
      panel.id = 'sora-downloader-panel';
      panel.innerHTML = `
        <div id="sora-panel-header">
          <button id="sora-settings-button" title="Settings" style="display:none;">⚙️ Settings</button>
          <h3 style="margin:0;">Sora Batch Downloader</h3>
          <div id="sora-close-button" title="Close">&times;</div>
        </div>
  
        <div id="sora-no-token-view">
          <div class="sora-spinner"></div>
          <p>Awaiting Token...</p>
          <p class="sora-subtext">Browse Sora (view/create a video) to activate the downloader.</p>
        </div>
  
        <div id="sora-app-view">
          <div class="sora-row">
            <button id="sora-run-button" class="sora-btn">Generate Download Script</button>
            <button id="sora-copy-button" class="sora-btn secondary" style="display:none;">Copy Script</button>
            <button id="sora-export-manifest-btn" class="sora-btn secondary" style="display:none;">Export Manifest (CSV/JSON)</button>
          </div>
          <div id="sora-status">Ready.</div>
          <textarea id="sora-result-textarea" readonly placeholder="# The script will appear here..."></textarea>
        </div>
  
        <div id="sora-settings-panel">
          <div class="sora-settings-content">
            <div id="sora-settings-header">
              <h4 style="margin:0;">Settings</h4>
              <div id="sora-settings-close-button" title="Close">&times;</div>
            </div>
  
            <div class="sora-setting-row sora-setting-group">
              <label>Download Mode:</label>
              <div id="sora-download-mode-selector" style="display:flex; gap:14px;">
                <div id="sora-final-quality-option">
                  <input type="radio" id="sora-mode-final" name="sora-download-mode" value="final">
                  <label for="sora-mode-final">Final Quality (no watermark)</label>
                </div>
                <div>
                  <input type="radio" id="sora-mode-fast" name="sora-download-mode" value="fast">
                  <label for="sora-mode-fast">Fast Download (with watermark)</label>
                </div>
              </div>
            </div>
  
            <div id="sora-fast-quality-container" class="sora-setting-row">
              <label for="sora-fast-quality-select">Fast Quality:</label>
              <select id="sora-fast-quality-select">
                <option value="source">Source (HD)</option>
                <option value="md">Medium</option>
                <option value="ld">Low</option>
              </select>
            </div>
  
            <div id="sora-parallel-container" class="sora-setting-row">
              <label for="sora-parallel-input">Parallel RAW requests:</label>
              <input type="number" id="sora-parallel-input" min="1" max="20">
            </div>
  
            <div class="sora-setting-row">
              <label for="sora-limit-input">List limit (max 100):</label>
              <input type="number" id="sora-limit-input" min="1" max="100">
            </div>
  
            <div class="sora-setting-row">
              <label for="sora-dryrun-checkbox">Dry-run (comment out curls)</label>
              <input type="checkbox" id="sora-dryrun-checkbox">
            </div>
  
            <button id="sora-settings-save-button" class="sora-btn">Save & Close</button>
          </div>
        </div>
      `;
      document.body.appendChild(panel);
  
      // Wiring
      const noTokenView  = panel.querySelector('#sora-no-token-view');
      const appView      = panel.querySelector('#sora-app-view');
      const settingsBtn  = panel.querySelector('#sora-settings-button');
      const closeBtn     = panel.querySelector('#sora-close-button');
      const runBtn       = panel.querySelector('#sora-run-button');
      const statusDiv    = panel.querySelector('#sora-status');
      const resultTA     = panel.querySelector('#sora-result-textarea');
      const copyBtn      = panel.querySelector('#sora-copy-button');
      const exportBtn    = panel.querySelector('#sora-export-manifest-btn');
  
      const settingsPanel   = panel.querySelector('#sora-settings-panel');
      const settingsClose   = panel.querySelector('#sora-settings-close-button');
      const settingsSave    = panel.querySelector('#sora-settings-save-button');
      const modeFinalRadio  = panel.querySelector('#sora-mode-final');
      const modeFastRadio   = panel.querySelector('#sora-mode-fast');
      const fastQualitySel  = panel.querySelector('#sora-fast-quality-select');
      const parallelInput   = panel.querySelector('#sora-parallel-input');
      const limitInput      = panel.querySelector('#sora-limit-input');
      const dryRunCheckbox  = panel.querySelector('#sora-dryrun-checkbox');
      const finalQualityOption = panel.querySelector('#sora-final-quality-option');
      const fastQualityContainer = panel.querySelector('#sora-fast-quality-container');
      const parallelContainer    = panel.querySelector('#sora-parallel-container');
  
      const launcherBorder = launcher.querySelector('#sora-launcher-border');
  
      function renderNoTokenView() {
        if (panel.style.display !== 'none') {
          noTokenView.style.display = 'flex';
          appView.style.display = 'none';
          settingsBtn.style.display = 'none';
        }
      }
      function renderAppView() {
        if (!isAppInitialized) return;
        if (panel.style.display !== 'none') {
          noTokenView.style.display = 'none';
          appView.style.display = 'flex';
          settingsBtn.style.display = 'inline-block';
          if (statusDiv.textContent.includes('permissions') || statusDiv.textContent.includes('Awaiting')) {
            statusDiv.textContent = 'Ready.';
          }
          updateSettingsUI();
        }
      }
      function updateSettingsUI() {
        // Lock final-quality if unavailable
        if (!userCapabilities.can_download_without_watermark) {
          finalQualityOption.title = 'Your plan does not allow downloading without watermark.';
          modeFinalRadio.disabled = true;
          finalQualityOption.classList.add('sora-disabled-option');
          currentSettings.fastDownload = true;
        } else {
          finalQualityOption.title = '';
          modeFinalRadio.disabled = false;
          finalQualityOption.classList.remove('sora-disabled-option');
        }
        populateSettingsPanel();
      }
      function populateSettingsPanel() {
        parallelInput.value = currentSettings.workers;
        modeFinalRadio.checked = !currentSettings.fastDownload;
        modeFastRadio.checked  = currentSettings.fastDownload;
        fastQualitySel.value   = currentSettings.fastDownloadQuality;
        limitInput.value       = currentSettings.limit;
        dryRunCheckbox.checked = currentSettings.dryRun;
        toggleSettingsInteractivity(currentSettings.fastDownload);
      }
      function toggleSettingsInteractivity(isFast) {
        // RAW parallel only relevant in final mode
        parallelContainer.classList.toggle('sora-setting-inactive', isFast);
        // Fast quality only relevant in fast mode
        fastQualityContainer.classList.toggle('sora-setting-inactive', !isFast);
      }
  
      panel.querySelector('#sora-download-mode-selector').addEventListener('change', (e) => {
        if (e.target.name === 'sora-download-mode') {
          toggleSettingsInteractivity(e.target.value === 'fast');
        }
      });
  
      launcher.addEventListener('click', () => {
        panel.style.display = 'flex';
        launcher.style.display = 'none';
        isAppInitialized ? renderAppView() : renderNoTokenView();
      });
      closeBtn.addEventListener('click', () => {
        panel.style.display = 'none';
        launcher.style.display = 'flex';
      });
      settingsBtn.addEventListener('click', () => {
        populateSettingsPanel();
        settingsPanel.style.display = 'block';
      });
      settingsClose.addEventListener('click', () => {
        settingsPanel.style.display = 'none';
      });
      settingsSave.addEventListener('click', async () => {
        currentSettings.workers = Math.min(Math.max(1, parseInt(parallelInput.value,10) || DEFAULT_SETTINGS.workers), 20);
        currentSettings.fastDownload = modeFastRadio.checked;
        currentSettings.fastDownloadQuality = fastQualitySel.value;
        currentSettings.limit = Math.min(Math.max(1, parseInt(limitInput.value,10) || DEFAULT_SETTINGS.limit), DEFAULT_SETTINGS.limit);
        currentSettings.dryRun = !!dryRunCheckbox.checked;
        await saveSettings();
        settingsPanel.style.display = 'none';
      });
      copyBtn.addEventListener('click', () => {
        GM_setClipboard(resultTA.value);
        copyBtn.textContent = 'Copied!';
        setTimeout(() => { copyBtn.textContent = 'Copy Script'; }, 1800);
      });
  
      let lastManifest = { rows: [], skipped: [], failures: [], mode: 'final', quality: 'source' };
      exportBtn.addEventListener('click', () => {
        if (!lastManifest || (!lastManifest.rows?.length && !lastManifest.skipped?.length && !lastManifest.failures?.length)) {
          alert('Nothing to export yet.');
          return;
        }
        const ts = new Date().toISOString().replaceAll(':','').replaceAll('-','').replace('.','').slice(0,15);
        // CSV
        const csvHeader = ['id','filename','url','mode','quality'];
        const csvRows = [csvHeader.join(',')].concat(lastManifest.rows.map(r =>
          [r.id, safeCSV(r.filename), safeCSV(r.url), lastManifest.mode, lastManifest.quality].join(',')
        ));
        const csvBlob = new Blob([csvRows.join('\n')], {type:'text/csv'});
        triggerDownload(csvBlob, `sora_manifest_${ts}.csv`);
        // JSON
        const jsonBlob = new Blob([JSON.stringify(lastManifest, null, 2)], {type:'application/json'});
        triggerDownload(jsonBlob, `sora_manifest_${ts}.json`);
      });
  
      function triggerDownload(blob, filename) {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
          URL.revokeObjectURL(a.href);
          a.remove();
        }, 1000);
      }
  
      /*** ---------------------- Core: Data fetching ---------------------- ***/
      async function fetchList(limit, token) {
        const res = await fetchWithToken(ENDPOINTS.list(limit), token);
        if (!res.ok) throw new Error(`API Error (list): ${res.status}`);
        const data = await res.json();
        // Expect data.task_responses
        return Array.isArray(data?.task_responses) ? data.task_responses : [];
      }
  
      function filterGenerations(tasks) {
        const valid = [];
        const skipped = [];
        for (const task of tasks) {
          if (task.status !== 'succeeded') {
            skipped.push({ id: task.id, reason: task.failure_reason || 'Task not succeeded' });
            continue;
          }
          if (!task.generations || task.generations.length === 0) {
            if (task.moderation_result?.is_output_rejection) {
              skipped.push({ id: task.id, reason: 'Content policy rejection' });
            } else {
              skipped.push({ id: task.id, reason: 'No generations' });
            }
            continue;
          }
          for (const gen of task.generations) {
            // Fast path (encodings present) — always needed for fast mode, also used as presence signal
            const hasFile = !!(gen?.encodings?.source?.path || gen?.encodings?.md?.path || gen?.encodings?.ld?.path);
            if (hasFile) valid.push(gen);
            else skipped.push({ id: gen.id || task.id, reason: 'Missing video file (encodings)' });
          }
        }
        return { valid, skipped };
      }
  
      async function getRawUrlWithRetry(id, token, attempt=1) {
        try {
          const res = await fetchWithToken(ENDPOINTS.raw(id), token);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const j = await res.json();
          if (!j?.url) throw new Error('URL field missing');
          return j.url;
        } catch (e) {
          if (attempt >= 5) throw e;
          const backoff = (2 ** (attempt - 1)) * 1000 + Math.random()*300; // 1s,2s,4s,8s + jitter
          await new Promise(r => setTimeout(r, backoff));
          return getRawUrlWithRetry(id, token, attempt+1);
        }
      }
  
      async function fetchRawUrlsParallel(ids, token, concurrency, onProgress) {
        const queue = ids.slice();
        const successes = [];
        const failures = [];
        let processed = 0, total = ids.length;
  
        async function worker() {
          while (queue.length) {
            const id = queue.shift();
            try {
              const url = await getRawUrlWithRetry(id, token);
              successes.push({ id, url });
            } catch (err) {
              failures.push({ id, reason: String(err.message || err) });
            } finally {
              processed++;
              const pct = total ? (processed/total*100) : 0;
              const txt = `Step 2/3: Fetching URLs (${processed}/${total})`;
              statusDiv.textContent = txt + '...';
              onProgress(txt, pct);
            }
          }
        }
        await Promise.all(Array(Math.min(concurrency, Math.max(1,total))).fill(0).map(worker));
        successes.sort((a,b) => ids.indexOf(a.id) - ids.indexOf(b.id));
        return { successes, failures };
      }
  
      /*** ---------------------- Script generation ----------------------- ***/
      function safeName(s) {
        return String(s||'').normalize('NFKD').replace(/[\/\\?%*:|"<>]/g,'_').replace(/\s+/g,' ').trim().slice(0, 120);
      }
      function fileNameFor(id) {
        return `sora_${id}.mp4`; // sobre & stable (pas de title/created_at pour rester futur-proof)
      }
  
      function generateScript(downloadRows, mode, quality, skipped, failures, dryRun) {
        statusDiv.textContent = 'Step 3/3: Generating final script...';
        const shebang = '#!/bin/bash';
        const hdr = [
          `${shebang}`,
          `# Download script for ${downloadRows.length} Sora videos`,
          `# Mode: ${mode === 'fast' ? `Fast Download (Watermarked, ${quality})` : 'Final Quality (No Watermark)'}`,
          `# Format: curl`,
          `# Generated: ${new Date().toISOString()}`,
          ``
        ];
        const blocks = [];
  
        if (skipped.length) {
          blocks.push(`# --- SKIPPED (pre-check) ---`);
          for (const s of skipped) blocks.push(`# ${s.id}: ${s.reason}`);
          blocks.push('');
        }
        if (failures.length) {
          blocks.push(`# --- FAILED during URL fetch ---`);
          for (const f of failures) blocks.push(`# ${f.id}: ${f.reason}`);
          blocks.push('');
        }
  
        if (!downloadRows.length) {
          return [...hdr, ...blocks, '# No videos to download.'].join('\n');
        }
  
        blocks.push(`echo "Starting download of ${downloadRows.length} videos..."`, ``);
  
        const cmdPrefix = dryRun ? '# ' : '';
        for (const row of downloadRows) {
          const fname = safeName(fileNameFor(row.id));
          // -L follow redirects, -C - resume, --fail for non-2xx, --retry for resilience
          blocks.push(`${cmdPrefix}curl -L -C - --fail --retry 5 --retry-delay 2 -o "${fname}" "${row.url.replace(/"/g,'\\"')}"`);
        }
  
        blocks.push(``, `echo "Download completed!"`);
        return [...hdr, ...blocks].join('\n');
      }
  
      /*** ----------------------------- Run ------------------------------ ***/
      GM_registerMenuCommand?.('Open Sora Downloader', () => {
        panel.style.display = 'flex'; launcher.style.display = 'none';
        isAppInitialized ? renderAppView() : renderNoTokenView();
      });
  
      runBtn.addEventListener('click', async () => {
        runBtn.disabled = true;
        copyBtn.style.display = 'none';
        exportBtn.style.display = 'none';
        resultTA.value = '';
        runBtn.textContent = 'In progress...';
  
        // Spinner border
        launcherBorder.style.animation = 'sora-button-spin 1.2s linear infinite';
        launcherBorder.style.border = '3px solid transparent';
        launcherBorder.style.backgroundOrigin = 'border-box'; launcherBorder.style.backgroundClip = 'content-box, border-box';
  
        const updateProgressUI = (text, pct) => {
          launcher.title = text;
          if (pct >= 0) {
            launcherBorder.style.backgroundImage = `conic-gradient(#0d6efd ${pct}%, #444 ${pct}%)`;
          } else {
            launcherBorder.style.backgroundImage = '';
            launcherBorder.style.border = '2px solid #444';
            launcherBorder.style.borderTopColor = '#0d6efd';
          }
        };
  
        try {
          updateProgressUI('Step 1/3: Fetching & filtering list...', -1);
          statusDiv.textContent = 'Step 1/3: Fetching & filtering list...';
  
          const tasks = await fetchList(currentSettings.limit, SORA_BEARER_TOKEN);
          const { valid, skipped } = filterGenerations(tasks);
          statusDiv.textContent = `${valid.length} valid generations found.`;
  
          let rows = [];
          let failures = [];
  
          if (valid.length) {
            if (currentSettings.fastDownload) {
              statusDiv.textContent = 'Step 2/3: Extracting URLs directly (fast mode)...';
              updateProgressUI('Extracting URLs (fast)...', 100);
              rows = valid.map(gen => {
                const q = currentSettings.fastDownloadQuality;
                const url = gen?.encodings?.[q]?.path || gen?.url || gen?.encodings?.source?.path || gen?.encodings?.md?.path || gen?.encodings?.ld?.path || null;
                return url ? { id: gen.id, url, filename: fileNameFor(gen.id) } : null;
              }).filter(Boolean);
            } else {
              // final-quality mode => hit /raw with concurrency & retry
              const ids = valid.map(g => g.id);
              const { successes, failures: f } = await fetchRawUrlsParallel(ids, SORA_BEARER_TOKEN, currentSettings.workers, updateProgressUI);
              rows = successes.map(s => ({ id: s.id, url: s.url, filename: fileNameFor(s.id) }));
              failures = f;
            }
  
            lastManifest = {
              rows,
              skipped,
              failures,
              mode: currentSettings.fastDownload ? 'fast' : 'final',
              quality: currentSettings.fastDownload ? currentSettings.fastDownloadQuality : 'n/a'
            };
  
            const script = generateScript(
              rows,
              lastManifest.mode,
              lastManifest.quality,
              skipped,
              failures,
              currentSettings.dryRun
            );
            resultTA.value = script;
  
            let finalStatus = `Done! Script for ${rows.length} videos.`;
            const totalSkipped = skipped.length + failures.length;
            if (totalSkipped > 0) finalStatus += ` (${totalSkipped} skipped/failed).`;
            statusDiv.textContent = finalStatus;
  
            if (rows.length > 0) {
              copyBtn.style.display = 'inline-block';
              exportBtn.style.display = 'inline-block';
            }
          } else {
            statusDiv.textContent = 'No valid video generations found.';
            resultTA.value = [
              '# No valid videos found.',
              '# Skipped tasks/generations:',
              ...skipped.map(f => `# - ${f.id}: ${f.reason}`)
            ].join('\n');
            lastManifest = { rows: [], skipped, failures: [], mode: currentSettings.fastDownload ? 'fast' : 'final', quality: currentSettings.fastDownload ? currentSettings.fastDownloadQuality : 'n/a' };
          }
  
        } catch (err) {
          console.error('[Sora DL] Error:', err);
          statusDiv.textContent = `ERROR: ${err.message || err}`;
          resultTA.value = `An error occurred. Check the console (F12).\n\n${err.stack || String(err)}`;
        } finally {
          runBtn.disabled = false;
          runBtn.textContent = 'Generate Download Script';
          launcher.title = 'Open Sora Batch Downloader';
          launcherBorder.style.animation = '';
          launcherBorder.style.backgroundImage = '';
          launcherBorder.style.border = '2px solid #444';
        }
      });
  
      // Helpers
      function safeCSV(s){ return `"${String(s??'').replaceAll('"','""')}"`; }
  
    } // injectUI()
  })();
  