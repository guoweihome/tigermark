import { convertFileSrc, invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type {
  ApiResult,
  FileEntry,
  NutstoreStatus,
  NutstoreSyncReport,
  OneDriveStatus,
  OneDriveSyncReport,
  SavedImage,
  TigerMarkApi,
} from '../vite-env'

function invokeError(err: unknown) {
  return typeof err === 'string' ? err : err instanceof Error ? err.message : '操作失败'
}

function onEvent<T>(event: string, cb: (payload: T) => void): () => void {
  let disposed = false
  let unlisten: UnlistenFn | undefined
  void listen<T>(event, (e) => {
    if (!disposed) cb(e.payload)
  }).then((fn) => {
    if (disposed) fn()
    else unlisten = fn
  })
  return () => {
    disposed = true
    unlisten?.()
  }
}

export function createTigerMarkApi(platform: string): TigerMarkApi {
  return {
    openDirectory: () => invoke<ApiResult<string | null>>('dialog_open_directory'),
    readDirectory: (dirPath) =>
      invoke<ApiResult<FileEntry[]>>('fs_read_directory', { dirPath }),
    readFile: (filePath) => invoke<ApiResult<string>>('fs_read_file', { filePath }),
    writeFile: (filePath, content) =>
      invoke<ApiResult<void>>('fs_write_file', { filePath, content }),
    createFile: (dirPath, name) =>
      invoke<ApiResult<string>>('fs_create_file', { dirPath, name }),
    createDirectory: (dirPath, name) =>
      invoke<ApiResult<string>>('fs_create_directory', { dirPath, name }),
    deletePath: (targetPath) =>
      invoke<ApiResult<void>>('fs_delete_path', { targetPath }),
    renamePath: (oldPath, newName) =>
      invoke<ApiResult<string>>('fs_rename_path', { oldPath, newName }),
    saveImage: (mdFilePath, bytes, mimeType) =>
      invoke<ApiResult<SavedImage>>('fs_save_image', {
        mdFilePath,
        bytes: Array.from(new Uint8Array(bytes)),
        mimeType,
      }),
    toFileUrl: (absolutePath) => convertFileSrc(absolutePath),
    platform,
    showItemInFolder: (targetPath) =>
      invoke<ApiResult<void>>('shell_show_item_in_folder', { targetPath }),
    openExternalUrl: async (url) => {
      const result = await invoke<ApiResult<void>>('open_external_url', { url })
      if (!result.ok) {
        throw new Error(result.error ?? '无法打开链接')
      }
    },
    onMenuOpenDirectory: (cb) => onEvent('menu:open-directory', () => cb()),
    onMenuSave: (cb) => onEvent('menu:save', () => cb()),
    onMenuViewMode: (cb) => onEvent<string>('menu:view-mode', cb),
    onMenuToggleSidebar: (cb) => onEvent('menu:toggle-sidebar', () => cb()),
    onMenuFind: (cb) => onEvent('menu:find', () => cb()),
    onMenuFindInFiles: (cb) => onEvent('menu:find-in-files', () => cb()),
    onCloseRequest: (cb) => onEvent('window:close-request', () => cb()),
    onHideRequest: (cb) => onEvent('window:hide-request', () => cb()),
    onQuitRequest: (cb) => onEvent('app:quit-request', () => cb()),
    allowClose: () => {
      void invoke('window_close_allow')
    },
    denyClose: () => {
      void invoke('window_close_deny')
    },
    hideWindow: () => {
      void invoke('window_hide')
    },
    quit: () => {
      void invoke('app_quit')
    },
    setNativeTheme: (theme) => invoke('theme_set', { theme }),
    oneDriveStatus: async () => {
      try {
        const data = await invoke<OneDriveStatus>('onedrive_status')
        return { ok: true, data }
      } catch (err) {
        return { ok: false, error: invokeError(err) }
      }
    },
    oneDriveLogin: async () => {
      try {
        const data = await invoke<OneDriveStatus>('onedrive_login')
        return { ok: true, data }
      } catch (err) {
        return { ok: false, error: invokeError(err) }
      }
    },
    oneDriveLogout: async () => {
      try {
        await invoke('onedrive_logout')
        return { ok: true }
      } catch (err) {
        return { ok: false, error: invokeError(err) }
      }
    },
    oneDriveSetEnabled: async (enabled) => {
      try {
        const data = await invoke<OneDriveStatus>('onedrive_set_enabled', { enabled })
        return { ok: true, data }
      } catch (err) {
        return { ok: false, error: invokeError(err) }
      }
    },
    oneDriveSync: async (rootPath, skipPath) => {
      try {
        const data = await invoke<OneDriveSyncReport>('onedrive_sync', {
          rootPath,
          skipPath: skipPath ?? null,
        })
        return { ok: true, data }
      } catch (err) {
        return { ok: false, error: invokeError(err) }
      }
    },
    nutstoreStatus: async () => {
      try {
        const data = await invoke<NutstoreStatus>('jianguoyun_status')
        return { ok: true, data }
      } catch (err) {
        return { ok: false, error: invokeError(err) }
      }
    },
    nutstoreConnect: async (account, password) => {
      try {
        const data = await invoke<NutstoreStatus>('jianguoyun_connect', { account, password })
        return { ok: true, data }
      } catch (err) {
        return { ok: false, error: invokeError(err) }
      }
    },
    nutstoreLogout: async () => {
      try {
        await invoke('jianguoyun_logout')
        return { ok: true }
      } catch (err) {
        return { ok: false, error: invokeError(err) }
      }
    },
    nutstoreSetEnabled: async (enabled) => {
      try {
        const data = await invoke<NutstoreStatus>('jianguoyun_set_enabled', { enabled })
        return { ok: true, data }
      } catch (err) {
        return { ok: false, error: invokeError(err) }
      }
    },
    nutstoreSync: async (rootPath, skipPath) => {
      try {
        const data = await invoke<NutstoreSyncReport>('jianguoyun_sync', {
          rootPath,
          skipPath: skipPath ?? null,
        })
        return { ok: true, data }
      } catch (err) {
        return { ok: false, error: invokeError(err) }
      }
    },
  }
}

export async function installTigerMarkApi() {
  const platform = await invoke<string>('get_platform')
  window.tigermark = createTigerMarkApi(platform)
}
