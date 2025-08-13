// ==UserScript==
// @name         Sora - Downloader
// @namespace    http://tampermonkey.net/
// @version      2.0 (The Configurator)
// @description  A robust interface with a persistent settings panel to generate batch download scripts.
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

    // --- 1. Centralized Constants & Settings ---
    const API_BASE_URL = 'https://sora.chatgpt.com/backend';
    const API_LIST_URL = `${API_BASE_URL}/video_gen?limit=100&task_type_filters=videos`;
    const API_RAW_URL_TPL = `${API_BASE_URL}/generations/{id}/raw`;
    let SORA_BEARER_TOKEN = null;

    const DEFAULT_SETTINGS = {
        workers: 8,
        useCurl: false,
        autoHide: false
    };
    let currentSettings = {};

    // --- Token Interceptor ---
    const originalFetch = unsafeWindow.fetch;
    unsafeWindow.fetch = async function(...args) {
        const [url, options] = args;
        if (options?.headers?.Authorization?.startsWith('Bearer ')) {
            if (!SORA_BEARER_TOKEN) {
                SORA_BEARER_TOKEN = options.headers.Authorization.replace('Bearer ', '');
                console.log('Sora Downloader: Bearer Token Intercepted successfully!');
            }
        }
        return originalFetch.apply(this, args);
    };

    window.addEventListener('load', async function() {

        // --- 2. Load Settings ---
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
                <button id="sora-settings-button" title="Settings">&#x2699;&#xFE0F;</button>
                <h3>Sora Batch Downloader</h3>
                <div id="sora-close-button" title="Fermer">&times;</div>
            </div>

            <button id="sora-run-button">Generate Download Script</button>
            <div id="sora-status">Ready.</div>
            <textarea id="sora-result-textarea" readonly placeholder="The script to copy/paste into your terminal will appear here..."></textarea>
            <button id="sora-copy-button" style="display: none;">Copy Script</button>

            <!-- 3. Settings Panel (initially hidden) -->
            <div id="sora-settings-panel" style="display: none;">
                <div class="sora-settings-content">
                    <div id="sora-settings-header">
                        <h4>Settings</h4>
                        <div id="sora-settings-close-button" title="Close Settings">&times;</div>
                    </div>
                    <div class="sora-setting-row">
                        <label for="sora-parallel-input">Parallel requests:</label>
                        <input type="number" id="sora-parallel-input" min="1" max="20">
                    </div>
                    <div class="sora-setting-row">
                        <label for="sora-use-curl-checkbox">Use <code>curl</code> for script (default: <code>wget</code>)</label>
                        <input type="checkbox" id="sora-use-curl-checkbox">
                    </div>
                    <div class="sora-setting-row">
                        <label for="sora-auto-hide-checkbox">Auto-hide panel during generation</label>
                        <input type="checkbox" id="sora-auto-hide-checkbox">
                    </div>
                    <button id="sora-settings-save-button">Save & Close</button>
                </div>
            </div>
        `;
        document.body.appendChild(mainPanel);

        // --- Get references to UI elements ---
        const closeButton = mainPanel.querySelector('#sora-close-button');
        const runButton = mainPanel.querySelector('#sora-run-button');
        const statusDiv = mainPanel.querySelector('#sora-status');
        const resultTextarea = mainPanel.querySelector('#sora-result-textarea');
        const copyButton = mainPanel.querySelector('#sora-copy-button');
        const settingsButton = mainPanel.querySelector('#sora-settings-button');
        const settingsPanel = mainPanel.querySelector('#sora-settings-panel');
        const settingsCloseButton = mainPanel.querySelector('#sora-settings-close-button');
        const settingsSaveButton = mainPanel.querySelector('#sora-settings-save-button');
        const parallelInput = mainPanel.querySelector('#sora-parallel-input');
        const useCurlCheckbox = mainPanel.querySelector('#sora-use-curl-checkbox');
        const autoHideCheckbox = mainPanel.querySelector('#sora-auto-hide-checkbox');

        // --- Add Styles ---
        GM_addStyle(`
            #sora-launcher-button { position: fixed; bottom: 20px; right: 20px; width: 50px; height: 50px; background-color: #3a86ff; color: white; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 24px; cursor: pointer; box-shadow: 0 4px 10px rgba(0,0,0,0.3); z-index: 9998; transition: transform 0.2s ease, background-image 0.1s linear; }
            #sora-launcher-button.sora-processing { animation: sora-spin 1.5s linear infinite; }
            @keyframes sora-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

            #sora-downloader-panel { position: fixed; bottom: 20px; right: 20px; width: 450px; background-color: #1e1e1e; border: 1px solid #444; border-radius: 8px; padding: 20px; z-index: 9999; box-shadow: 0 4px 12px rgba(0,0,0,0.5); color: #e0e0e0; font-family: sans-serif; display: none; flex-direction: column; gap: 15px; }
            #sora-panel-header { display: flex; justify-content: space-between; align-items: center; }
            #sora-panel-header h3 { margin: 0; flex-grow: 1; text-align: center; }
            #sora-close-button, #sora-settings-button { font-size: 24px; color: #888; cursor: pointer; line-height: 1; transition: color 0.2s; background: none; border: none; padding: 0 5px; }
            #sora-close-button:hover, #sora-settings-button:hover { color: white; }

            /* Settings Panel Styles */
            #sora-settings-panel { display: none; position: absolute; top: 0; left: 0; right: 0; bottom: 0; background-color: rgba(0,0,0,0.7); z-index: 10; backdrop-filter: blur(4px); align-items: center; justify-content: center; }
            .sora-settings-content { background-color: #2a2a2a; padding: 20px; border-radius: 8px; border: 1px solid #555; display: flex; flex-direction: column; gap: 18px; width: 85%; }
            #sora-settings-header { display: flex; justify-content: space-between; align-items: center; }
            #sora-settings-header h4 { margin: 0; font-size: 18px; }
            #sora-settings-close-button { font-size: 28px; color: #888; cursor: pointer; line-height: 1; transition: color 0.2s; }
            #sora-settings-close-button:hover { color: white; }
            .sora-setting-row { display: flex; justify-content: space-between; align-items: center; }
            .sora-setting-row label { font-size: 14px; }
            .sora-setting-row code { background-color: #444; padding: 2px 4px; border-radius: 3px; font-family: 'Courier New', monospace; }
            .sora-setting-row input[type="number"] { width: 60px; background-color: #333; color: white; border: 1px solid #555; border-radius: 4px; padding: 5px; text-align: center; }
            .sora-setting-row input[type="checkbox"] { transform: scale(1.3); }

            /* General Button Styles */
            #sora-downloader-panel button { padding: 10px; border-radius: 5px; border: none; cursor: pointer; background-color: #3a86ff; color: white; font-weight: bold; }
            #sora-downloader-panel button:disabled { background-color: #555; cursor: not-allowed; }
            #sora-status { font-style: italic; color: #aaa; text-align: center; min-height: 20px; }
            #sora-result-textarea { width: 100%; height: 180px; background-color: #111; color: #00ff00; border: 1px solid #444; border-radius: 4px; font-family: 'Courier New', monospace; font-size: 12px; resize: vertical; box-sizing: border-box; }
        `);

        // --- 4. Settings Logic ---
        async function loadSettings() {
            const savedSettings = await GM_getValue('soraDownloaderSettings', null);
            currentSettings = savedSettings ? JSON.parse(savedSettings) : { ...DEFAULT_SETTINGS };
            // Ensure all keys from default are present in case of script update
            currentSettings = { ...DEFAULT_SETTINGS, ...currentSettings };
        }

        async function saveSettings() {
            const newSettings = {
                workers: parseInt(parallelInput.value, 10) || DEFAULT_SETTINGS.workers,
                useCurl: useCurlCheckbox.checked,
                autoHide: autoHideCheckbox.checked
            };
            await GM_setValue('soraDownloaderSettings', JSON.stringify(newSettings));
            currentSettings = newSettings;
        }

        function populateSettingsPanel() {
            parallelInput.value = currentSettings.workers;
            useCurlCheckbox.checked = currentSettings.useCurl;
            autoHideCheckbox.checked = currentSettings.autoHide;
        }

        // --- Event Listeners ---
        launcherButton.addEventListener('click', () => { mainPanel.style.display = 'flex'; launcherButton.style.display = 'none'; });
        closeButton.addEventListener('click', () => { mainPanel.style.display = 'none'; launcherButton.style.display = 'flex'; });
        settingsButton.addEventListener('click', () => {
            populateSettingsPanel();
            settingsPanel.style.display = 'flex';
        });
        settingsCloseButton.addEventListener('click', () => { settingsPanel.style.display = 'none'; });
        settingsSaveButton.addEventListener('click', async () => {
            await saveSettings();
            settingsPanel.style.display = 'none';
        });
        copyButton.addEventListener('click', () => { GM_setClipboard(resultTextarea.value); copyButton.textContent = 'Copied!'; setTimeout(() => { copyButton.textContent = 'Copy Script'; }, 2000); });

        // --- Core Logic ---
        const fetchGenerationIds = async (token, onProgress) => { onProgress('Step 1/3: Fetching list...', -1); const response = await fetchWithToken(API_LIST_URL, token); if (!response.ok) throw new Error(`API Error (list): ${response.status}`); const data = await response.json(); const ids = data.task_responses.flatMap(task => task.generations ? task.generations.map(gen => gen.id) : []); onProgress(`${ids.length} generations found.`, -1); statusDiv.textContent = `${ids.length} generations found.`; return ids; };
        const fetchRawDownloadUrlsParallel = async (ids, token, concurrency, onProgress) => { const queue = [...ids]; const successes = []; const failures = []; let processedCount = 0; const total = ids.length; const worker = async () => { while (queue.length > 0) { const id = queue.shift(); try { const response = await fetchWithToken(API_RAW_URL_TPL.replace('{id}', id), token); if (response.ok) { const data = await response.json(); if (data.url) { successes.push({ id, url: data.url }); } else { failures.push({ id, reason: 'URL field missing' }); } } else { failures.push({ id, reason: `API Error ${response.status}` }); } } catch (e) { failures.push({ id, reason: `Network Error: ${e.message}` }); } finally { processedCount++; const percent = total > 0 ? (processedCount / total) * 100 : 0; const statusText = `Step 2/3: Fetching URLs (${processedCount}/${total})`; statusDiv.textContent = statusText + '...'; onProgress(statusText, percent); } } }; const workers = Array(concurrency).fill(null).map(() => worker()); await Promise.all(workers); successes.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id)); return { successes, failures }; };
        const generateDownloadScript = (downloadInfo, format) => { statusDiv.textContent = 'Step 3/3: Generating final script...'; if (downloadInfo.length === 0) return "# No videos to download found."; const header = `#!/bin/bash\n# Download script for ${downloadInfo.length} Sora videos\n# Format: ${format}\n\necho "Starting download of ${downloadInfo.length} videos..."\n\n`; const footer = `\n\necho "Download completed!"`; let commands; if (format === 'wget') { commands = downloadInfo.map(({ id, url }) => `wget -c -O "sora_${id}.mp4" "${url.replace(/"/g, '\\"')}"`).join('\n'); } else { commands = downloadInfo.map(({ id, url }) => `curl -L -C - -o "sora_${id}.mp4" "${url.replace(/"/g, '\\"')}"`).join('\n'); } return header + commands + footer; };
        const fetchWithToken = (url, token) => fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });


        runButton.addEventListener('click', async () => {
            if (!SORA_BEARER_TOKEN) { statusDiv.textContent = "Bearer Token not found. Browse Sora and try again."; return; }

            const updateProgressUI = (statusText, percent) => { launcherButton.title = statusText; if (percent >= 0 && percent <= 100) { launcherButton.style.backgroundImage = `conic-gradient(#0052cc ${percent}%, #3a86ff ${percent}%)`; }};

            runButton.disabled = true; copyButton.style.display = 'none'; copyButton.textContent = 'Copy Script'; runButton.textContent = 'In progress...';
            launcherButton.classList.add('sora-processing');

            if (currentSettings.autoHide) {
                mainPanel.style.display = 'none'; launcherButton.style.display = 'flex';
            }

            try {
                const parallelism = currentSettings.workers;
                const scriptFormat = currentSettings.useCurl ? 'curl' : 'wget';
                const ids = await fetchGenerationIds(SORA_BEARER_TOKEN, updateProgressUI);
                if (ids.length > 0) {
                    const { successes, failures } = await fetchRawDownloadUrlsParallel(ids, SORA_BEARER_TOKEN, parallelism, updateProgressUI);
                    let scriptContent = generateDownloadScript(successes, scriptFormat);
                    let finalStatus = `Done! Script for ${successes.length} videos generated.`;
                    if (failures.length > 0) {
                        const errorSummary = failures.map(f => `# FAILED: ID ${f.id} (${f.reason})`).join('\n');
                        scriptContent = `# --- WARNING: ${failures.length} URLs could not be retrieved ---\n${errorSummary}\n\n` + scriptContent;
                        finalStatus += ` (${failures.length} failed).`;
                        console.warn("Sora Downloader - Failed URLs:", failures);
                    }
                    resultTextarea.value = scriptContent;
                    statusDiv.textContent = finalStatus;
                    if (successes.length > 0) copyButton.style.display = 'block';
                } else { statusDiv.textContent = 'No video generation found.'; }
            } catch (error) {
                console.error("Error in Sora Downloader script:", error);
                statusDiv.textContent = `ERROR: ${error.message}`;
                resultTextarea.value = `An error occurred. Check the console (F12) for details.\n\n${error.stack}`;
            } finally {
                runButton.disabled = false; runButton.textContent = 'Generate Download Script';
                launcherButton.classList.remove('sora-processing'); launcherButton.style.backgroundImage = ''; launcherButton.title = 'Open Sora Downloader';
                if (currentSettings.autoHide) {
                    mainPanel.style.display = 'flex'; launcherButton.style.display = 'none';
                }
            }
        });


    });
})();