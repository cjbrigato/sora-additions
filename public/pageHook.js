// Robust Authorization capture from page context (user gesture friendly)
(function () {
    const orig = window.fetch;
    window.fetch = async function (...args) {
      try {
        const [input, init] = args;
        let auth = null;
  
        if (input instanceof Request && input.headers?.get) {
          auth = input.headers.get('authorization') || input.headers.get('Authorization');
        }
        if (!auth && init && init.headers) {
          if (init.headers instanceof Headers) {
            auth = init.headers.get('authorization') || init.headers.get('Authorization');
          } else if (typeof init.headers === 'object') {
            for (const k of Object.keys(init.headers)) {
              if (k.toLowerCase() === 'authorization') { auth = init.headers[k]; break; }
            }
          }
        }
        if (auth && typeof auth === 'string' && auth.startsWith('Bearer ')) {
          const token = auth.slice('Bearer '.length);
          window.dispatchEvent(new CustomEvent('sora-token', { detail: token }));
        }
      } catch (_) {}
      return orig.apply(this, args);
    };
  })();
  