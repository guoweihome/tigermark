import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  shell,
} from 'electron'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'

process.env.DIST = path.join(__dirname, '../dist')
process.env.VITE_PUBLIC = app.isPackaged
  ? process.env.DIST
  : path.join(__dirname, '../public')

let mainWindow: BrowserWindow | null = null

const MARKDOWN_EXTS = new Set(['.md', '.markdown', '.mdown', '.mkd', '.txt'])

function createWindow() {
  const preloadCandidates = [
    path.join(__dirname, 'preload.js'),
    path.join(__dirname, 'preload.mjs'),
  ]
  const preload =
    preloadCandidates.find((candidate) => existsSync(candidate)) ??
    preloadCandidates[0]

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 560,
    title: 'TigerMark',
    backgroundColor: '#eef1f4',
    show: false,
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
  })

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    mainWindow.loadFile(path.join(process.env.DIST!, 'index.html'))
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
}

function buildMenu() {
  const isMac = process.platform === 'darwin'
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const },
            ],
          },
        ]
      : []),
    {
      label: '文件',
      submenu: [
        {
          label: '打开文件夹…',
          accelerator: 'CmdOrCtrl+O',
          click: () => {
            mainWindow?.webContents.send('menu:open-directory')
          },
        },
        {
          label: '保存',
          accelerator: 'CmdOrCtrl+S',
          click: () => {
            mainWindow?.webContents.send('menu:save')
          },
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        {
          label: '仅编辑',
          accelerator: 'CmdOrCtrl+1',
          click: () => mainWindow?.webContents.send('menu:view-mode', 'edit'),
        },
        {
          label: '分屏',
          accelerator: 'CmdOrCtrl+2',
          click: () => mainWindow?.webContents.send('menu:view-mode', 'split'),
        },
        {
          label: '仅预览',
          accelerator: 'CmdOrCtrl+3',
          click: () => mainWindow?.webContents.send('menu:view-mode', 'preview'),
        },
        { type: 'separator' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

async function readDirectoryTree(dirPath: string, depth = 0): Promise<FileNode[]> {
  if (depth > 8) return []

  const entries = await fs.readdir(dirPath, { withFileTypes: true })
  const nodes: FileNode[] = []

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const fullPath = path.join(dirPath, entry.name)
    if (entry.isDirectory()) {
      const children = await readDirectoryTree(fullPath, depth + 1)
      nodes.push({
        name: entry.name,
        path: fullPath,
        isDirectory: true,
        children,
      })
    } else {
      const ext = path.extname(entry.name).toLowerCase()
      if (!MARKDOWN_EXTS.has(ext) && ext !== '') continue
      if (ext === '' && !entry.name.toLowerCase().endsWith('.md')) continue
      nodes.push({
        name: entry.name,
        path: fullPath,
        isDirectory: false,
      })
    }
  }

  return nodes.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
    return a.name.localeCompare(b.name, 'zh-CN')
  })
}

interface FileNode {
  name: string
  path: string
  isDirectory: boolean
  children?: FileNode[]
}

function ok<T>(data: T) {
  return { ok: true as const, data }
}

function fail(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return { ok: false as const, error: message }
}

function registerIpc() {
  ipcMain.handle('dialog:openDirectory', async () => {
    try {
      const result = await dialog.showOpenDialog(mainWindow!, {
        properties: ['openDirectory'],
        title: '选择工作目录',
      })
      if (result.canceled || result.filePaths.length === 0) {
        return ok(null)
      }
      return ok(result.filePaths[0])
    } catch (error) {
      return fail(error)
    }
  })

  ipcMain.handle('fs:readDirectory', async (_event, dirPath: string) => {
    try {
      const tree = await readDirectoryTree(dirPath)
      return ok(tree)
    } catch (error) {
      return fail(error)
    }
  })

  ipcMain.handle('fs:readFile', async (_event, filePath: string) => {
    try {
      const content = await fs.readFile(filePath, 'utf-8')
      return ok(content)
    } catch (error) {
      return fail(error)
    }
  })

  ipcMain.handle(
    'fs:writeFile',
    async (_event, filePath: string, content: string) => {
      try {
        await fs.writeFile(filePath, content, 'utf-8')
        return ok(undefined)
      } catch (error) {
        return fail(error)
      }
    },
  )

  ipcMain.handle(
    'fs:createFile',
    async (_event, dirPath: string, name: string) => {
      try {
        const fileName = name.endsWith('.md') ? name : `${name}.md`
        const filePath = path.join(dirPath, fileName)
        await fs.writeFile(filePath, '# ' + path.basename(fileName, '.md') + '\n\n', {
          flag: 'wx',
          encoding: 'utf-8',
        })
        return ok(filePath)
      } catch (error) {
        return fail(error)
      }
    },
  )

  ipcMain.handle(
    'fs:createDirectory',
    async (_event, dirPath: string, name: string) => {
      try {
        const newPath = path.join(dirPath, name)
        await fs.mkdir(newPath)
        return ok(newPath)
      } catch (error) {
        return fail(error)
      }
    },
  )

  ipcMain.handle('fs:deletePath', async (_event, targetPath: string) => {
    try {
      const stat = await fs.stat(targetPath)
      if (stat.isDirectory()) {
        await fs.rm(targetPath, { recursive: true, force: true })
      } else {
        await fs.unlink(targetPath)
      }
      return ok(undefined)
    } catch (error) {
      return fail(error)
    }
  })

  ipcMain.handle(
    'fs:renamePath',
    async (_event, oldPath: string, newName: string) => {
      try {
        const newPath = path.join(path.dirname(oldPath), newName)
        await fs.rename(oldPath, newPath)
        return ok(newPath)
      } catch (error) {
        return fail(error)
      }
    },
  )
}

app.whenReady().then(() => {
  registerIpc()
  buildMenu()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
