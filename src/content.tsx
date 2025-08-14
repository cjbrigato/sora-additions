import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

// inject page hook
const script = document.createElement('script');
script.src = chrome.runtime.getURL('src/pageHook.ts');
(document.head || document.documentElement).appendChild(script);
script.onload = () => script.remove();

interface FetchListResponse {
  ok: boolean;
  json?: { tasks?: any[] };
}

const App: React.FC = () => {
  const [token, setToken] = useState<string | null>(null);
  const [items, setItems] = useState<any[]>([]);
  const [status, setStatus] = useState<string>('');

  useEffect(() => {
    const handler = (e: Event) => {
      const token = (e as CustomEvent<string>).detail;
      chrome.runtime.sendMessage({ type: 'SET_TOKEN', token });
      setToken(token);
    };
    window.addEventListener('sora-token', handler as EventListener);
    return () => window.removeEventListener('sora-token', handler as EventListener);
  }, []);

  const fetchList = async () => {
    setStatus('Loading...');
    const res = (await chrome.runtime.sendMessage({ type: 'FETCH_LIST', limit: 10 })) as FetchListResponse;
    setItems(res.json?.tasks || []);
    setStatus('');
  };

  return (
    <div style={{ position: 'fixed', top: 10, right: 10, background: 'white', zIndex: 9999, padding: 8 }}>
      <h3>Sora Downloader</h3>
      <p>Token: {token ? 'captured' : 'waiting'}</p>
      <button onClick={fetchList}>Fetch List</button>
      {status && <p>{status}</p>}
      <ul>{items.map((it: any) => <li key={it.id}>{it.id}</li>)}</ul>
    </div>
  );
};

const container = document.createElement('div');
document.body.appendChild(container);
const root = createRoot(container);
root.render(<App />);
