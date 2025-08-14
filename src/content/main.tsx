import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { initContent } from './logic';

initContent();

const container = document.createElement('div');
document.documentElement.appendChild(container);
const root = createRoot(container);
root.render(<App />);
