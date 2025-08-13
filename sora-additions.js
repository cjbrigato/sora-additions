// ==UserScript==
// @name         Sora - Downloader
// @namespace    http://tampermonkey.net/
// @version      1.8 (The Informant)
// @description  An interface with a visual progress indicator on the launcher button. Perfect. 🤌
// @author       Gemini & Colin J. Brigato
// @match        https://sora.chatgpt.com/*
// @grant        GM_addStyle
// @grant        GM_setClipboard
// @grant        unsafeWindow
// @run-at       document-start
// @connect      sora.chatgpt.com
// ==/UserScript==

(function() {
    'use strict';

    let SORA_BEARER_TOKEN = null;

    const originalFetch = unsafeWindow.fetch;
    unsafeWindow.fetch = async function(...args) { const [url, options] = args; if (options && options.headers && options.headers.Authorization && typeof options.headers.Authorization === 'string' && options.headers.Authorization.startsWith('Bearer ')) { if (!SORA_BEARER_TOKEN) { SORA_BEARER_TOKEN = options.headers.Authorization.replace('Bearer ', ''); console.log('Sora Downloader: Bearer Token Intercepted successfully !'); } } return originalFetch.apply(this, args); };

    window.addEventListener('load', function() {

        const launcherButton = document.createElement('div');
        launcherButton.id = 'sora-launcher-button';
        launcherButton.innerHTML = '&#x1F4E5;';
        launcherButton.title = 'Open Sora Downloader';
        document.body.appendChild(launcherButton);

        const panel = document.createElement('div');
        panel.id = 'sora-downloader-panel';
        panel.style.display = 'none';
        document.body.appendChild(panel);

        const closeButton = document.createElement('div'); closeButton.id = 'sora-close-button'; closeButton.innerHTML = '&times;'; closeButton.title = 'Fermer'; panel.appendChild(closeButton);
        const title = document.createElement('h3'); title.textContent = 'Sora Batch Downloader'; panel.appendChild(title);
        const parallelContainer = document.createElement('div'); parallelContainer.id = 'sora-parallel-container'; const parallelLabel = document.createElement('label'); parallelLabel.textContent = 'Parallel requests :'; parallelLabel.setAttribute('for', 'sora-parallel-input'); const parallelInput = document.createElement('input'); parallelInput.type = 'number'; parallelInput.id = 'sora-parallel-input'; parallelInput.value = 8; parallelInput.min = 1; parallelInput.max = 20; parallelContainer.appendChild(parallelLabel); parallelContainer.appendChild(parallelInput); panel.appendChild(parallelContainer);
        const runButton = document.createElement('button'); runButton.textContent = 'Generate download script'; panel.appendChild(runButton);
        const statusDiv = document.createElement('div'); statusDiv.id = 'sora-status'; statusDiv.textContent = 'Ready.'; panel.appendChild(statusDiv);
        const resultTextarea = document.createElement('textarea'); resultTextarea.id = 'sora-result-textarea'; resultTextarea.setAttribute('readonly', true); resultTextarea.placeholder = "The script to copy/paste into your terminal will appear here..."; panel.appendChild(resultTextarea);
        const copyButton = document.createElement('button'); copyButton.textContent = 'Copy script'; copyButton.id = 'sora-copy-button'; copyButton.style.display = 'none'; panel.appendChild(copyButton);

        GM_addStyle(`
            #sora-launcher-button {
                position: fixed; bottom: 20px; right: 20px; width: 50px; height: 50px;
                background-color: #3a86ff; color: white; border-radius: 50%;
                display: flex; align-items: center; justify-content: center;
                font-size: 24px; cursor: pointer; box-shadow: 0 4px 10px rgba(0,0,0,0.3);
                z-index: 9998; transition: transform 0.2s ease, background-image 0.1s linear;
            }
            #sora-launcher-button.sora-processing {
                animation: sora-spin 1.5s linear infinite;
            }
            /* ... le reste des styles est identique ... */
            #sora-downloader-panel { position: fixed; bottom: 20px; right: 20px; width: 450px; background-color: #1e1e1e; border: 1px solid #444; border-radius: 8px; padding: 20px; z-index: 9999; box-shadow: 0 4px 12px rgba(0,0,0,0.5); color: #e0e0e0; font-family: sans-serif; display: none; flex-direction: column; gap: 12px; }
            #sora-close-button { position: absolute; top: 8px; right: 12px; font-size: 28px; color: #888; cursor: pointer; line-height: 1; transition: color 0.2s; }
            #sora-close-button:hover { color: white; }
            #sora-parallel-container { display: flex; justify-content: space-between; align-items: center; }
            #sora-parallel-container label { font-size: 14px; }
            #sora-parallel-container input { width: 60px; background-color: #333; color: white; border: 1px solid #555; border-radius: 4px; padding: 5px; text-align: center; }
            #sora-downloader-panel button { padding: 10px; border-radius: 5px; border: none; cursor: pointer; background-color: #3a86ff; color: white; font-weight: bold; }
            #sora-downloader-panel button:disabled { background-color: #555; cursor: not-allowed; }
            #sora-status { font-style: italic; color: #aaa; text-align: center; min-height: 20px; }
            #sora-result-textarea { width: 100%; height: 200px; background-color: #111; color: #00ff00; border: 1px solid #444; border-radius: 4px; font-family: 'Courier New', monospace; font-size: 12px; resize: vertical; box-sizing: border-box; }
        `);

        launcherButton.addEventListener('click', () => { panel.style.display = 'flex'; launcherButton.style.display = 'none'; });
        closeButton.addEventListener('click', () => { panel.style.display = 'none'; launcherButton.style.display = 'flex'; });

        const fetchWithToken = (url, token) => fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
        const fetchGenerationIds = async (token, onProgress) => {
            onProgress('Step 1/3 : Fetching list...', -1);
            const response = await fetchWithToken('https://sora.chatgpt.com/backend/video_gen?limit=100&task_type_filters=videos', token);
            if (!response.ok) throw new Error(`API Error (list): ${response.status}`);
            const data = await response.json();
            const ids = data.task_responses.flatMap(task => task.generations ? task.generations.map(gen => gen.id) : []);
            onProgress(`${ids.length} generations found.`, -1);
            statusDiv.textContent = `${ids.length} generations found.`;
            return ids;
        };

        const fetchRawDownloadUrlsParallel = async (ids, token, concurrency, onProgress) => {
            const queue = [...ids]; const results = []; let processedCount = 0; const total = ids.length;
            const worker = async () => {
                while (queue.length > 0) {
                    const id = queue.shift();
                    try {  const response = await fetchWithToken(`https://sora.chatgpt.com/backend/generations/${id}/raw`, token); if(response.ok) { const data = await response.json(); if (data.url) results.push({ id, url: data.url }); } else { console.warn(`URL not found for ${id}. Status: ${response.status}`); } }
                    catch (e) { console.warn(`Network error for ${id}:`, e.message); }
                    finally {
                        processedCount++;
                        const percent = total > 0 ? (processedCount / total) * 100 : 0;
                        const statusText = `Step 2/3 : Fetching URLs (${processedCount}/${total})`;
                        statusDiv.textContent = statusText + '...';
                        onProgress(statusText, percent);
                    }
                }
            };
            const workers = Array(concurrency).fill(null).map(() => worker()); await Promise.all(workers);
            results.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id)); return results;
        };

        const generateWgetScript = (downloadInfo, onProgress) => {
            onProgress('Step 3/3 : Generating script...', 100);
            statusDiv.textContent = 'Step 3/3 : Generating final script...';
            if (downloadInfo.length === 0) return "# No video to download found."; const header = `#!/bin/bash\n# Download script for ${downloadInfo.length} Sora videos\n\necho "Starting download of ${downloadInfo.length} videos..."\n\n`; const commands = downloadInfo.map(({ id, url }) => `wget -c -O "sora_${id}.mp4" "${url.replace(/"/g, '\\"')}"`).join('\n'); return header + commands + `\n\necho "Download completed !"`;
        };

        runButton.addEventListener('click', async () => {
            if (!SORA_BEARER_TOKEN) {  return; }

            const updateProgressUI = (statusText, percent) => {
                launcherButton.title = statusText;
                if (percent >= 0) {
                    launcherButton.style.backgroundImage = `conic-gradient(#0052cc ${percent}%, #3a86ff ${percent}%)`;
                }
            };

            // 2. Démarrage
            runButton.disabled = true;
            runButton.textContent = 'In progress...';
            launcherButton.classList.add('sora-processing');

            try {
                const parallelism = parseInt(document.getElementById('sora-parallel-input').value, 10) || 8;
                const ids = await fetchGenerationIds(SORA_BEARER_TOKEN, updateProgressUI);

                if (ids.length > 0) {
                    const downloadInfo = await fetchRawDownloadUrlsParallel(ids, SORA_BEARER_TOKEN, parallelism, updateProgressUI);
                    const scriptContent = generateWgetScript(downloadInfo, updateProgressUI);
                    resultTextarea.value = scriptContent;
                    statusDiv.textContent = `Done ! Script generated for ${downloadInfo.length} videos.`;
                    if (downloadInfo.length > 0) copyButton.style.display = 'block';
                } else {
                    statusDiv.textContent = 'No video generation found.';
                }
            } catch (error) { console.error("Error in Sora Downloader script:", error); statusDiv.textContent = `ERROR: ${error.message}`; resultTextarea.value = `An error occurred. Check the console (F12).\n\n${error.stack}`;
            } finally {
                runButton.disabled = false;
                runButton.textContent = 'Generate download script';
                launcherButton.classList.remove('sora-processing');
                launcherButton.style.backgroundImage = '';
                launcherButton.title = 'Open Sora Downloader';
            }
        });
        copyButton.addEventListener('click', () => { GM_setClipboard(resultTextarea.value); copyButton.textContent = 'Copied !'; setTimeout(() => { copyButton.textContent = 'Copy script'; }, 2000); });
    });
})();
