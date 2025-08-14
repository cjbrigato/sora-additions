// Minimal network worker. Stores token in-memory (never persisted).
let bearer = null;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case 'SET_TOKEN':
          bearer = msg.token; sendResponse({ ok: true }); return;

        case 'FETCH_PARAMS':
          ensureToken();
          sendResponse({ ok: true, json: await doFetch('https://sora.chatgpt.com/backend/parameters') });
          return;

        case 'FETCH_LIST':
          ensureToken();
          sendResponse({ ok: true, json: await doFetch(`https://sora.chatgpt.com/backend/video_gen?limit=${msg.limit}&task_type_filters=videos`) });
          return;

        case 'FETCH_RAW_ONE':
          ensureToken();
          try {
            const url = await fetchRawWithRetry(msg.id, 1);
            sendResponse({ ok: true, url });
          } catch (e) {
            sendResponse({ ok: false, error: String(e?.message || e) });
          }
          return;

        default:
          sendResponse({ ok: false, error: 'Unknown message type' });
          return;
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
  })();
  return true; // async response
});

function ensureToken() {
  if (!bearer) throw new Error('No token captured yet');
}

async function doFetch(url) {
  const r = await fetch(url, { headers: { authorization: `Bearer ${bearer}` } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return await r.json();
}

async function fetchRawWithRetry(id, attempt = 1) {
  try {
    const r = await fetch(`https://sora.chatgpt.com/backend/generations/${id}/raw`, {
      headers: { authorization: `Bearer ${bearer}` }
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    if (!j?.url) throw new Error('URL field missing');
    return j.url;
  } catch (e) {
    if (attempt >= 5) throw e;
    const backoff = (2 ** (attempt - 1)) * 1000 + Math.random() * 300;
    await new Promise(res => setTimeout(res, backoff));
    return fetchRawWithRetry(id, attempt + 1);
  }
}
