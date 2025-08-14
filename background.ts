// @ts-nocheck
// background.js — v0.5.2

// ---------- API constants ----------
const API = {
    BASE: 'https://sora.chatgpt.com/backend',
    PARAMS() { return `${this.BASE}/parameters`; },
    LIST(limit) { return `${this.BASE}/video_gen?limit=${limit}&task_type_filters=videos`; },
    RAW(id) { return `${this.BASE}/generations/${id}/raw`; }
  };
  
  const NET = { MAX_ATTEMPTS: 5 };
  const DIRECT = { DEFAULT_PARALLEL: 3 };
  
  let bearer = null; // transient; mirrored in chrome.storage.session
  
  // Direct download batch state
  let currentBatch = null; // { tabId, queue:[{url,filename}], active, max, done, total, idMap, saveAs, cancelling }
  
  // ---------- Messaging from content ----------
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    (async () => {
      try {
        switch (msg.type) {
          case 'SET_TOKEN': {
            bearer = msg.token;
            try { await chrome.storage.session.set({ bearer }); } catch {}
            sendResponse({ ok: true });
            return;
          }
  
          case 'FETCH_PARAMS': {
            await ensureBearer();
            sendResponse({ ok: true, json: await doFetch(API.PARAMS()) });
            return;
          }
  
          case 'FETCH_LIST': {
            await ensureBearer();
            sendResponse({ ok: true, json: await doFetch(API.LIST(msg.limit)) });
            return;
          }
  
          case 'FETCH_RAW_ONE': {
            await ensureBearer();
            try {
              const url = await fetchRawWithRetry(msg.id, 1);
              sendResponse({ ok: true, url });
            } catch (e) {
              sendResponse({ ok: false, error: String(e?.message || e) });
            }
            return;
          }
  
          case 'START_DIRECT_DOWNLOAD': {
            const tabId = sender?.tab?.id;
            startDirect(tabId, msg.items || [], Math.max(1, msg.parallel | 0) || DIRECT.DEFAULT_PARALLEL, !!msg.saveAs);
            sendResponse({ ok: true, total: (msg.items || []).length });
            return;
          }
  
          case 'CANCEL_DIRECT_DOWNLOAD': {
            cancelDirect();
            sendResponse({ ok: true });
            return;
          }
  
          default:
            sendResponse({ ok: false, error: 'Unknown message type' });
            return;
        }
      } catch (e) {
        sendResponse({ ok: false, error: String(e?.message || e) });
      }
    })();
    return true; // async
  });
  
  // ---------- Helpers ----------
  async function ensureBearer() {
    if (bearer) return;
    try {
      const { bearer: b } = await chrome.storage.session.get('bearer');
      if (b) bearer = b;
    } catch {}
    if (!bearer) throw new Error('No token captured yet');
  }
  
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
  
  // ---------- Direct download queue ----------
  function startDirect(tabId, items, parallel, saveAs) {
    if (!tabId || !items.length) return;
  
    currentBatch = {
      tabId,
      queue: items.slice(),
      active: 0,
      max: parallel,
      done: 0,
      total: items.length,
      idMap: new Map(),
      saveAs: !!saveAs,
      cancelling: false
    };
  
    pushDirect({ phase: 'start', done: 0, total: currentBatch.total });
    while (currentBatch.active < currentBatch.max) dequeueNext();
  }
  
  function cancelDirect() {
    if (!currentBatch) return;
    currentBatch.cancelling = true;
    currentBatch.queue.length = 0;
    pushDirect({ phase: 'cancel_start' });
  
    for (const dlId of Array.from(currentBatch.idMap.keys())) {
      try { chrome.downloads.cancel(dlId); } catch {}
    }
  }
  
  function dequeueNext() {
    if (!currentBatch) return;
    if (!currentBatch.queue.length) {
      if (currentBatch.active === 0) {
        pushDirect({ phase: currentBatch.cancelling ? 'cancel_done' : 'done', done: currentBatch.done, total: currentBatch.total });
        currentBatch = null;
      }
      return;
    }
  
    const item = currentBatch.queue.shift();
    currentBatch.active += 1;
  
    chrome.downloads.download(
      { url: item.url, filename: item.filename, conflictAction: 'uniquify', saveAs: currentBatch.saveAs },
      (dlId) => {
        if (!dlId) {
          currentBatch.active -= 1;
          pushDirect({ phase: 'item', state: 'interrupted', file: item.filename });
          dequeueNext();
          return;
        }
        currentBatch.idMap.set(dlId, item.filename);
      }
    );
  }
  
  chrome.downloads.onChanged.addListener((delta) => {
    if (!currentBatch) return;
    const file = currentBatch.idMap.get(delta.id);
    if (!file) return;
  
    if (delta.state && delta.state.current === 'complete') {
      currentBatch.done += 1;
      currentBatch.active -= 1;
      currentBatch.idMap.delete(delta.id);
      pushDirect({ phase: 'item', state: 'complete', file, done: currentBatch.done, total: currentBatch.total });
      dequeueNext();
    } else if (delta.state && delta.state.current === 'interrupted') {
      currentBatch.active -= 1;
      currentBatch.idMap.delete(delta.id);
      pushDirect({ phase: 'item', state: 'interrupted', file });
      dequeueNext();
    } else if (delta.bytesReceived || delta.totalBytes) {
      pushDirect({
        phase: 'progress',
        file,
        bytesReceived: delta.bytesReceived?.current,
        totalBytes: delta.totalBytes?.current
      });
    }
  });
  
  function pushDirect(payload) {
    if (!currentBatch) return;
    chrome.tabs.sendMessage(currentBatch.tabId, { type: 'DIRECT_PROGRESS', ...payload });
  }
  