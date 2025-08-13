// ==UserScript==
// @name         Sora - Downloader
// @namespace    http://tampermonkey.net/
// @version      2.3 (The Gatekeeper)
// @description  A smart, adaptive interface for generating batch download scripts, aware of user rights.
// @author       Gemini & Colin J. Brigato
// @match        https://sora.chatgpt.com/*
// @grant        GM_addStyle
// @grant        GM_setClipboard
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @run-at       document-start
// @connect      sora.chatgpt.com
// ==/UserScript==

(function() {
    'use strict';

    // --- 1. Centralized Constants & Global State ---
    const API_BASE_URL = 'https://sora.chatgpt.com/backend';
    const API_LIST_URL = `${API_BASE_URL}/video_gen?limit=100&task_type_filters=videos`;
    const API_RAW_URL_TPL = `${API_BASE_URL}/generations/{id}/raw`;
    const API_PARAMS_URL = `${API_BASE_URL}/parameters`;

    let SORA_BEARER_TOKEN = null;
    let userCapabilities = { can_download_without_watermark: false };
    let isAppInitialized = false;

    const DEFAULT_SETTINGS = {
        workers: 8,
        fastDownload: false,
        fastDownloadQuality: 'source' // 'source', 'md', 'ld'
    };
    let currentSettings = {};

    // --- 2. Token Interceptor & App Initializer ---
    const originalFetch = unsafeWindow.fetch;
    const fetchWithToken = (url, token) => fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });

    unsafeWindow.fetch = async function(...args) {
        const [url, options] = args;
        if (!SORA_BEARER_TOKEN && options?.headers?.Authorization?.startsWith('Bearer ')) {
            SORA_BEARER_TOKEN = options.headers.Authorization.replace('Bearer ', '');
            console.log('Sora Downloader: Bearer Token Intercepted!');
            initializeApp();
        }
        return originalFetch.apply(this, args);
    };

    async function initializeApp() {
        if (isAppInitialized || !SORA_BEARER_TOKEN) return;
        try {
            const response = await fetchWithToken(API_PARAMS_URL, SORA_BEARER_TOKEN);
            if (!response.ok) throw new Error(`API Error (parameters): ${response.status}`);
            userCapabilities = await response.json();
            isAppInitialized = true;
            console.log('Sora Downloader: User capabilities loaded.', userCapabilities);
            const panel = document.getElementById('sora-downloader-panel');
            if (panel && panel.style.display !== 'none') {
                renderAppView();
            }
        } catch (error) {
            console.error('Sora Downloader: Failed to initialize app.', error);
            const statusDiv = document.querySelector('#sora-status');
            if(statusDiv) statusDiv.textContent = "Error loading user permissions.";
        }
    }

    window.addEventListener('load', async function() {

        await loadSettings();

        // --- UI Creation ---
        const launcherButton = document.createElement('div');
        launcherButton.id = 'sora-launcher-button';
        launcherButton.innerHTML = '&#x1F4E5;';
        launcherButton.title = 'Open Sora Downloader';
        document.body.appendChild(launcherButton);

        const mainPanel = document.createElement('div');
        mainPanel.id = 'sora-downloader-panel';
        mainPanel.innerHTML = `
            <div id="sora-panel-header">
                <button id="sora-settings-button" title="Settings" style="display: none;">&#x2699;&#xFE0F;</button>
                <h3>Sora Batch Downloader</h3>
                <div id="sora-close-button" title="Fermer">&times;</div>
            </div>

            <div id="sora-no-token-view">
                <div class="sora-spinner"></div>
                <p>Awaiting Token...</p>
                <p class="sora-subtext">Please browse the Sora site (e.g., view or create a video) to activate the downloader.</p>
            </div>

            <div id="sora-app-view" style="display: none; flex-direction: column; gap: 15px; width: 100%;">
                <button id="sora-run-button">Generate Download Script</button>
                <div id="sora-status">Ready.</div>
                <textarea id="sora-result-textarea" readonly placeholder="The script to copy/paste..."></textarea>
                <button id="sora-copy-button" style="display: none;">Copy Script</button>
            </div>

            <div id="sora-settings-panel" style="display: none;">
                <div class="sora-settings-content">
                    <div id="sora-settings-header">
                        <h4>Settings</h4>
                        <div id="sora-settings-close-button" title="Close Settings">&times;</div>
                    </div>
                     <div class="sora-setting-row sora-setting-group">
                        <label>Download Mode:</label>
                        <div id="sora-download-mode-selector">
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
                    <div id="sora-fast-quality-container" class="sora-setting-row" style="display:none;">
                        <label for="sora-fast-quality-select">Fast Download Quality:</label>
                        <select id="sora-fast-quality-select">
                            <option value="source">Source (HD)</option>
                            <option value="md">Medium</option>
                            <option value="ld">Low</option>
                        </select>
                    </div>
                    <div class="sora-setting-row">
                        <label for="sora-parallel-input">Parallel requests (Final Quality only):</label>
                        <input type="number" id="sora-parallel-input" min="1" max="20">
                    </div>
                    <button id="sora-settings-save-button">Save & Close</button>
                </div>
            </div>
        `;
        document.body.appendChild(mainPanel);

        // --- Get references ---
        const noTokenView = mainPanel.querySelector('#sora-no-token-view');
        const appView = mainPanel.querySelector('#sora-app-view');
        const settingsButton = mainPanel.querySelector('#sora-settings-button');
        const closeButton = mainPanel.querySelector('#sora-close-button');
        const runButton = mainPanel.querySelector('#sora-run-button');
        const statusDiv = mainPanel.querySelector('#sora-status');
        const resultTextarea = mainPanel.querySelector('#sora-result-textarea');
        const copyButton = mainPanel.querySelector('#sora-copy-button');
        const settingsPanel = mainPanel.querySelector('#sora-settings-panel');
        const settingsCloseButton = mainPanel.querySelector('#sora-settings-close-button');
        const settingsSaveButton = mainPanel.querySelector('#sora-settings-save-button');
        const parallelInput = mainPanel.querySelector('#sora-parallel-input');
        const modeFinalRadio = mainPanel.querySelector('#sora-mode-final');
        const modeFastRadio = mainPanel.querySelector('#sora-mode-fast');
        const fastQualityContainer = mainPanel.querySelector('#sora-fast-quality-container');
        const fastQualitySelect = mainPanel.querySelector('#sora-fast-quality-select');

        // --- Styles ---
        GM_addStyle(`
            #sora-launcher-button { position: fixed; bottom: 20px; right: 20px; width: 50px; height: 50px; background-color: #3a86ff; color: white; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 24px; cursor: pointer; box-shadow: 0 4px 10px rgba(0,0,0,0.3); z-index: 9998; transition: transform 0.2s ease, background-image 0.1s linear; }
            #sora-launcher-button.sora-processing { animation: sora-spin 1.5s linear infinite; }
            @keyframes sora-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
            #sora-downloader-panel { position: fixed; bottom: 20px; right: 20px; width: 450px; background-color: #1e1e1e; border: 1px solid #444; border-radius: 8px; padding: 20px; z-index: 9999; box-shadow: 0 4px 12px rgba(0,0,0,0.5); color: #e0e0e0; font-family: sans-serif; display: none; flex-direction: column; gap: 15px; align-items: center; }
            #sora-panel-header { display: flex; justify-content: space-between; align-items: center; width: 100%; }
            #sora-panel-header h3 { margin: 0; flex-grow: 1; text-align: center; }
            #sora-close-button, #sora-settings-button { font-size: 24px; color: #888; cursor: pointer; line-height: 1; transition: color 0.2s; background: none; border: none; padding: 0 5px; }
            #sora-close-button:hover, #sora-settings-button:hover { color: white; }
            #sora-no-token-view { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; min-height: 250px; text-align: center; }
            .sora-spinner { width: 40px; height: 40px; border: 4px solid #444; border-top-color: #3a86ff; border-radius: 50%; animation: sora-spin 1s linear infinite; }
            .sora-subtext { font-size: 12px; color: #888; max-width: 80%; }
            #sora-settings-panel { display: none; position: absolute; top: 0; left: 0; right: 0; bottom: 0; background-color: rgba(0,0,0,0.7); z-index: 10; backdrop-filter: blur(4px); align-items: center; justify-content: center; }
            .sora-settings-content { background-color: #2a2a2a; padding: 20px; border-radius: 8px; border: 1px solid #555; display: flex; flex-direction: column; gap: 18px; width: 90%; }
            #sora-settings-header { display: flex; justify-content: space-between; align-items: center; }
            #sora-settings-header h4 { margin: 0; font-size: 18px; }
            #sora-settings-close-button { font-size: 28px; color: #888; cursor: pointer; line-height: 1; transition: color 0.2s; }
            #sora-settings-close-button:hover { color: white; }
            .sora-setting-row { display: flex; justify-content: space-between; align-items: center; }
            .sora-setting-group { border-top: 1px solid #444; padding-top: 15px; }
            #sora-download-mode-selector { display: flex; flex-direction: column; align-items: flex-end; gap: 8px; }
            .sora-disabled-option { color: #777; cursor: not-allowed; }
            .sora-disabled-option label { cursor: not-allowed; }
            #sora-downloader-panel button { padding: 10px; border-radius: 5px; border: none; cursor: pointer; background-color: #3a86ff; color: white; font-weight: bold; width: 100%; }
            #sora-downloader-panel button:disabled { background-color: #555; cursor: not-allowed; }
            #sora-status { font-style: italic; color: #aaa; text-align: center; min-height: 20px; }
            #sora-result-textarea { width: 100%; height: 180px; background-color: #111; color: #00ff00; border: 1px solid #444; border-radius: 4px; font-family: 'Courier New', monospace; font-size: 12px; resize: vertical; box-sizing: border-box; }
        `);

        // --- View & State Management ---
        const renderNoTokenView = () => { noTokenView.style.display = 'flex'; appView.style.display = 'none'; settingsButton.style.display = 'none'; };
        const renderAppView = () => { noTokenView.style.display = 'none'; appView.style.display = 'flex'; settingsButton.style.display = 'initial'; updateSettingsUI(); };

        const updateSettingsUI = () => {
            const finalQualityOption = mainPanel.querySelector('#sora-final-quality-option');
            if (!userCapabilities.can_download_without_watermark) {
                finalQualityOption.title = "Your plan does not allow downloading without watermark.";
                modeFinalRadio.disabled = true;
                finalQualityOption.classList.add('sora-disabled-option');
                if (!currentSettings.fastDownload) { currentSettings.fastDownload = true; }
            } else {
                finalQualityOption.title = "";
                modeFinalRadio.disabled = false;
                finalQualityOption.classList.remove('sora-disabled-option');
            }
            populateSettingsPanel();
        };

        // --- Settings Logic ---
        async function loadSettings() { currentSettings = JSON.parse(await GM_getValue('soraDownloaderSettings', JSON.stringify(DEFAULT_SETTINGS))); currentSettings = { ...DEFAULT_SETTINGS, ...currentSettings }; }
        async function saveSettings() {
            currentSettings.workers = parseInt(parallelInput.value, 10) || DEFAULT_SETTINGS.workers;
            currentSettings.fastDownload = modeFastRadio.checked;
            currentSettings.fastDownloadQuality = fastQualitySelect.value;
            await GM_setValue('soraDownloaderSettings', JSON.stringify(currentSettings));
        }
        function populateSettingsPanel() {
            parallelInput.value = currentSettings.workers;
            modeFinalRadio.checked = !currentSettings.fastDownload;
            modeFastRadio.checked = currentSettings.fastDownload;
            fastQualitySelect.value = currentSettings.fastDownloadQuality;
            fastQualityContainer.style.display = currentSettings.fastDownload ? 'flex' : 'none';
        }
        mainPanel.querySelector('#sora-download-mode-selector').addEventListener('change', (e) => {
            if (e.target.name === 'sora-download-mode') {
                fastQualityContainer.style.display = e.target.value === 'fast' ? 'flex' : 'none';
            }
        });

        // --- Event Listeners ---
        launcherButton.addEventListener('click', () => { mainPanel.style.display = 'flex'; launcherButton.style.display = 'none'; isAppInitialized ? renderAppView() : renderNoTokenView(); });
        closeButton.addEventListener('click', () => { mainPanel.style.display = 'none'; launcherButton.style.display = 'flex'; });
        settingsButton.addEventListener('click', () => { populateSettingsPanel(); settingsPanel.style.display = 'flex'; });
        settingsCloseButton.addEventListener('click', () => { settingsPanel.style.display = 'none'; });
        settingsSaveButton.addEventListener('click', async () => { await saveSettings(); settingsPanel.style.display = 'none'; });
        copyButton.addEventListener('click', () => { GM_setClipboard(resultTextarea.value); copyButton.textContent = 'Copied!'; setTimeout(() => { copyButton.textContent = 'Copy Script'; }, 2000); });

        // --- Core Logic ---
        const fetchAndFilterGenerations = async (token, onProgress) => {
            onProgress('Step 1/3: Fetching & filtering list...', -1);
            const response = await fetchWithToken(API_LIST_URL, token);
            if (!response.ok) throw new Error(`API Error (list): ${response.status}`);
            const data = await response.json();

            const validGenerations = [];
            const skippedTasks = [];

            data.task_responses.forEach(task => {
                if (task.status !== 'succeeded') {
                    skippedTasks.push({ id: task.id, reason: task.failure_reason || 'Task failed' });
                    return;
                }
                if (!task.generations || task.generations.length === 0) {
                     if (task.moderation_result?.is_output_rejection) {
                        skippedTasks.push({ id: task.id, reason: 'Content policy rejection' });
                    }
                    return;
                }
                task.generations.forEach(gen => {
                    if (gen.encodings?.source?.path) {
                        validGenerations.push(gen);
                    } else {
                        skippedTasks.push({ id: gen.id, reason: 'Generation failed (missing video file)' });
                    }
                });
            });

            onProgress(`${validGenerations.length} valid generations found.`, -1);
            statusDiv.textContent = `${validGenerations.length} valid generations found.`;
            return { validGenerations, skippedTasks };
        };

        // --- Helper Functions (pasted for completeness) ---
        const fetchRawDownloadUrlsParallel = async (ids, token, concurrency, onProgress) => { const queue = [...ids]; const successes = []; const failures = []; let processedCount = 0; const total = ids.length; const worker = async () => { while (queue.length > 0) { const id = queue.shift(); try { const response = await fetchWithToken(API_RAW_URL_TPL.replace('{id}', id), token); if (response.ok) { const data = await response.json(); if (data.url) { successes.push({ id, url: data.url }); } else { failures.push({ id, reason: 'URL field missing' }); } } else { failures.push({ id, reason: `API Error ${response.status}` }); } } catch (e) { failures.push({ id, reason: `Network Error: ${e.message}` }); } finally { processedCount++; const percent = total > 0 ? (processedCount / total) * 100 : 0; const statusText = `Step 2/3: Fetching URLs (${processedCount}/${total})`; statusDiv.textContent = statusText + '...'; onProgress(statusText, percent); } } }; const workers = Array(concurrency).fill(null).map(() => worker()); await Promise.all(workers); successes.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id)); return { successes, failures }; };
        const generateDownloadScript = (downloadInfo, format, mode, quality, skipped, failures) => {
            statusDiv.textContent = 'Step 3/3: Generating final script...';
            let header = `#!/bin/bash\n# Download script for ${downloadInfo.length} Sora videos\n`;
            header += `# Mode: ${mode === 'fast' ? `Fast Download (Watermarked, ${quality} quality)` : 'Final Quality (No Watermark)'}\n`;
            header += `# Format: curl\n\n`;

            if (skipped.length > 0) {
                header += `# --- SKIPPED (pre-check) ---\n` + skipped.map(f => `# ${f.id}: ${f.reason}`).join('\n') + `\n\n`;
            }
            if (failures.length > 0) {
                 header += `# --- FAILED during URL fetch ---\n` + failures.map(f => `# ${f.id}: ${f.reason}`).join('\n') + `\n\n`;
            }

            if (downloadInfo.length === 0) return header + "# No videos to download.";

            header += `echo "Starting download of ${downloadInfo.length} videos..."\n\n`;
            const footer = `\n\necho "Download completed!"`;
            const commands = downloadInfo.map(({ id, url }) => `curl -L -C - -o "sora_${id}.mp4" "${url.replace(/"/g, '\\"')}"`).join('\n');
            return header + commands + footer;
        };

        runButton.addEventListener('click', async () => {
            const updateProgressUI = (statusText, percent) => { launcherButton.title = statusText; if (percent >= 0 && percent <= 100) { launcherButton.style.backgroundImage = `conic-gradient(#0052cc ${percent}%, #3a86ff ${percent}%)`; }};

            runButton.disabled = true; copyButton.style.display = 'none'; copyButton.textContent = 'Copy Script'; runButton.textContent = 'In progress...'; launcherButton.classList.add('sora-processing');

            try {
                const { validGenerations, skippedTasks } = await fetchAndFilterGenerations(SORA_BEARER_TOKEN, updateProgressUI);
                let downloadInfo = []; let networkFailures = [];

                if (validGenerations.length > 0) {
                    if (currentSettings.fastDownload) {
                        statusDiv.textContent = 'Step 2/3: Extracting URLs directly...';
                        updateProgressUI('Extracting URLs...', 50);
                        downloadInfo = validGenerations.map(gen => ({
                            id: gen.id,
                            url: gen.encodings[currentSettings.fastDownloadQuality]?.path || gen.url
                        }));
                        updateProgressUI('URLs extracted.', 100);
                    } else {
                        const ids = validGenerations.map(gen => gen.id);
                        const { successes, failures } = await fetchRawDownloadUrlsParallel(ids, SORA_BEARER_TOKEN, currentSettings.workers, updateProgressUI);
                        downloadInfo = successes;
                        networkFailures = failures;
                    }

                    const scriptContent = generateDownloadScript(downloadInfo, 'curl', currentSettings.fastDownload ? 'fast' : 'final', currentSettings.fastDownloadQuality, skippedTasks, networkFailures);
                    resultTextarea.value = scriptContent;

                    let finalStatus = `Done! Script for ${downloadInfo.length} videos.`;
                    const totalFailures = skippedTasks.length + networkFailures.length;
                    if (totalFailures > 0) finalStatus += ` (${totalFailures} skipped).`;
                    statusDiv.textContent = finalStatus;

                    if (downloadInfo.length > 0) copyButton.style.display = 'block';

                } else {
                    statusDiv.textContent = 'No valid video generations found.';
                    resultTextarea.value = `# No valid videos found.\n# Skipped tasks/generations:\n` + skippedTasks.map(f => `# - ${f.id}: ${f.reason}`).join('\n');
                }
            } catch (error) {
                console.error("Error in Sora Downloader script:", error);
                statusDiv.textContent = `ERROR: ${error.message}`;
                resultTextarea.value = `An error occurred. Check the console (F12).\n\n${error.stack}`;
            } finally {
                runButton.disabled = false; runButton.textContent = 'Generate Download Script';
                launcherButton.classList.remove('sora-processing'); launcherButton.style.backgroundImage = ''; launcherButton.title = 'Open Sora Downloader';
            }
        });


    });
})();