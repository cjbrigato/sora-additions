// background.ts — MV3 service worker
declare const chrome: any;

const API = {
  BASE: 'https://sora.chatgpt.com/backend',
  PARAMS() { return `${this.BASE}/parameters`; },
  LIST(limit: number, tasktype: string) { return `${this.BASE}/video_gen?limit=${limit}&task_type_filters=${tasktype}`; },
  RAW(id: string) { return `${this.BASE}/generations/${id}/raw`; }
};

const NET = { MAX_ATTEMPTS: 5 };

let bearer: string | null = null;

chrome.runtime.onMessage.addListener((msg: any, sender: any, sendResponse: any) => {
  (async () => {
    try {
      switch (msg?.type) {
        case 'SET_TOKEN':
          bearer = msg.token;
          try { await chrome.storage.session.set({ bearer }); } catch { }
          sendResponse({ ok: true }); return;

        case 'FETCH_PARAMS':
          await ensureBearer();
          sendResponse({ ok: true, json: await doFetch(API.PARAMS()) }); return;

        case 'FETCH_LIST':
          await ensureBearer();
          sendResponse({ ok: true, json: await doFetch(API.LIST(msg.limit, msg.tasktype)) }); return;

        case 'FETCH_RAW_ONE':
          await ensureBearer();
          try { sendResponse({ ok: true, url: await fetchRawWithRetry(msg.id, 1) }); }
          catch (e: any) { sendResponse({ ok: false, error: String(e?.message || e) }); }
          return;

        case 'START_DIRECT_DOWNLOAD':
          startDirect(sender?.tab?.id, msg.items || [], Math.max(1, msg.parallel | 0) || 3, !!msg.saveAs);
          sendResponse({ ok: true }); return;

        case 'CANCEL_DIRECT_DOWNLOAD':
          cancelDirect(); sendResponse({ ok: true }); return;

        default: sendResponse({ ok: false, error: 'Unknown message type' }); return;
      }
    } catch (e: any) { sendResponse({ ok: false, error: String(e?.message || e) }); }
  })();
  return true;
});

async function ensureBearer() {
  if (bearer) return;
  try { const o = await chrome.storage.session.get('bearer'); bearer = o?.bearer || null; } catch { }
  if (!bearer) throw new Error('No token captured yet');
}
async function doFetch(url: string) {
  const r = await fetch(url, { headers: { authorization: `Bearer ${bearer}` } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return await r.json();
}
async function fetchRawWithRetry(id: string, attempt: number): Promise<string> {
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

// --- chrome.downloads queue (for small direct batches) ---
type Item = { url: string; filename: string };
let batch: null | { tabId: number, queue: Item[], active: number, max: number, done: number, total: number, idMap: Map<number, string>, saveAs: boolean, cancelling: boolean } = null;

function startDirect(tabId: number, items: Item[], parallel: number, saveAs: boolean) {
  if (!tabId || !items.length) return;
  batch = { tabId, queue: items.slice(), active: 0, max: parallel, done: 0, total: items.length, idMap: new Map(), saveAs: !!saveAs, cancelling: false };
  push({ phase: 'start', total: batch.total });
  while (batch.active < batch.max) dequeueNext();
}
function cancelDirect() {
  if (!batch) return;
  batch.cancelling = true; batch.queue.length = 0; push({ phase: 'cancel_start' });
  for (const id of Array.from(batch.idMap.keys())) { try { chrome.downloads.cancel(id); } catch { } }
}
function dequeueNext() {
  if (!batch) return;
  if (!batch.queue.length) {
    if (batch.active === 0) { push({ phase: batch.cancelling ? 'cancel_done' : 'done', done: batch.done, total: batch.total }); batch = null; }
    return;
  }
  const item = batch.queue.shift()!;
  batch.active++;
  chrome.downloads.download({ url: item.url, filename: item.filename, conflictAction: 'uniquify', saveAs: batch.saveAs }, (dlId: number) => {
    if (!dlId) { batch!.active--; push({ phase: 'item', state: 'interrupted', file: item.filename }); dequeueNext(); return; }
    batch!.idMap.set(dlId, item.filename);
  });
}
chrome.downloads.onChanged.addListener((d: any) => {
  if (!batch) return;
  const file = batch.idMap.get(d.id);
  if (!file) return;

  if (d.state?.current === 'complete') {
    batch.done++; batch.active--; batch.idMap.delete(d.id);
    push({ phase: 'item', state: 'complete', file, done: batch.done, total: batch.total });
    dequeueNext();
  } else if (d.state?.current === 'interrupted') {
    batch.active--; batch.idMap.delete(d.id);
    push({ phase: 'item', state: 'interrupted', file });
    dequeueNext();
  } else if (d.bytesReceived || d.totalBytes) {
    push({ phase: 'progress', file, bytesReceived: d.bytesReceived?.current, totalBytes: d.totalBytes?.current });
  }
});
function push(payload: any) { if (!batch) return; chrome.tabs.sendMessage(batch.tabId, { type: 'DIRECT_PROGRESS', ...payload }); }
