import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ConnectionSettings } from './feishu/ConnectionSettings';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element not found');
}

createRoot(rootElement).render(
  <React.StrictMode>
    <ConnectionSettings />
    <App />
  </React.StrictMode>
);
