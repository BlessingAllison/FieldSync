import './styles/index.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';

import { router } from './app/router';
import { boot } from './app/runtime';
import { registerServiceWorker } from './pwa/sw-registration';
import { startNetworkListener } from './stores/network';
import { loadPreferences } from './stores/preferences';

const container = document.getElementById('root');
if (!container) throw new Error('#root missing from index.html');

startNetworkListener();
registerServiceWorker();

// Theme and language first (no flash of the wrong theme/language), then the session.
// A promise chain, not top-level await: the Chrome 87 floor predates TLA (Chrome 89).
void loadPreferences().finally(() => {
  void boot();
  createRoot(container).render(
    <StrictMode>
      <RouterProvider router={router} future={{ v7_startTransition: true }} />
    </StrictMode>,
  );
});
