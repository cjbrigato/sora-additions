// --- API constants (centralized) ---
const API = {
    BASE: 'https://sora.chatgpt.com/backend',
    PARAMS() { return `${this.BASE}/parameters`; },
    LIST(limit) { return `${this.BASE}/video_gen?limit=${limit}&task_type_filters=videos`; },
    RAW(id) { return `${this.BASE}/generations/${id}/raw`; }
  };
  
  const NET = { MAX_ATTEMPTS: 5 };
  const DIRECT = { DEFAULT_PARALLEL: 3 };
  
  let bearer = null;
  
  // Minimal in-memory state for direct download batches
  let currentBatch = null; // { tabId, queue:[{url,filename}], active, max, done, total, map:dlId->idx }
  
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    (async () => {
      try {
        switch (msg.type) {
          case 'SET_TOKEN':
            bearer = msg.token; sendResponse({ ok: true }); return;
  
          case 'FETCH_PARAMS':
            ensureToken(); sendResponse({ ok: true, json: await doFetch(API.PARAMS()) }); return;
  
          case 'FETCH_LIST':
            ensureToken(); sendResponse({ ok: true, json: await doFetch(API.LIST(msg.limit)) }); return;
  
          case 'FETCH_RAW_ONE':
            ensureToken();
            try { sendResponse({ ok: true, url: await fetchRawWithRetry(msg.id, 1) }); }
            catch (e) { sendResponse({ ok: false, error: String(e?.message || e) }); }
            return;
  
          case 'START_DIRECT_DOWNLOAD':
            // items: [{url, filename}], parallel: number
            startDirect(sender?.tab?.id, msg.items || [], Math.max(1, msg.parallel | 0) || DIRECT.DEFAULT_PARALLEL);
            sendResponse({ ok: true, total: (msg.items || []).length });
            return;
  
          default:
            sendResponse({ ok: false, error: 'Unknown message type' }); return;
        }
      } catch (e) {
        sendResponse({ ok: false, error: String(e?.message || e) });
      }
    })();
    return true;
  });
  
  function ensureToken() { if (!bearer) throw new Error('No token captured yet'); }
  
  async function doFetch(url) {
    const r = await fetch(url, { headers: { authorization: `Bearer ${bearer}` } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  }
  
  async function fetchRawWithRetry(id, attempt = 1) {
    try {
      const r = await fetch(API.RAW(id), { headers: { authorization: `Bearer ${bearer}` } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      if (!j?.url) throw new Error('URL field missing');
      return j.url;
    } catch (e) {
      if (attempt >= NET.MAX_ATTEMPTS) throw e;
      const backoff = (2 ** (attempt - 1)) * 1000 + Math.random() * 300;
      await new Promise(res => setTimeout(res, backoff));
      return fetchRawWithRetry(id, attempt + 1);
    }
  }
  
  // ---------------- Direct download queue ----------------
  function startDirect(tabId, items, parallel) {
    if (!tabId || !items.length) return;
  
    currentBatch = {
      tabId,
      queue: items.slice(),
      active: 0,
      max: parallel,
      done: 0,
      total: items.length,
      idMap: new Map() // downloadId -> item index
    };
  
    // First progress push
    pushProgress({ phase: 'start', done: 0, total: currentBatch.total });
  
    while (currentBatch.active < currentBatch.max) dequeueNext();
  }
  
  function dequeueNext() {
    if (!currentBatch) return;
    if (!currentBatch.queue.length) {
      if (currentBatch.active === 0) {
        pushProgress({ phase: 'done', done: currentBatch.done, total: currentBatch.total });
        currentBatch = null;
      }
      return;
    }
    const item = currentBatch.queue.shift();
    currentBatch.active += 1;
  
    chrome.downloads.download(
      { url: item.url, filename: item.filename, conflictAction: 'uniquify' },
      (dlId) => {
        if (!dlId) {
          // immediate failure
          currentBatch.active -= 1;
          pushProgress({ phase: 'item', state: 'interrupted', file: item.filename });
          dequeueNext();
          return;
        }
        currentBatch.idMap.set(dlId, item.filename);
      }
    );
  }
  
  // Listen to progress
  chrome.downloads.onChanged.addListener((delta) => {
    if (!currentBatch) return;
    const file = currentBatch.idMap.get(delta.id);
    if (!file) return;
  
    if (delta.state && delta.state.current === 'complete') {
      currentBatch.done += 1;
      currentBatch.active -= 1;
      currentBatch.idMap.delete(delta.id);
      pushProgress({ phase: 'item', state: 'complete', file, done: currentBatch.done, total: currentBatch.total });
      dequeueNext();
    } else if (delta.state && delta.state.current === 'interrupted') {
      currentBatch.active -= 1;
      currentBatch.idMap.delete(delta.id);
      pushProgress({ phase: 'item', state: 'interrupted', file });
      dequeueNext();
    } else {
      // Optional fine-grained progress
      if (delta.bytesReceived || delta.totalBytes) {
        pushProgress({
          phase: 'progress',
          file,
          bytesReceived: delta.bytesReceived?.current,
          totalBytes: delta.totalBytes?.current
        });
      }
    }
  });
  
  function pushProgress(payload) {
    if (!currentBatch) return;
    chrome.tabs.sendMessage(currentBatch.tabId, { type: 'DIRECT_PROGRESS', ...payload });
  }
  