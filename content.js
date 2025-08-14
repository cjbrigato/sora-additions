// content.js — v0.4.3
// Shadow DOM UI, compact textarea + width fix, direct-by-tasks, disabled list-limit when direct on,
// run button label toggles to "Direct Download" when direct is enabled.
(() => {
    'use strict';
  
    // ---------- Messaging (content <-> background) ----------
    const API = {
      list:        (limit)           => ({ type: 'FETCH_LIST', limit }),
      params:      ()                => ({ type: 'FETCH_PARAMS' }),
      setToken:    (token)           => ({ type: 'SET_TOKEN', token }),
      rawOne:      (id)              => ({ type: 'FETCH_RAW_ONE', id }),
      startDirect: (items, parallel) => ({ type: 'START_DIRECT_DOWNLOAD', items, parallel })
    };
  
    // ---------- Settings ----------
    const DEFAULT_LIMIT = 100; // hard cap
    const DEFAULT_SETTINGS = {
      workers: 8,
      fastDownload: false,
      fastDownloadQuality: 'source', // 'source' | 'md' | 'ld'
      limit: DEFAULT_LIMIT,
      dryRun: false,
  
      // Direct mode (small batches) — by TASKS
      directDownload: false,
      directMaxTasks: 20, // X tasks => up to ~4*X downloads
      directParallel: 3   // concurrent chrome downloads (1..6 advised)
    };
  
    let currentSettings = { ...DEFAULT_SETTINGS };
    let userCapabilities = { can_download_without_watermark: false };
    let isAppInitialized = false;
  
    const ui = {};
  
    // ---------- Inject pageHook to capture Bearer ----------
    const s = document.createElement('script');
    s.src = chrome.runtime.getURL('pageHook.js');
    (document.head || document.documentElement).appendChild(s);
    s.onload = () => s.remove();
  
    window.addEventListener('sora-token', async (ev) => {
      const token = ev.detail;
      try {
        await send(API.setToken(token));
        const res = await send(API.params());
        if (res.ok && res.json) {
          const cap = res.json;
          const canNoWM = Boolean(cap?.can_download_without_watermark || cap?.capabilities?.can_download_without_watermark);
          userCapabilities = { can_download_without_watermark: canNoWM };
          isAppInitialized = true;
          renderAppView();
        }
      } catch (_) {}
    });
  
    function send(payload) {
      return new Promise((resolve) => chrome.runtime.sendMessage(payload, resolve));
    }
  
    // ---------- Storage ----------
    async function loadSettings() {
      return new Promise((resolve) => {
        chrome.storage.sync.get('soraDownloaderSettings', (data) => {
          try {
            const saved = data?.soraDownloaderSettings ? JSON.parse(data.soraDownloaderSettings) : {};
            // migration old key
            if (saved.directMaxItems && !saved.directMaxTasks) saved.directMaxTasks = saved.directMaxItems;
            currentSettings = { ...DEFAULT_SETTINGS, ...saved };
            currentSettings.limit = clampInt(currentSettings.limit, 1, DEFAULT_LIMIT, DEFAULT_SETTINGS.limit);
            currentSettings.directMaxTasks = clampInt(currentSettings.directMaxTasks, 1, 100, DEFAULT_SETTINGS.directMaxTasks);
            currentSettings.directParallel = clampInt(currentSettings.directParallel, 1, 6, DEFAULT_SETTINGS.directParallel);
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
    function clampInt(v, min, max, fallback) {
      const n = parseInt(v, 10);
      if (Number.isFinite(n)) return Math.min(Math.max(n, min), max);
      return fallback;
      }
  
    // ---------- UI (Shadow DOM) ----------
    window.addEventListener('load', async () => {
      await loadSettings();
      injectShadowUI();
    });
  
    function injectShadowUI() {
      const host = document.createElement('div');
      host.style.all = 'initial';
      document.body.appendChild(host);
      const root = host.attachShadow({ mode: 'open' });
  
      root.innerHTML = `
        <style>
          /* Ensure widths include padding/border and flex/grid items can shrink */
          :host, *, *::before, *::after { box-sizing: border-box; }
  
          @keyframes sora-button-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
  
          #sora-launcher-button{
            position: fixed; right: 18px; bottom: 18px; width: 56px; height: 56px;
            border-radius: 50%; background:#111; color:#fff; display:flex; align-items:center; justify-content:center;
            box-shadow:0 8px 24px rgba(0,0,0,.35); cursor:pointer; z-index: 2147483647; border: 2px solid #444;
          }
          #sora-launcher-button:hover{ background:#151515; }
          #sora-launcher-border{ position:absolute; inset:2px; border-radius:50%; }
  
          /* Panel bottom-right */
          #sora-downloader-panel{
            position: fixed; right: 18px; bottom: 18px; width: 560px; max-height: 74vh;
            display:none; flex-direction:column; gap:12px; background:#1e1e1e; color:#eee;
            border:1px solid #444; border-radius:12px; padding:12px; z-index: 2147483647; overflow: hidden;
            font: 13px/1.45 ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Cantarell, Noto Sans, Helvetica, Arial, "Apple Color Emoji","Segoe UI Emoji";
            min-width: 0; /* prevent children from forcing overflow */
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
  
          #sora-app-view{
            display:flex; flex-direction:column; gap:10px; width:100%;
            min-width: 0; /* lets textarea shrink */
          }
          #sora-status{ font-size:13px; color:#bbb; }
  
          /* Textarea compact + bulletproof width */
          #sora-result-textarea{
            display:block;
            width:100%;
            max-width:100%;
            box-sizing:border-box;
  
            height: 200px;
            max-height: calc(70vh - 260px);
            background:#0b0b0b; color:#b8ffb8;
            font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
            border:1px solid #333; border-radius:10px; padding:10px; white-space:pre;
            overflow-x:auto; overflow-y:auto;
          }
          #sora-result-textarea::-webkit-scrollbar{ width:10px; height:10px; }
          #sora-result-textarea::-webkit-scrollbar-track{ background:#0b0b0b; border-radius:8px; }
          #sora-result-textarea::-webkit-scrollbar-thumb{ background:#3a3a3a; border-radius:8px; border:2px solid #0b0b0b; }
          #sora-result-textarea::-webkit-scrollbar-thumb:hover{ background:#4a4a4a; }
  
          .sora-row{ display:flex; gap:8px; align-items:center; }
          .sora-btn{ background:#0d6efd; color:#fff; border:none; padding:8px 12px; border-radius:8px; cursor:pointer; }
          .sora-btn.secondary{ background:#2c2c2c; color:#ddd; border:1px solid #444; }
          .sora-btn:disabled{ opacity:0.6; cursor:not-allowed; }
  
          /* Settings overlay (no horizontal scrollbar) */
          #sora-settings-panel{
            position: absolute; inset: 12px; background: #1a1a1a; border:1px solid #333; border-radius:10px; padding:10px; display:none;
            overflow-y:auto; overflow-x:hidden;  /* <- kill horizontal bar */
            -webkit-overflow-scrolling: touch;
            min-width: 0;
          }
          .sora-settings-content{ display:flex; flex-direction:column; gap:14px; max-width:100%; min-width:0; }
          #sora-settings-header{ display:flex; align-items:center; justify-content:space-between; }
          #sora-settings-close-button{ cursor:pointer; font-size:20px; padding:2px 8px; }
  
          .sora-setting-row{ display:flex; justify-content:space-between; gap:8px; align-items:center; min-width:0; }
          .sora-setting-row > label { color:#ccc; }
          .sora-setting-group{ border-top:1px solid #333; padding-top:10px; }
          .sora-setting-inactive{ opacity:0.5; pointer-events:none; }
  
          .sora-disabled-option, .sora-disabled-option *{ cursor:not-allowed; opacity:0.6; }
  
          input[type="number"], select{
            background:#111; color:#eee; border:1px solid #444; border-radius:6px; padding:6px; min-width: 120px;
          }
  
          /* Direct controls aligned in a shrinking grid */
          .sora-inline{
            display:grid;
            grid-template-columns: minmax(0, max-content) minmax(0, max-content) minmax(0, max-content);
            gap:12px; align-items:center; justify-content:start;
            min-width:0;
          }
          .sora-inline .kv{
            display:grid; grid-template-columns: max-content minmax(0, 84px); gap:8px; align-items:center;
          }
          .sora-subnote{ font-size:12px; color:#9aa; margin-top:6px; }
        </style>
  
        <div id="sora-launcher-button" title="Open Sora Batch Downloader">
          <div id="sora-launcher-border"></div>
          <svg id="sora-launcher-icon" width="26" height="26" viewBox="0 0 24 24" fill="none">
            <path d="M12 4V16M12 16L8 12M12 16L16 12" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M4 20H20" stroke="white" stroke-width="2" stroke-linecap="round"/>
          </svg>
        </div>
  
        <div id="sora-downloader-panel">
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
  
              <div class="sora-setting-row" id="sora-limit-row">
                <label for="sora-limit-input">List limit (max 100):</label>
                <input type="number" id="sora-limit-input" min="1" max="100">
              </div>
  
              <div class="sora-setting-row">
                <label for="sora-dryrun-checkbox">Dry-run (comment out curls)</label>
                <input type="checkbox" id="sora-dryrun-checkbox">
              </div>
  
              <!-- Direct download (by tasks) -->
              <div class="sora-setting-row sora-setting-group">
                <label>Direct download (small batches)</label>
                <div class="sora-inline">
                  <label><input type="checkbox" id="sora-direct-checkbox"> Enable</label>
                  <label class="kv"><span>Max tasks</span><input type="number" id="sora-direct-max" min="1" max="100"></label>
                  <label class="kv"><span>Parallel</span><input type="number" id="sora-direct-parallel" min="1" max="6"></label>
                </div>
              </div>
              <div class="sora-subnote">Each task can yield up to 4 videos. For example, 5 tasks ≈ up to 20 downloads.</div>
  
              <button id="sora-settings-save-button" class="sora-btn" style="margin-top:8px;">Save & Close</button>
            </div>
          </div>
        </div>
      `;
  
      // Bind
      ui.root               = root;
      ui.launcher           = root.getElementById('sora-launcher-button');
      ui.launcherBorder     = root.getElementById('sora-launcher-border');
      ui.panel              = root.getElementById('sora-downloader-panel');
      ui.noTokenView        = root.getElementById('sora-no-token-view');
      ui.appView            = root.getElementById('sora-app-view');
      ui.settingsBtn        = root.getElementById('sora-settings-button');
      ui.closeBtn           = root.getElementById('sora-close-button');
      ui.runBtn             = root.getElementById('sora-run-button');
      ui.statusDiv          = root.getElementById('sora-status');
      ui.resultTA           = root.getElementById('sora-result-textarea');
      ui.copyBtn            = root.getElementById('sora-copy-button');
      ui.exportBtn          = root.getElementById('sora-export-manifest-btn');
  
      ui.settingsPanel      = root.getElementById('sora-settings-panel');
      ui.settingsClose      = root.getElementById('sora-settings-close-button');
      ui.settingsSave       = root.getElementById('sora-settings-save-button');
      ui.modeFinalRadio     = root.getElementById('sora-mode-final');
      ui.modeFastRadio      = root.getElementById('sora-mode-fast');
      ui.fastQualitySel     = root.getElementById('sora-fast-quality-select');
      ui.parallelInput      = root.getElementById('sora-parallel-input');
      ui.limitRow           = root.getElementById('sora-limit-row');
      ui.limitInput         = root.getElementById('sora-limit-input');
      ui.dryRunCheckbox     = root.getElementById('sora-dryrun-checkbox');
      ui.finalQualityOption = root.getElementById('sora-final-quality-option');
      ui.fastQualityContainer = root.getElementById('sora-fast-quality-container');
      ui.parallelContainer    = root.getElementById('sora-parallel-container');
  
      // Direct controls
      const chkDirect          = root.getElementById('sora-direct-checkbox');
      const inpDirectMaxTasks  = root.getElementById('sora-direct-max');
      const inpDirectParallel  = root.getElementById('sora-direct-parallel');
  
      // Helpers
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
        // lock final-quality if unavailable
        if (!userCapabilities.can_download_without_watermark) {
          ui.finalQualityOption.title = 'Your plan does not allow downloading without watermark.';
          ui.modeFinalRadio.disabled = true;
          ui.finalQualityOption.classList.add('sora-disabled-option');
          currentSettings.fastDownload = true;
        } else {
          ui.finalQualityOption.title = '';
          ui.modeFinalRadio.disabled = false;
          ui.finalQualityOption.classList.remove('sora-disabled-option');
        }
        populateSettingsPanel();
        updateRunButtonLabel();
      }
  
      function populateSettingsPanel() {
        ui.parallelInput.value        = currentSettings.workers;
        ui.modeFinalRadio.checked     = !currentSettings.fastDownload;
        ui.modeFastRadio.checked      =  currentSettings.fastDownload;
        ui.fastQualitySel.value       = currentSettings.fastDownloadQuality;
        ui.limitInput.value           = currentSettings.limit;
        ui.dryRunCheckbox.checked     = currentSettings.dryRun;
  
        chkDirect.checked             = currentSettings.directDownload;
        inpDirectMaxTasks.value       = currentSettings.directMaxTasks;
        inpDirectParallel.value       = currentSettings.directParallel;
  
        toggleSettingsInteractivity(currentSettings.fastDownload);
        applyDirectDisable(currentSettings.directDownload);
        updateRunButtonLabel();
      }
  
      function toggleSettingsInteractivity(isFast) {
        ui.parallelContainer.classList.toggle('sora-setting-inactive', isFast);
        ui.fastQualityContainer.classList.toggle('sora-setting-inactive', !isFast);
      }
  
      function applyDirectDisable(enabled) {
        ui.limitRow.classList.toggle('sora-setting-inactive', enabled);
        ui.limitInput.disabled = enabled;
      }
  
      function updateRunButtonLabel() {
        ui.runBtn.textContent = currentSettings.directDownload ? 'Direct Download' : 'Generate Download Script';
      }
  
      // Events
      root.getElementById('sora-download-mode-selector').addEventListener('change', (e) => {
        if (e.target.name === 'sora-download-mode') toggleSettingsInteractivity(e.target.value === 'fast');
      });
      chkDirect.addEventListener('change', () => {
        applyDirectDisable(chkDirect.checked);
        currentSettings.directDownload = chkDirect.checked; // reflect temp state in label
        updateRunButtonLabel();
      });
  
      ui.launcher.addEventListener('click', () => {
        ui.panel.style.display = 'flex';
        ui.launcher.style.display = 'none';
        isAppInitialized ? renderAppView() : renderNoTokenView();
      });
      ui.closeBtn.addEventListener('click', () => {
        ui.panel.style.display = 'none';
        ui.launcher.style.display = 'flex';
      });
      ui.settingsBtn.addEventListener('click', () => {
        populateSettingsPanel();
        ui.settingsPanel.style.display = 'block';
      });
      ui.settingsClose.addEventListener('click', () => ui.settingsPanel.style.display = 'none');
  
      ui.settingsSave.addEventListener('click', async () => {
        currentSettings.workers = clampInt(ui.parallelInput.value, 1, 20, DEFAULT_SETTINGS.workers);
        currentSettings.fastDownload = ui.modeFastRadio.checked;
        currentSettings.fastDownloadQuality = ui.fastQualitySel.value;
        currentSettings.limit = clampInt(ui.limitInput.value, 1, DEFAULT_LIMIT, DEFAULT_SETTINGS.limit);
        currentSettings.dryRun = !!ui.dryRunCheckbox.checked;
  
        currentSettings.directDownload = !!chkDirect.checked;
        currentSettings.directMaxTasks = clampInt(inpDirectMaxTasks.value, 1, 100, DEFAULT_SETTINGS.directMaxTasks);
        currentSettings.directParallel = clampInt(inpDirectParallel.value, 1, 6, DEFAULT_SETTINGS.directParallel);
  
        await saveSettings();
        ui.settingsPanel.style.display = 'none';
        updateRunButtonLabel();
      });
  
      ui.copyBtn.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(ui.resultTA.value); }
        catch {
          const sel = document.getSelection(), range = document.createRange();
          range.selectNodeContents(ui.resultTA); sel.removeAllRanges(); sel.addRange(range);
          document.execCommand('copy'); sel.removeAllRanges();
        }
        ui.copyBtn.textContent = 'Copied!'; setTimeout(() => ui.copyBtn.textContent = 'Copy Script', 1500);
      });
  
      // Manifest export
      let lastManifest = { rows: [], skipped: [], failures: [], mode: 'final', quality: 'source' };
      ui.exportBtn.addEventListener('click', () => {
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
      ui.runBtn.addEventListener('click', async () => {
        ui.runBtn.disabled = true;
        ui.copyBtn.style.display = 'none';
        ui.exportBtn.style.display = 'none';
        ui.resultTA.value = '';
        ui.runBtn.textContent = 'In progress...';
  
        ui.launcherBorder.style.animation = 'sora-button-spin 1.2s linear infinite';
        ui.launcherBorder.style.border = '3px solid transparent';
        ui.launcherBorder.style.backgroundOrigin = 'border-box'; ui.launcherBorder.style.backgroundClip = 'content-box, border-box';
  
        const updateProgressUI = (text, pct) => {
          ui.launcher.title = text;
          ui.launcherBorder.style.backgroundImage =
            pct >= 0 ? `conic-gradient(#0d6efd ${pct}%, #444 ${pct}%)` : '';
        };
  
        try {
          // When Direct is ON, list limit is overridden by "Max tasks"
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
  
            // Direct mode gate: by TASKS (not by downloads)
            const doDirect = currentSettings.directDownload && validTasksCount <= currentSettings.directMaxTasks;
            if (doDirect) {
              ui.statusDiv.textContent = `Direct: starting downloads for ${validTasksCount} task(s) (parallel ${currentSettings.directParallel})…`;
              await send(API.startDirect(rows.map(r => ({ url: r.url, filename: r.filename })), currentSettings.directParallel));
            }
  
            // Always output script as fallback
            const script = generateScript(rows, lastManifest.mode, lastManifest.quality, skipped, failures, currentSettings.dryRun);
            ui.resultTA.value = script;
  
            let finalStatus = `Done! Script for ${rows.length} videos.`;
            const totalSkipped = skipped.length + failures.length;
            if (totalSkipped > 0) finalStatus += ` (${totalSkipped} skipped/failed).`;
            if (doDirect) finalStatus += ` Direct mode used for ${validTasksCount} task(s).`;
            ui.statusDiv.textContent = finalStatus;
  
            if (rows.length > 0) {
              ui.copyBtn.style.display = 'inline-block';
              ui.exportBtn.style.display = 'inline-block';
            }
          } else {
            ui.statusDiv.textContent = 'No valid video generations found.';
            ui.resultTA.value = ['# No valid videos found.', '# Skipped tasks/generations:', ...skipped.map(f => `# - ${f.id}: ${f.reason}`)].join('\n');
            lastManifest = { rows: [], skipped, failures: [], mode: currentSettings.fastDownload ? 'fast' : 'final', quality: currentSettings.fastDownload ? currentSettings.fastDownloadQuality : 'n/a' };
          }
  
        } catch (err) {
          ui.statusDiv.textContent = `ERROR: ${err.message || err}`;
          ui.resultTA.value = `An error occurred.\n\n${err.stack || String(err)}`;
        } finally {
          ui.runBtn.disabled = false;
          updateRunButtonLabel(); // revert label to current mode
          ui.launcher.title = 'Open Sora Batch Downloader';
          ui.launcherBorder.style.animation = '';
          ui.launcherBorder.style.backgroundImage = '';
          ui.launcherBorder.style.border = '2px solid #444';
        }
      });
  
      // Direct progress from background
      chrome.runtime.onMessage.addListener((msg) => {
        if (msg?.type !== 'DIRECT_PROGRESS') return;
        const { phase } = msg;
        if (phase === 'start') {
          ui.statusDiv.textContent = `Direct: queued ${msg.total} item(s)…`;
        } else if (phase === 'progress') {
          const p = msg.totalBytes ? Math.round((msg.bytesReceived / msg.totalBytes) * 100) : null;
          ui.statusDiv.textContent = `Direct: downloading ${msg.file}${p!=null?' ('+p+'%)':''}`;
        } else if (phase === 'item') {
          const base = `Direct: ${msg.state} — ${msg.file}`;
          if (typeof msg.done === 'number' && typeof msg.total === 'number') {
            ui.statusDiv.textContent = `${base} (${msg.done}/${msg.total})`;
          } else {
            ui.statusDiv.textContent = base;
          }
        } else if (phase === 'done') {
          ui.statusDiv.textContent = `Direct: completed ${msg.done}/${msg.total}`;
        }
      });
  
      // init
      renderNoTokenView();
      updateRunButtonLabel();
    }
  
    // ---------- Helpers ----------
    function filterGenerations(tasks) {
      const valid = [], skipped = [];
      for (const task of tasks) {
        if (task.status !== 'succeeded') { skipped.push({ id: task.id, reason: task.failure_reason || 'Task not succeeded' }); continue; }
        if (!task.generations?.length) {
          skipped.push({ id: task.id, reason: task.moderation_result?.is_output_rejection ? 'Content policy rejection' : 'No generations' });
          continue;
        }
        for (const gen of task.generations) {
          const hasFile = !!(gen?.encodings?.source?.path || gen?.encodings?.md?.path || gen?.encodings?.ld?.path);
          if (hasFile) valid.push(gen);
          else skipped.push({ id: gen.id || task.id, reason: 'Missing video file (encodings)' });
        }
      }
      return { valid, skipped };
    }
  
    function countValidTasks(tasks) {
      let count = 0;
      for (const t of tasks) {
        if (t.status !== 'succeeded') continue;
        if (!t.generations?.length) continue;
        let ok = false;
        for (const gen of t.generations) {
          if (gen?.encodings?.source?.path || gen?.encodings?.md?.path || gen?.encodings?.ld?.path) { ok = true; break; }
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
      const shebang = '#!/bin/bash';
      const hdr = [
        shebang,
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
  