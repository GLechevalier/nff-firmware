import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Analytics } from '@vercel/analytics/react'
import './index.css'
import { AuthGate } from './AuthGate'
import { TenantProvider } from './context/TenantContext'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <TenantProvider>
      <AuthGate />
    </TenantProvider>
    <Analytics />
  </StrictMode>,
)
