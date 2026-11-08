import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { installTigerMarkApi } from './desktop/bridge'
import './styles.css'

function inTauri() {
  return '__TAURI_INTERNALS__' in window
}

async function boot() {
  if (!inTauri()) {
    createRoot(document.getElementById('root')!).render(
      <div className="sync-gate">
        <h1>TigerMark</h1>
        <p>请在电脑上的 TigerMark 应用中打开。</p>
      </div>,
    )
    return
  }
  await installTigerMarkApi()
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}

void boot()
