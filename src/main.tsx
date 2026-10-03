import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { installTigerMarkApi } from './desktop/bridge'
import { createRemoteApi, readSyncToken } from './desktop/remote'
import './styles.css'

function inTauri() {
  return '__TAURI_INTERNALS__' in window
}

async function boot() {
  if (inTauri()) {
    await installTigerMarkApi()
  } else {
    const token = readSyncToken()
    if (!token) {
      createRoot(document.getElementById('root')!).render(<SyncGate />)
      return
    }
    window.tigermark = createRemoteApi(token)
  }
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}

function SyncGate() {
  return (
    <div className="sync-gate">
      <h1>TigerMark</h1>
      <p>在电脑上打开 TigerMark，点击顶部的同步按钮，用手机浏览器打开那里显示的地址。</p>
    </div>
  )
}

void boot()
