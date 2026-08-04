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
  platform: string
  onMenuOpenDirectory: (cb: () => void) => () => void
  onMenuSave: (cb: () => void) => () => void
  onMenuViewMode: (cb: (mode: string) => void) => () => void
}

declare global {
  interface Window {
    tigermark: TigerMarkApi
  }
}

export {}
