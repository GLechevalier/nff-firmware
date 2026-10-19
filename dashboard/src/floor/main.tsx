import { createRoot } from 'react-dom/client';
import '../index.css';
import { FloorApp } from './FloorApp';

// No StrictMode: the floor holds long-lived Supabase Realtime subscriptions, and the
// dev-only double-mount would open duplicate channels. The page is read-only.
createRoot(document.getElementById('root')!).render(<FloorApp />);
