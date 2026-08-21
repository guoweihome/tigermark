import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  protocol,
  shell,
} from 'electron'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'tmfile',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      bypassCSP: true,
      stream: true,
      corsEnabled: true,
    },
  },
])

process.env.DIST = path.join(__dirname, '../dist')
process.env.VITE_PUBLIC = app.isPackaged
  ? process.env.DIST
  : path.join(__dirname, '../public')

const SITE_URL = 'https://www.pytiger.com/'
let mainWindow: BrowserWindow | null = null
let allowClose = false
let isQuitting = false

const MARKDOWN_EXTS = new Set(['.md', '.markdown', '.mdown', '.mkd', '.txt'])
/** Paste-image attachment dirs — keep out of the markdown file tree. */
const HIDDEN_DIRS = new Set(['assets', 'node_modules', '.git'])

function resolveAppIcon() {
  const roots = [
    process.env.VITE_PUBLIC,
    path.join(__dirname, '../public'),
    path.join(__dirname, '../build'),
    path.join(process.cwd(), 'public'),
    path.join(process.cwd(), 'build'),
    process.resourcesPath,
  ].filter((root): root is string => Boolean(root))

  const names =
    process.platform === 'darwin'
      ? ['icon.icns', 'icon.png']
      : process.platform === 'win32'
        ? ['icon.ico', 'icon.png']
        : ['icon.png']

  for (const name of names) {
    for (const root of roots) {
      const candidate = path.resolve(root, name)
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

function loadAppIcon() {
  const iconPath = resolveAppIcon()
  if (!iconPath) return undefined
  const image = nativeImage.createFromPath(iconPath)
  return image.isEmpty() ? undefined : image
}

function createWindow() {
  allowClose = false
  const preloadCandidates = [
    path.join(__dirname, 'preload.js'),
    path.join(__dirname, 'preload.mjs'),
  ]
  const preload =
    preloadCandidates.find((candidate) => existsSync(candidate)) ??
    preloadCandidates[0]
  const iconPath = resolveAppIcon()
  const iconImage = loadAppIcon()

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 560,
    title: 'TigerMark',
    show: false,
    ...(iconPath ? { icon: iconPath } : {}),
    ...(process.platform === 'darwin'
      ? {
          titleBarStyle: 'hiddenInset' as const,
          trafficLightPosition: { x: 16, y: 12 },
          vibrancy: 'under-window' as const,
          visualEffectState: 'active' as const,
          backgroundColor: '#00000000',
        }
      : process.platform === 'win32'
        ? {
            backgroundMaterial: 'acrylic' as const,
            backgroundColor: '#00000000',
          }
        : { backgroundColor: '#eef1f4' }),
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  if (iconImage && process.platform === 'darwin') {
    app.dock?.setIcon(iconImage)
  }

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

  mainWindow.on('close', (event) => {
    if (allowClose) return
    event.preventDefault()
    mainWindow?.webContents.send('window:close-request')
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
              {
                label: `关于 ${app.name}`,
                click: () => {
                  void showAbout()
                },
              },
              {
                label: '官网',
                click: () => {
                  void shell.openExternal(SITE_URL)
                },
              },
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
        {
          label: '切换侧边栏',
          accelerator: 'CmdOrCtrl+B',
          click: () => mainWindow?.webContents.send('menu:toggle-sidebar'),
        },
        { type: 'separator' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        ...(!isMac
          ? [
              {
                label: '关于 TigerMark',
                click: () => {
                  void showAbout()
                },
              },
            ]
          : []),
        {
          label: '官网',
          click: () => {
            void shell.openExternal(SITE_URL)
          },
        },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function configureAboutPanel() {
  const iconPath = resolveAppIcon()
  app.setAboutPanelOptions({
    applicationName: 'TigerMark',
    applicationVersion: app.getVersion(),
    website: SITE_URL,
    credits: SITE_URL,
    ...(iconPath ? { iconPath } : {}),
  })
}

async function showAbout() {
  const icon = loadAppIcon()
  const result = await dialog.showMessageBox({
    title: '关于 TigerMark',
    message: 'TigerMark',
    detail: `版本 ${app.getVersion()}\n官网 ${SITE_URL}`,
    ...(icon ? { icon } : { type: 'info' }),
    buttons: ['打开官网', '关闭'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  })
  if (result.response === 0) {
    await shell.openExternal(SITE_URL)
  }
}

async function readDirectoryTree(dirPath: string, depth = 0): Promise<FileNode[]> {
  if (depth > 8) return []

  const entries = await fs.readdir(dirPath, { withFileTypes: true })
  const nodes: FileNode[] = []

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    if (entry.isDirectory() && HIDDEN_DIRS.has(entry.name.toLowerCase())) continue
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

function mimeToExt(mimeType: string) {
  switch (mimeType) {
    case 'image/jpeg':
      return '.jpg'
    case 'image/gif':
      return '.gif'
    case 'image/webp':
      return '.webp'
    case 'image/svg+xml':
      return '.svg'
    case 'image/png':
    default:
      return '.png'
  }
}

function extToMime(ext: string) {
  switch (ext.toLowerCase()) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.gif':
      return 'image/gif'
    case '.webp':
      return 'image/webp'
    case '.svg':
      return 'image/svg+xml'
    case '.png':
    default:
      return 'image/png'
  }
}

function pasteImageName(mimeType: string) {
  const now = new Date()
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    '-',
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ].join('')
  const rand = Math.random().toString(36).slice(2, 6)
  return `paste-${stamp}-${rand}${mimeToExt(mimeType)}`
}

function parseTmfilePath(requestUrl: string) {
  const url = new URL(requestUrl)
  let filePath = decodeURIComponent(url.pathname)

  // standard scheme may put drive/host in hostname on some platforms
  if (url.hostname && url.hostname !== 'localhost') {
    filePath = `/${url.hostname}${filePath}`
  }

  if (process.platform === 'win32' && /^\/[A-Za-z]:/.test(filePath)) {
    filePath = filePath.slice(1)
  }

  return filePath
}

function registerFileProtocol() {
  protocol.handle('tmfile', async (request) => {
    try {
      const filePath = parseTmfilePath(request.url)
      const data = await fs.readFile(filePath)
      return new Response(data, {
        headers: {
          'Content-Type': extToMime(path.extname(filePath)),
          'Cache-Control': 'no-cache',
        },
      })
    } catch {
      return new Response('Not Found', { status: 404, statusText: 'Not Found' })
    }
  })
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

  ipcMain.handle(
    'fs:saveImage',
    async (_event, mdFilePath: string, bytes: ArrayBuffer, mimeType: string) => {
      try {
        const assetsDir = path.join(path.dirname(mdFilePath), 'assets')
        await fs.mkdir(assetsDir, { recursive: true })
        const fileName = pasteImageName(mimeType || 'image/png')
        const absolutePath = path.join(assetsDir, fileName)
        await fs.writeFile(absolutePath, Buffer.from(bytes))
        return ok({
          absolutePath,
          relativePath: `assets/${fileName}`,
        })
      } catch (error) {
        return fail(error)
      }
    },
  )

  ipcMain.handle('shell:showItemInFolder', async (_event, targetPath: string) => {
    try {
      if (!existsSync(targetPath)) {
        return fail(new Error('路径不存在'))
      }
      shell.showItemInFolder(targetPath)
      return ok(undefined)
    } catch (error) {
      return fail(error)
    }
  })
}

function registerWindowCloseIpc() {
  ipcMain.on('window:close-allow', () => {
    allowClose = true
    if (isQuitting) {
      app.quit()
      return
    }
    mainWindow?.close()
  })

  ipcMain.on('window:close-deny', () => {
    isQuitting = false
  })

  ipcMain.handle('theme:set', (_event, theme: string) => {
    if (theme === 'light' || theme === 'dark' || theme === 'system') {
      nativeTheme.themeSource = theme
    }
  })
}

app.setName('TigerMark')

app.whenReady().then(() => {
  registerFileProtocol()
  registerIpc()
  registerWindowCloseIpc()
  configureAboutPanel()
  buildMenu()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      allowClose = false
      createWindow()
    }
  })
})

app.on('before-quit', () => {
  isQuitting = true
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
