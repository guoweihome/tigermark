import type { ApiResult, SyncEvent, SyncInfo, TigerMarkApi } from '../vite-env'

const TOKEN_KEY = 'tigermark.syncToken'
const CLIENT_KEY = 'tigermark.clientId'

export function readSyncToken() {
  const params = new URLSearchParams(location.search)
  const fromUrl = params.get('token')
  if (fromUrl) {
    sessionStorage.setItem(TOKEN_KEY, fromUrl)
    params.delete('token')
    const next = params.toString()
    const query = next ? `?${next}` : ''
    history.replaceState(null, '', `${location.pathname}${query}${location.hash}`)
  }
  return sessionStorage.getItem(TOKEN_KEY) ?? ''
}

function clientOrigin() {
  let id = sessionStorage.getItem(CLIENT_KEY)
  if (!id) {
    id = crypto.randomUUID()
    sessionStorage.setItem(CLIENT_KEY, id)
  }
  return id
}

function bytesToBase64(bytes: ArrayBuffer) {
  const view = new Uint8Array(bytes)
  let binary = ''
  const chunk = 0x8000
  for (let index = 0; index < view.length; index += chunk) {
    binary += String.fromCharCode(...view.subarray(index, index + chunk))
  }
  return btoa(binary)
}

export function createRemoteApi(token: string): TigerMarkApi {
  const origin = clientOrigin()
  document.cookie = `tm_sync=${token}; Path=/; SameSite=Lax`

  async function api<T>(path: string, init?: RequestInit): Promise<ApiResult<T>> {
    try {
      const response = await fetch(path, {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
          ...init?.headers,
        },
      })
      if (response.status === 401) {
        return { ok: false, error: '同步口令无效，请重新打开桌面端给出的地址' }
      }
      return (await response.json()) as ApiResult<T>
    } catch {
      return { ok: false, error: '无法连接桌面端，请确认手机和电脑在同一局域网' }
    }
  }

  const platform = /android/i.test(navigator.userAgent) ? 'android' : 'web'

  return {
    openDirectory: async () => {
      const result = await api<{ root: string; name: string }>('/api/workspace')
      if (!result.ok || !result.data) {
        return { ok: false, error: result.error ?? '桌面端尚未打开文件夹' }
      }
      window.tigermark.workspaceName = result.data.name
      return { ok: true, data: result.data.root || '.' }
    },
    readDirectory: () => api('/api/tree'),
    readFile: (filePath) => api(`/api/file?path=${encodeURIComponent(filePath)}`),
    writeFile: (filePath, content) =>
      api('/api/file', {
        method: 'PUT',
        body: JSON.stringify({ path: filePath, content, origin }),
      }),
    createFile: (dirPath, name) =>
      api('/api/create-file', {
        method: 'POST',
        body: JSON.stringify({ dirPath, name, origin }),
      }),
    createDirectory: (dirPath, name) =>
      api('/api/create-folder', {
        method: 'POST',
        body: JSON.stringify({ dirPath, name, origin }),
      }),
    deletePath: (targetPath) =>
      api('/api/delete', {
        method: 'POST',
        body: JSON.stringify({ path: targetPath, origin }),
      }),
    renamePath: (oldPath, newName) =>
      api('/api/rename', {
        method: 'POST',
        body: JSON.stringify({ path: oldPath, name: newName, origin }),
      }),
    saveImage: async (mdFilePath, bytes, mimeType) => {
      const result = await api<string>('/api/image', {
        method: 'POST',
        body: JSON.stringify({
          mdPath: mdFilePath,
          mimeType,
          dataBase64: bytesToBase64(bytes),
          origin,
        }),
      })
      if (!result.ok || !result.data) return { ok: false, error: result.error }
      return {
        ok: true,
        data: { absolutePath: result.data, relativePath: result.data },
      }
    },
    toFileUrl: (absolutePath) => {
      const path = absolutePath.replace(/\\/g, '/').replace(/^\.\//, '')
      return `/api/raw?path=${encodeURIComponent(path)}`
    },
    platform,
    showItemInFolder: async () => ({ ok: false, error: '手机端不能打开电脑上的文件夹' }),
    onMenuOpenDirectory: () => () => {},
    onMenuSave: () => () => {},
    onMenuViewMode: () => () => {},
    onMenuToggleSidebar: () => () => {},
    onMenuFind: () => () => {},
    onCloseRequest: () => () => {},
    onHideRequest: () => () => {},
    onQuitRequest: () => () => {},
    allowClose: () => {},
    denyClose: () => {},
    hideWindow: () => {},
    quit: () => {},
    setNativeTheme: async () => {},
    isRemote: true,
    getSyncInfo: async (): Promise<SyncInfo | null> => ({
      port: Number(location.port) || 80,
      token,
      host: location.hostname,
      pageUrl: location.href,
      clients: 1,
      sharing: false,
      workspaceOpen: true,
    }),
    setSyncWorkspace: async () => {},
    setSyncSharing: async () => {},
    discoverSync: async () => [],
    followSync: async () => ({ ok: false, error: '手机浏览器直接查看电脑上的笔记' }),
    onSync: (cb) => {
      let closed = false
      let source: EventSource | null = null
      let timer = 0
      const connect = () => {
        if (closed) return
        source = new EventSource(`/api/events?token=${encodeURIComponent(token)}`)
        source.onmessage = (event) => {
          try {
            cb(JSON.parse(event.data) as SyncEvent)
          } catch {
            /* ignore malformed events */
          }
        }
        source.onerror = () => {
          source?.close()
          if (!closed) timer = window.setTimeout(connect, 1500)
        }
      }
      connect()
      return () => {
        closed = true
        window.clearTimeout(timer)
        source?.close()
      }
    },
  }
}
