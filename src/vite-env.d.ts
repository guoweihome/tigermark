/// <reference types="vite/client" />

export interface FileEntry {
  name: string
  path: string
  isDirectory: boolean
  children?: FileEntry[]
}

export interface ApiResult<T> {
  ok: boolean
  data?: T
  error?: string
}

export interface SavedImage {
  absolutePath: string
  relativePath: string
}

export type ViewMode = 'edit' | 'split' | 'preview'

export interface TigerMarkApi {
  openDirectory: () => Promise<ApiResult<string | null>>
  readDirectory: (dirPath: string) => Promise<ApiResult<FileEntry[]>>
  readFile: (filePath: string) => Promise<ApiResult<string>>
  writeFile: (filePath: string, content: string) => Promise<ApiResult<void>>
  createFile: (dirPath: string, name: string) => Promise<ApiResult<string>>
  createDirectory: (dirPath: string, name: string) => Promise<ApiResult<string>>
  deletePath: (targetPath: string) => Promise<ApiResult<void>>
  renamePath: (oldPath: string, newName: string) => Promise<ApiResult<string>>
  saveImage: (
    mdFilePath: string,
    bytes: ArrayBuffer,
    mimeType: string,
  ) => Promise<ApiResult<SavedImage>>
  toFileUrl: (absolutePath: string) => string
  platform: string
  showItemInFolder: (targetPath: string) => Promise<ApiResult<void>>
  onMenuOpenDirectory: (cb: () => void) => () => void
  onMenuSave: (cb: () => void) => () => void
  onMenuViewMode: (cb: (mode: string) => void) => () => void
  onMenuToggleSidebar: (cb: () => void) => () => void
  onMenuFind: (cb: () => void) => () => void
  onCloseRequest: (cb: () => void) => () => void
  onHideRequest: (cb: () => void) => () => void
  onQuitRequest: (cb: () => void) => () => void
  allowClose: () => void
  denyClose: () => void
  hideWindow: () => void
  quit: () => void
  setNativeTheme: (theme: 'light' | 'dark' | 'system') => Promise<void>
}

interface QueryLocalFont {
  family: string
}

declare global {
  interface Window {
    tigermark: TigerMarkApi
    queryLocalFonts?: () => Promise<QueryLocalFont[]>
  }
}

export {}
