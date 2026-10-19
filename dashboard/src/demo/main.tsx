import { createRoot } from 'react-dom/client';
import '../index.css';
import { DemoApp } from './DemoApp';

// No StrictMode here: the demo drives setTimeout-based animation loops, and the
// dev-only double-mount would spawn duplicate timers. The demo is read-only and
// side-effect-free otherwise, so the extra StrictMode checks buy us nothing.
createRoot(document.getElementById('root')!).render(<DemoApp />);
