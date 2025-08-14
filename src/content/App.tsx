import React, { useEffect, useState } from 'react';

export const App: React.FC = () => {
  const [token, setToken] = useState<string | null>(null);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<string>).detail;
      setToken(detail);
    };
    window.addEventListener('sora-token', handler as EventListener);
    return () => window.removeEventListener('sora-token', handler as EventListener);
  }, []);

  return (
    <div id="sora-batch-root" style={{ position: 'fixed', bottom: 10, right: 10, zIndex: 9999, background: '#fff', padding: 8, borderRadius: 4, boxShadow: '0 2px 6px rgba(0,0,0,.2)' }}>
      <span>Token: {token ? 'captured' : 'awaiting...'}</span>
    </div>
  );
};
