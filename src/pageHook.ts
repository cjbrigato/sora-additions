// Injected into the page context to robustly capture Bearer token
(() => {
  const orig = window.fetch;
  window.fetch = async function (...args: Parameters<typeof fetch>): Promise<Response> {
    try {
      const [input, init] = args as [RequestInfo | URL, RequestInit?];
      let auth: string | null = null;
  
        if (input instanceof Request && input.headers?.get) {
          auth = input.headers.get('authorization') || input.headers.get('Authorization');
        }
        if (!auth && init && init.headers) {
      if (init.headers instanceof Headers) {
        auth = init.headers.get('authorization') || init.headers.get('Authorization');
      } else if (typeof init.headers === 'object') {
        const obj = init.headers as Record<string, string>;
        for (const k of Object.keys(obj)) {
          if (k.toLowerCase() === 'authorization') { auth = obj[k]; break; }
        }
      }
        }
      if (auth && auth.startsWith('Bearer ')) {
        const token = auth.slice('Bearer '.length);
        window.dispatchEvent(new CustomEvent('sora-token', { detail: token }));
      }
    } catch { /* no header logs */ }
    return orig.apply(this, args as any);
  };
})();
  