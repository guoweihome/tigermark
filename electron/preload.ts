import { contextBridge, ipcRenderer } from 'electron'

const api = {
  openDirectory: () => ipcRenderer.invoke('dialog:openDirectory'),
  readDirectory: (dirPath: string) =>
    ipcRenderer.invoke('fs:readDirectory', dirPath),
  readFile: (filePath: string) => ipcRenderer.invoke('fs:readFile', filePath),
  writeFile: (filePath: string, content: string) =>
    ipcRenderer.invoke('fs:writeFile', filePath, content),
  createFile: (dirPath: string, name: string) =>
    ipcRenderer.invoke('fs:createFile', dirPath, name),
  createDirectory: (dirPath: string, name: string) =>
    ipcRenderer.invoke('fs:createDirectory', dirPath, name),
  deletePath: (targetPath: string) =>
    ipcRenderer.invoke('fs:deletePath', targetPath),
  renamePath: (oldPath: string, newName: string) =>
    ipcRenderer.invoke('fs:renamePath', oldPath, newName),
  saveImage: (mdFilePath: string, bytes: ArrayBuffer, mimeType: string) =>
    ipcRenderer.invoke('fs:saveImage', mdFilePath, bytes, mimeType),
  platform: process.platform,
  showItemInFolder: (targetPath: string) =>
    ipcRenderer.invoke('shell:showItemInFolder', targetPath),
  onMenuOpenDirectory: (cb: () => void) => {
    const listener = () => cb()
    ipcRenderer.on('menu:open-directory', listener)
    return () => ipcRenderer.removeListener('menu:open-directory', listener)
  },
  onMenuSave: (cb: () => void) => {
    const listener = () => cb()
    ipcRenderer.on('menu:save', listener)
    return () => ipcRenderer.removeListener('menu:save', listener)
  },
  onMenuViewMode: (cb: (mode: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, mode: string) => cb(mode)
    ipcRenderer.on('menu:view-mode', listener)
    return () => ipcRenderer.removeListener('menu:view-mode', listener)
  },
  onMenuToggleSidebar: (cb: () => void) => {
    const listener = () => cb()
    ipcRenderer.on('menu:toggle-sidebar', listener)
    return () => ipcRenderer.removeListener('menu:toggle-sidebar', listener)
  },
  onCloseRequest: (cb: () => void) => {
    const listener = () => cb()
    ipcRenderer.on('window:close-request', listener)
    return () => ipcRenderer.removeListener('window:close-request', listener)
  },
  allowClose: () => {
    ipcRenderer.send('window:close-allow')
  },
  denyClose: () => {
    ipcRenderer.send('window:close-deny')
  },
  setNativeTheme: (theme: 'light' | 'dark' | 'system') =>
    ipcRenderer.invoke('theme:set', theme),
}

contextBridge.exposeInMainWorld('tigermark', api)
