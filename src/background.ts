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

        case 'CANCEL_DIRECT_DOWNLOAD':
          //cancelDirect(); 
          sendResponse({ ok: true }); return;

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
