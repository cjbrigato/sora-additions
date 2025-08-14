// content.js — v0.5.3
(() => {
    'use strict';

    // ---------- Messaging ----------
    const API = {
        list: (limit) => ({ type: 'FETCH_LIST', limit }),
        params: () => ({ type: 'FETCH_PARAMS' }),
        setToken: (token) => ({ type: 'SET_TOKEN', token }),
        rawOne: (id) => ({ type: 'FETCH_RAW_ONE', id }),
        startDirect: (items, parallel, saveAs) => ({ type: 'START_DIRECT_DOWNLOAD', items, parallel, saveAs }),
        cancelDirect: () => ({ type: 'CANCEL_DIRECT_DOWNLOAD' })
    };
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
        directZip: true      // Zip mode (Save As une seule fois à la fin)
    };

    let currentSettings = { ...DEFAULT_SETTINGS };
    let userCapabilities = { can_download_without_watermark: false };
    let isAppInitialized = false;
    let directRunning = false;

    // ---------- ZIP STORE (content-side, Save As à la fin) ----------
    // CRC32 table
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
        dt[0] = ((d.getHours() & 0x1F) << 11) | ((d.getMinutes() & 0x3F) << 5) | ((Math.floor(d.getSeconds() / 2)) & 0x1F);
        dt[1] = (((d.getFullYear() - 1980) & 0x7F) << 9) | (((d.getMonth() + 1) & 0x0F) << 5) | (d.getDate() & 0x1F);
        return dt;
    }
    async function writeBuf(w, buf) { await w.write(buf); }
    function u16(v) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, v, true); return b; }
    function u32(v) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0, true); return b; }

    // OPFS helpers
    async function opfsBatchRoot() {
        const root = await navigator.storage.getDirectory();
        const dirName = `sora_batch_${Date.now()}`;
        const dir = await root.getDirectoryHandle(dirName, { create: true });
        return { root, dir, dirName };
    }
    async function opfsRemoveDir(root, name) {
        try { await root.removeEntry(name, { recursive: true }); } catch { }
    }

    // DL vers OPFS : retourne meta { name, size, crc, handle }
    async function downloadAllToOPFS({ items, onStatus, signal }) {
        const root = await navigator.storage.getDirectory();
        const dirName = `sora_batch_${Date.now()}`;
        const dir = await root.getDirectoryHandle(dirName, { create: true });

        const metas = [];
        let idx = 0;
        for (const it of items) {
            if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

            const fileSafe = it.filename.replace(/[\\/:*?"<>|]/g, '_').slice(0, 180);
            const fh = await dir.getFileHandle(fileSafe, { create: true });
            const w = await fh.createWritable();

            let crc = 0, size = 0;
            const res = await fetch(it.url, { signal });
            if (!res.ok || !res.body) { await w.close(); throw new Error(`Fetch failed: ${fileSafe}`); }
            const reader = res.body.getReader();
            while (true) {
                if (signal?.aborted) { await w.close(); throw new DOMException('Aborted', 'AbortError'); }
                const { value, done } = await reader.read();
                if (done) break;
                const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
                crc = crc32Update(crc, chunk);
                size += chunk.length;
                await w.write(chunk);
                onStatus?.({ phase: 'dl-progress', file: fileSafe, index: idx + 1, total: items.length });
            }
            await w.close();
            metas.push({ name: fileSafe, size, crc, handle: fh });
            idx++;
            onStatus?.({ phase: 'dl-file-done', file: fileSafe, index: idx, total: items.length });
        }
        return { root, dir, dirName, metas };
    }

    // Écrit le ZIP en STORE depuis OPFS vers handle final (Save As) — utilise metas connus (size+crc)
    async function writeZipFromOPFS({ metas, saveHandle, onStatus, signal }) {
        const writable = await saveHandle.createWritable();
        let offset = 0;
        const central = [];
        const now = dosDateTime();

        let done = 0;
        for (const m of metas) {
            if (signal?.aborted) { await writable.close(); throw new DOMException('Aborted', 'AbortError'); }
            const nameBytes = te.encode(m.name);

            // Local File Header (pas de data descriptor → on a CRC/size)
            const LFH = new Uint8Array(30 + nameBytes.length);
            const dv = new DataView(LFH.buffer);
            dv.setUint32(0, 0x04034b50, true);
            dv.setUint16(4, 20, true);      // version needed
            dv.setUint16(6, 0, true);       // general purpose flags
            dv.setUint16(8, 0, true);       // method STORE
            dv.setUint16(10, now[0], true); // time
            dv.setUint16(12, now[1], true); // date
            dv.setUint32(14, m.crc >>> 0, true);
            dv.setUint32(18, m.size >>> 0, true); // compressed size = size
            dv.setUint32(22, m.size >>> 0, true); // uncompressed size
            dv.setUint16(26, nameBytes.length, true);
            dv.setUint16(28, 0, true);
            LFH.set(nameBytes, 30);

            await writeBuf(writable, LFH);
            const localHeaderOffset = offset;
            offset += LFH.length;

            // Stream data depuis OPFS vers ZIP
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
            cdv.setUint16(8, 0, true);   // flags
            cdv.setUint16(10, 0, true);  // method STORE
            cdv.setUint16(12, now[0], true);
            cdv.setUint16(14, now[1], true);
            cdv.setUint32(16, m.crc >>> 0, true);
            cdv.setUint32(20, m.size >>> 0, true);
            cdv.setUint32(24, m.size >>> 0, true);
            cdv.setUint16(28, nameBytes.length, true);
            cdv.setUint16(30, 0, true); // extra
            cdv.setUint16(32, 0, true); // comment
            cdv.setUint16(34, 0, true); // disk num
            cdv.setUint16(36, 0, true); // internal attrs
            cdv.setUint32(38, 0, true); // external attrs
            cdv.setUint32(42, localHeaderOffset >>> 0, true);
            CEN.set(nameBytes, 46);
            central.push(CEN);

            done++;
            onStatus?.({ phase: 'zip-file-done', file: m.name, done, total: metas.length });
        }

        // Central dir
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

    // ---------- plumbing de l’extension ----------
    const ui = {};

    // hook fetch dans la page pour intercepter le Bearer
    const s = document.createElement('script');
    s.src = chrome.runtime.getURL('pageHook.js');
    (document.head || document.documentElement).appendChild(s);
    s.onload = () => s.remove();

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
        } catch { }
    });

    function send(payload) {
        return new Promise((resolve) => chrome.runtime.sendMessage(payload, resolve));
    }

    // settings storage
    async function loadSettings() {
        return new Promise((resolve) => {
            chrome.storage.sync.get('soraDownloaderSettings', (data) => {
                try {
                    const saved = data?.soraDownloaderSettings ? JSON.parse(data.soraDownloaderSettings) : {};
                    if (saved.directMaxItems && !saved.directMaxTasks) saved.directMaxTasks = saved.directMaxItems;
                    currentSettings = { ...DEFAULT_SETTINGS, ...saved };
                    currentSettings.limit = clampInt(currentSettings.limit, 1, DEFAULT_LIMIT, DEFAULT_SETTINGS.limit);
                    currentSettings.directMaxTasks = clampInt(currentSettings.directMaxTasks, 1, 100, DEFAULT_SETTINGS.directMaxTasks);
                    currentSettings.directParallel = clampInt(currentSettings.directParallel, 1, 6, DEFAULT_SETTINGS.directParallel);
                    currentSettings.directSaveAs = !!currentSettings.directSaveAs;
                    currentSettings.directZip = !!currentSettings.directZip;
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
          :host, *, *::before, *::after { box-sizing: border-box; }
          @keyframes sora-button-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
  
          #sora-launcher-button{
            position: fixed; right: 18px; bottom: 18px; width: 56px; height: 56px;
            border-radius: 50%; background:#111; color:#fff; display:flex; align-items:center; justify-content:center;
            box-shadow:0 8px 24px rgba(0,0,0,.35); cursor:pointer; z-index: 2147483647; border: 2px solid #444;
          }
          #sora-launcher-button:hover{ background:#151515; }
          #sora-launcher-border{ position:absolute; inset:2px; border-radius:50%; }
  
          #sora-downloader-panel{
            position: fixed; right: 18px; bottom: 18px; width: 560px; max-height: 74vh;
            display:none; flex-direction:column; gap:12px; background:#1e1e1e; color:#eee;
            border:1px solid #444; border-radius:12px; padding:12px; z-index: 2147483647; overflow: hidden;
            font: 13px/1.45 ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Cantarell, Noto Sans, Helvetica, Arial, "Apple Color Emoji","Segoe UI Emoji";
            min-width: 0;
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
  
          #sora-app-view{ display:flex; flex-direction:column; gap:10px; width:100%; min-width:0; }
          #sora-status{ font-size:13px; color:#bbb; }
  
          #sora-result-textarea{
            display:block; width:100%; max-width:100%;
            height: 200px; max-height: calc(70vh - 260px);
            background:#0b0b0b; color:#b8ffb8;
            font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
            border:1px solid #333; border-radius:10px; padding:10px; white-space:pre;
            overflow-x:auto; overflow-y:auto;
          }
          #sora-result-textarea::-webkit-scrollbar{ width:10px; height:10px; }
          #sora-result-textarea::-webkit-scrollbar-track{ background:#0b0b0b; border-radius:8px; }
          #sora-result-textarea::-webkit-scrollbar-thumb{ background:#3a3a3a; border-radius:8px; border:2px solid #0b0b0b; }
          #sora-result-textarea::-webkit-scrollbar-thumb:hover{ background:#4a4a4a; }
  
          .sora-row{ display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
          .sora-btn{ background:#0d6efd; color:#fff; border:none; padding:8px 12px; border-radius:8px; cursor:pointer; }
          .sora-btn.secondary{ background:#2c2c2c; color:#ddd; border:1px solid #444; }
          .sora-btn.danger{ background:#a33; }
          .sora-btn:disabled{ opacity:0.6; cursor:not-allowed; }
  
          #sora-settings-panel{
            position: absolute; inset: 12px; background: #1a1a1a; border:1px solid #333; border-radius:10px; padding:10px; display:none;
            overflow-y:auto; overflow-x:hidden; -webkit-overflow-scrolling: touch; min-width:0;
          }
          #sora-settings-panel::-webkit-scrollbar{ width:12px; height:12px; }
          #sora-settings-panel::-webkit-scrollbar-track{ background:#181818; border-radius:10px; }
          #sora-settings-panel::-webkit-scrollbar-thumb{ background:#3a3a3a; border-radius:10px; border:2px solid #1a1a1a; }
          #sora-settings-panel::-webkit-scrollbar-thumb:hover{ background:#4a4a4a; }
  
          .sora-settings-content{ display:flex; flex-direction:column; gap:12px; max-width:100%; min-width:0; }
          #sora-settings-header{ display:flex; align-items:center; justify-content:space-between; }
  
          .sora-row-compact{ display:flex; align-items:center; justify-content:space-between; gap:12px; }
          .sora-row-compact > label{ color:#ccc; }
  
          .sora-row-block{ display:flex; flex-direction:column; align-items:flex-start; gap:8px; padding-top:4px; }
          .sora-setting-group{ border-top:1px solid #333; padding-top:10px; margin-top:6px; }
          .sora-setting-inactive{ opacity:0.5; pointer-events:none; }
          .sora-subnote{ font-size:12px; color:#9aa; margin-top:2px; }
  
          input[type="number"], select{
            background:#111; color:#eee; border:1px solid #444; border-radius:6px; padding:6px; min-width: 120px;
          }
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
              <button id="sora-stop-button" class="sora-btn danger" style="display:none;">Stop</button>
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
  
              <!-- Compact rows -->
              <div class="sora-row-compact sora-setting-group">
                <label>Download Mode:</label>
                <div>
                  <label style="margin-right:16px;">
                    <input type="radio" id="sora-mode-final" name="sora-download-mode" value="final"> Final Quality (no watermark)
                  </label>
                  <label>
                    <input type="radio" id="sora-mode-fast" name="sora-download-mode" value="fast"> Fast Download (with watermark)
                  </label>
                </div>
              </div>
  
              <div id="sora-fast-quality-container" class="sora-row-compact">
                <label for="sora-fast-quality-select">Fast Quality:</label>
                <select id="sora-fast-quality-select">
                  <option value="source">Source (HD)</option>
                  <option value="md">Medium</option>
                  <option value="ld">Low</option>
                </select>
              </div>
  
              <div id="sora-parallel-container" class="sora-row-compact">
                <label for="sora-parallel-input">Parallel RAW requests:</label>
                <input type="number" id="sora-parallel-input" min="1" max="20">
              </div>
  
              <div class="sora-row-compact" id="sora-limit-row">
                <label for="sora-limit-input">List limit (max 100):</label>
                <input type="number" id="sora-limit-input" min="1" max="100">
              </div>
  
              <div class="sora-row-compact">
                <label for="sora-dryrun-checkbox">Dry-run (comment out curls)</label>
                <input type="checkbox" id="sora-dryrun-checkbox">
              </div>
  
              <!-- Direct (block layout) -->
              <div class="sora-row-block sora-setting-group">
                <label>Direct download (small batches)</label>
                <label><input type="checkbox" id="sora-direct-checkbox"> Enable</label>
              </div>
  
              <div class="sora-row-block">
                <label for="sora-direct-max">Max tasks</label>
                <input type="number" id="sora-direct-max" min="1" max="100">
                <div class="sora-subnote">Each task can yield up to 4 videos. Example: 5 tasks ≈ up to 20 downloads.</div>
              </div>
  
              <div class="sora-row-block">
                <label for="sora-direct-parallel">Parallel (browser downloads)</label>
                <input type="number" id="sora-direct-parallel" min="1" max="6">
              </div>
  
              <div class="sora-row-block">
                <label for="sora-direct-saveas">Save As prompt for each file (Direct)</label>
                <input type="checkbox" id="sora-direct-saveas">
              </div>
  
              <div class="sora-row-block">
                <label for="sora-direct-zip">Zip into single file (.zip)</label>
                <input type="checkbox" id="sora-direct-zip">
                <div class="sora-subnote">No picker up front. Files are downloaded first, then zipped, then a single Save As appears.</div>
              </div>
  
              <button id="sora-settings-save-button" class="sora-btn" style="margin-top:6px;">Save & Close</button>
            </div>
          </div>
        </div>
      `;

        // ---- bind
        const ui = {};
        ui.root = root;
        ui.launcher = root.getElementById('sora-launcher-button');
        ui.launcherBorder = root.getElementById('sora-launcher-border');
        ui.panel = root.getElementById('sora-downloader-panel');
        ui.noTokenView = root.getElementById('sora-no-token-view');
        ui.appView = root.getElementById('sora-app-view');
        ui.settingsBtn = root.getElementById('sora-settings-button');
        ui.closeBtn = root.getElementById('sora-close-button');
        ui.runBtn = root.getElementById('sora-run-button');
        ui.stopBtn = root.getElementById('sora-stop-button');
        ui.statusDiv = root.getElementById('sora-status');
        ui.resultTA = root.getElementById('sora-result-textarea');
        ui.copyBtn = root.getElementById('sora-copy-button');
        ui.exportBtn = root.getElementById('sora-export-manifest-btn');

        ui.settingsPanel = root.getElementById('sora-settings-panel');
        ui.settingsClose = root.getElementById('sora-settings-close-button');
        ui.settingsSave = root.getElementById('sora-settings-save-button');
        ui.modeFinalRadio = root.getElementById('sora-mode-final');
        ui.modeFastRadio = root.getElementById('sora-mode-fast');
        ui.fastQualitySel = root.getElementById('sora-fast-quality-select');
        ui.parallelInput = root.getElementById('sora-parallel-input');
        ui.limitRow = root.getElementById('sora-limit-row');
        ui.limitInput = root.getElementById('sora-limit-input');
        ui.dryRunCheckbox = root.getElementById('sora-dryrun-checkbox');
        ui.fastQualityContainer = root.getElementById('sora-fast-quality-container');
        ui.parallelContainer = root.getElementById('sora-parallel-container');

        const chkDirect = root.getElementById('sora-direct-checkbox');
        const inpDirectMaxTasks = root.getElementById('sora-direct-max');
        const inpDirectParallel = root.getElementById('sora-direct-parallel');
        const chkDirectSaveAs = root.getElementById('sora-direct-saveas');
        const chkDirectZip = root.getElementById('sora-direct-zip');

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
            if (!userCapabilities.can_download_without_watermark) {
                ui.modeFinalRadio.disabled = true;
                currentSettings.fastDownload = true;
            } else { ui.modeFinalRadio.disabled = false; }
            populateSettingsPanel();
            updateRunButtonLabel();
        }

        function populateSettingsPanel() {
            ui.parallelInput.value = currentSettings.workers;
            ui.modeFinalRadio.checked = !currentSettings.fastDownload;
            ui.modeFastRadio.checked = currentSettings.fastDownload;
            ui.fastQualitySel.value = currentSettings.fastDownloadQuality;
            ui.limitInput.value = currentSettings.limit;
            ui.dryRunCheckbox.checked = currentSettings.dryRun;

            chkDirect.checked = currentSettings.directDownload;
            inpDirectMaxTasks.value = currentSettings.directMaxTasks;
            inpDirectParallel.value = currentSettings.directParallel;
            chkDirectSaveAs.checked = currentSettings.directSaveAs;
            chkDirectZip.checked = currentSettings.directZip;

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
            if (!currentSettings.directDownload) ui.runBtn.textContent = 'Generate Download Script';
            else ui.runBtn.textContent = currentSettings.directZip ? 'Zip & Download' : 'Direct Download';
            ui.stopBtn.style.display = directRunning ? 'inline-block' : 'none';
        }

        ui.modeFinalRadio?.addEventListener('change', () => toggleSettingsInteractivity(false));
        ui.modeFastRadio?.addEventListener('change', () => toggleSettingsInteractivity(true));
        chkDirect.addEventListener('change', () => {
            applyDirectDisable(chkDirect.checked);
            currentSettings.directDownload = chkDirect.checked;
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
            currentSettings.directSaveAs = !!chkDirectSaveAs.checked;
            currentSettings.directZip = !!chkDirectZip.checked;

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

        // Stop : annule direct (background) ou l’étape courante (via AbortController local)
        let currentAbort = null;
        ui.stopBtn.addEventListener('click', async () => {
            try { await send(API.cancelDirect()); } catch { }
            try { currentAbort?.abort(); } catch { }
            directRunning = false; updateRunButtonLabel();
        });

        // Export manifest (identique)
        let lastManifest = { rows: [], skipped: [], failures: [], mode: 'final', quality: 'source' };
        ui.exportBtn.addEventListener('click', () => {
            if ((!lastManifest.rows?.length) && (!lastManifest.skipped?.length) && (!lastManifest.failures?.length)) {
                alert('Nothing to export yet.'); return;
            }
            const ts = new Date().toISOString().replace(/[:\-]|\.\d{3}Z/g, '').slice(0, 15);
            const csvHeader = ['id', 'filename', 'url', 'mode', 'quality'];
            const toCSV = (v) => `"${String(v ?? '').replaceAll('"', '""')}"`;
            const csvRows = [csvHeader.join(',')].concat(lastManifest.rows.map(r =>
                [r.id, toCSV(r.filename), toCSV(r.url), lastManifest.mode, lastManifest.quality].join(',')
            ));
            triggerDownload(new Blob([csvRows.join('\n')], { type: 'text/csv' }), `sora_manifest_${ts}.csv`);
            triggerDownload(new Blob([JSON.stringify(lastManifest, null, 2)], { type: 'application/json' }), `sora_manifest_${ts}.json`);
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
                        const { successes, failures: f } = await fetchRawWithConcurrency(ids, currentSettings.workers, (t, p) => updateProgressUI(t, p));
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

                        if (currentSettings.directZip) {
                            // Phase A — DL vers OPFS (inchangé si tu as déjà ce code)
                            ui.statusDiv.textContent = `Downloading ${rows.length} file(s) locally…`;
                            const acDL = new AbortController(); currentAbort = acDL;
                            const { root, dir, dirName, metas } = await downloadAllToOPFS({
                                items: rows.map(r => ({ url: r.url, filename: r.filename })),
                                signal: acDL.signal,
                                onStatus: ({ phase, file, index, total }) => {
                                    if (phase === 'dl-progress') ui.statusDiv.textContent = `Downloading ${index}/${total}: ${file}…`;
                                    if (phase === 'dl-file-done') ui.statusDiv.textContent = `Downloaded ${index}/${total}: ${file}`;
                                }
                            });

                            // Phase B — ZIP dans OPFS (aucun picker ici)
                            const acZIP = new AbortController(); currentAbort = acZIP;
                            ui.statusDiv.textContent = `Preparing ZIP…`;
                            const zipName = `${dirName}.zip`;
                            const zipHandle = await dir.getFileHandle(zipName, { create: true });

                            await writeZipFromOPFS({
                                metas,
                                saveHandle: zipHandle,
                                signal: acZIP.signal,
                                onStatus: ({ phase, file, done, total }) => {
                                    if (phase === 'zip-progress') ui.statusDiv.textContent = `Zipping: ${file}…`;
                                    if (phase === 'zip-file-done') ui.statusDiv.textContent = `Zipped ${done}/${total}: ${file}`;
                                    if (phase === 'zip-done') ui.statusDiv.textContent = `ZIP completed (${metas.length} files).`;
                                    if (phase === 'cancel_done') ui.statusDiv.textContent = `ZIP canceled.`;
                                }
                            });

                            // Phase C — Déclenchement d'un download du ZIP (1 seul "Save As" via réglage Chrome)
                            const zipFile = await zipHandle.getFile();
                            const url = URL.createObjectURL(zipFile);
                            const a = document.createElement('a');
                            a.href = url;
                            a.download = zipName;              // -> apparait dans la liste des téléchargements
                            ui.root.appendChild(a);
                            a.click();
                            setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 2000);

                            // Cleanup OPFS (best-effort)
                            try { await opfsRemoveDir(root, dirName); } catch { }

                            currentAbort = null;
                            directRunning = false; updateRunButtonLabel();
                        } else {
                            // Direct chrome.downloads (petits batchs)
                            ui.statusDiv.textContent = `Direct: starting downloads for ${validTasksCount} task(s) (parallel ${currentSettings.directParallel})…`;
                            await send(API.startDirect(
                                rows.map(r => ({ url: r.url, filename: r.filename })),
                                currentSettings.directParallel,
                                currentSettings.directSaveAs
                            ));
                        }
                    }

                    // Toujours générer le script en fallback
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
                updateRunButtonLabel();
                ui.launcher.title = 'Open Sora Batch Downloader';
                ui.launcherBorder.style.animation = '';
                ui.launcherBorder.style.backgroundImage = '';
                ui.launcherBorder.style.border = '2px solid #444';
                currentAbort = null;
            }
        });

        // Direct progress (background)
        chrome.runtime.onMessage.addListener((msg) => {
            if (msg?.type !== 'DIRECT_PROGRESS') return;
            const { phase } = msg;
            if (phase === 'start') ui.statusDiv.textContent = `Direct: queued ${msg.total} item(s)…`;
            else if (phase === 'progress') {
                const p = msg.totalBytes ? Math.round((msg.bytesReceived / msg.totalBytes) * 100) : null;
                ui.statusDiv.textContent = `Direct: downloading ${msg.file}${p != null ? ' (' + p + '%)' : ''}`;
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

    // ---------- helpers (communs) ----------
    function clampInt(v, min, max, fallback) {
        const n = parseInt(v, 10);
        if (Number.isFinite(n)) return Math.min(Math.max(n, min), max);
        return fallback;
    }

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
        return String(s || '').normalize('NFKD').replace(/[\/\\?%*:|"<>]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120);
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
            blocks.push(`${cmdPrefix}curl -L -C - --fail --retry 5 --retry-delay 2 -o "${fname}" "${row.url.replace(/"/g, '\\"')}"`);
        }
        blocks.push(``, `echo "Download completed!"`);
        return [...hdr, ...blocks].join('\n');
    }
})();
