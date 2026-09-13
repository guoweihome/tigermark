import { convertFileSrc, invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { ApiResult, FileEntry, SavedImage, TigerMarkApi } from '../vite-env'

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
    onMenuOpenDirectory: (cb) => onEvent('menu:open-directory', () => cb()),
    onMenuSave: (cb) => onEvent('menu:save', () => cb()),
    onMenuViewMode: (cb) => onEvent<string>('menu:view-mode', cb),
    onMenuToggleSidebar: (cb) => onEvent('menu:toggle-sidebar', () => cb()),
    onCloseRequest: (cb) => onEvent('window:close-request', () => cb()),
    allowClose: () => {
      void invoke('window_close_allow')
    },
    denyClose: () => {
      void invoke('window_close_deny')
    },
    setNativeTheme: (theme) => invoke('theme_set', { theme }),
  }
}

export async function installTigerMarkApi() {
  const platform = await invoke<string>('get_platform')
  window.tigermark = createTigerMarkApi(platform)
}
