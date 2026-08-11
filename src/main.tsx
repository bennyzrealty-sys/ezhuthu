import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { registerServiceWorker } from './pwa/register';
import { installController } from './pwa/install';
// Before theme.css, so the @font-face is registered by the time the rules that
// reference the family are parsed.
import './ui/fonts.css';
import './ui/theme.css';

// Before render, not from a component: `beforeinstallprompt` fires when the
// browser decides, routinely before React has mounted, and an event nobody was
// listening for cannot be replayed.
installController();

const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

registerServiceWorker();
