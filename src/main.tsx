import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { installTigerMarkApi } from './desktop/bridge'
import './styles.css'

async function boot() {
  await installTigerMarkApi()
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}

void boot()
