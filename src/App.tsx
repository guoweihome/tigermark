import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FileEntry, ViewMode } from './vite-env'
import { ConfirmLeaveDialog } from './components/ConfirmLeaveDialog'
import { FileTree } from './components/FileTree'
import { GlobalSearch } from './components/GlobalSearch'
import { MarkdownEditor, type MarkdownEditorHandle } from './components/MarkdownEditor'
import { MarkdownPreview, type MarkdownPreviewHandle } from './components/MarkdownPreview'
import { NameDialog } from './components/NameDialog'
import { IconFolder, IconNewFile, IconNewFolder } from './components/icons'
import { SyncDialog } from './components/SyncDialog'
import { Toolbar } from './components/Toolbar'
import { Whiteboard } from './components/Whiteboard'
import {
  clampFontSize,
  cssFontFamily,
  DEFAULT_FONT,
  DEFAULT_FONT_SIZE,
  normalizeFontFamily,
  revealInFolderLabel,
} from './fonts'
import { clearSession, readSession, writeSession } from './session'
import { useTheme } from './theme'

function topLevelDirPaths(entries: FileEntry[]): string[] {
  return entries.filter((e) => e.isDirectory).map((e) => e.path)
}

function basename(filePath: string) {
  return filePath.split(/[/\\]/).pop() ?? filePath
}

function dirname(filePath: string) {
  const normalized = filePath.replace(/\\/g, '/')
  const index = normalized.lastIndexOf('/')
  if (index <= 0) return index === 0 ? '/' : '.'
  return normalized.slice(0, index)
}

function isBoardPath(filePath: string) {
  return filePath.replace(/\\/g, '/').toLowerCase().endsWith('.board.json')
}

function isPhoneLayout() {
  return window.matchMedia('(max-width: 760px)').matches
}

function joinWorkspacePath(root: string, rel: string) {
  const relative = rel.replace(/\\/g, '/')
  if (!root || root === '.') return relative
  const sep = root.includes('\\') ? '\\' : '/'
  return `${root.replace(/[/\\]+$/, '')}${sep}${relative.replace(/\//g, sep)}`
}

function pathsEqual(left: string | null, right: string | null) {
  if (!left || !right) return false
  return left.replace(/\\/g, '/').replace(/\/+$/, '') === right.replace(/\\/g, '/').replace(/\/+$/, '')
}

function isInsidePath(parent: string, child: string) {
  const base = parent.replace(/\\/g, '/').replace(/\/+$/, '')
  const next = child.replace(/\\/g, '/')
  return next === base || next.startsWith(`${base}/`)
}

function filterTree(entries: FileEntry[], query: string): FileEntry[] {
  const q = query.trim().toLowerCase()
  if (!q) return entries

  const result: FileEntry[] = []
  for (const entry of entries) {
    if (entry.isDirectory) {
      const children = filterTree(entry.children ?? [], q)
      if (children.length > 0 || entry.name.toLowerCase().includes(q)) {
        result.push({ ...entry, children })
      }
    } else if (entry.name.toLowerCase().includes(q)) {
      result.push(entry)
    }
  }
  return result
}

type NamePrompt =
  | { kind: 'createFile'; dirPath: string; board?: boolean }
  | { kind: 'createFolder'; dirPath: string }
  | { kind: 'rename'; entry: FileEntry }

const UI_STORAGE_KEY = 'tigermark.ui'
const SIDEBAR_MIN = 180
const SIDEBAR_MAX = 480
const SIDEBAR_COLLAPSE = 120
const SPLIT_MIN = 0.22
const SPLIT_MAX = 0.78

function readUiPrefs() {
  try {
    const raw = localStorage.getItem(UI_STORAGE_KEY)
    if (!raw) {
      return {
        sidebarWidth: 260,
        sidebarOpen: true,
        splitRatio: 0.5,
        fontFamily: DEFAULT_FONT,
        fontSize: DEFAULT_FONT_SIZE,
      }
    }
    const parsed = JSON.parse(raw) as {
      sidebarWidth?: unknown
      sidebarOpen?: unknown
      splitRatio?: unknown
      fontFamily?: unknown
      fontSize?: unknown
    }
    const width =
      typeof parsed.sidebarWidth === 'number'
        ? Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, parsed.sidebarWidth))
        : 260
    const splitRatio =
      typeof parsed.splitRatio === 'number'
        ? Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, parsed.splitRatio))
        : 0.5
    const fontFamily = normalizeFontFamily(parsed.fontFamily)
    return {
      sidebarWidth: width,
      sidebarOpen: parsed.sidebarOpen !== false,
      splitRatio,
      fontFamily,
      fontSize: clampFontSize(parsed.fontSize ?? DEFAULT_FONT_SIZE),
    }
  } catch {
    return {
      sidebarWidth: 260,
      sidebarOpen: true,
      splitRatio: 0.5,
      fontFamily: DEFAULT_FONT,
      fontSize: DEFAULT_FONT_SIZE,
    }
  }
}

export default function App() {
  const { preference: theme, resolved: resolvedTheme, setPreference: setTheme } = useTheme()
  const [rootPath, setRootPath] = useState<string | null>(null)
  const [tree, setTree] = useState<FileEntry[]>([])
  const [activePath, setActivePath] = useState<string | null>(null)
  const [content, setContent] = useState('')
  const [dirty, setDirty] = useState(false)
  const [viewMode, setViewMode] = useState<ViewMode>('split')
  const [toast, setToast] = useState<{ text: string; id: number } | null>(null)
  const setStatus = useCallback((text: string) => setToast({ text, id: Date.now() }), [])
  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), 2800)
    return () => window.clearTimeout(timer)
  }, [toast])
  const [sidebarWidth, setSidebarWidth] = useState(() => readUiPrefs().sidebarWidth)
  const [sidebarOpen, setSidebarOpen] = useState(() =>
    isPhoneLayout() ? false : readUiPrefs().sidebarOpen,
  )
  const [sidebarPeeking, setSidebarPeeking] = useState(false)
  const [isResizing, setIsResizing] = useState(false)
  const [splitRatio, setSplitRatio] = useState(() => readUiPrefs().splitRatio)
  const [isSplitResizing, setIsSplitResizing] = useState(false)
  const [fontFamily, setFontFamily] = useState(() => readUiPrefs().fontFamily)
  const [fontSize, setFontSize] = useState(() => readUiPrefs().fontSize)
  const [fileQuery, setFileQuery] = useState('')
  const [globalSearchOpen, setGlobalSearchOpen] = useState(false)
  const [libraryVersion, setLibraryVersion] = useState(0)
  const [namePrompt, setNamePrompt] = useState<NamePrompt | null>(null)
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set())
  const savingRef = useRef(false)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const editorRef = useRef<MarkdownEditorHandle>(null)
  const previewRef = useRef<MarkdownPreviewHandle>(null)
  const [findTarget, setFindTarget] = useState<'editor' | 'preview'>('editor')
  const contentRef = useRef(content)
  const activePathRef = useRef(activePath)
  const dirtyRef = useRef(dirty)
  const rootPathRef = useRef(rootPath)
  const expandedPathsRef = useRef(expandedPaths)
  const sessionReadyRef = useRef(false)
  const lastSidebarWidthRef = useRef(sidebarWidth)
  const lastToggleAtRef = useRef(0)
  const peekTimerRef = useRef<number | null>(null)
  const sidebarOpenRef = useRef(sidebarOpen)
  const panesRef = useRef<HTMLDivElement>(null)
  const leaveResolverRef = useRef<((choice: 'save' | 'discard' | 'cancel') => void) | null>(
    null,
  )
  const confirmUnsavedRef = useRef<() => Promise<boolean>>(async () => true)
  const globalSearchOpenRef = useRef(false)
  const lastSearchToggleRef = useRef(0)
  const jumpRef = useRef<{ path: string; line: number; query: string } | null>(null)
  const viewModeRef = useRef(viewMode)
  const [leavePrompt, setLeavePrompt] = useState(false)
  const [isPhone, setIsPhone] = useState(isPhoneLayout)
  const [remoteName, setRemoteName] = useState<string | null>(
    () => window.tigermark?.workspaceName ?? null,
  )
  const [syncOpen, setSyncOpen] = useState(false)
  const [syncPeers, setSyncPeers] = useState(0)
  const [linked, setLinked] = useState(false)
  const [sessionSettled, setSessionSettled] = useState(false)
  const isMac = window.tigermark?.platform === 'darwin'
  const isRemote = Boolean(window.tigermark?.isRemote)
  const phoneRef = useRef(isPhone)

  contentRef.current = content
  activePathRef.current = activePath
  dirtyRef.current = dirty
  rootPathRef.current = rootPath
  expandedPathsRef.current = expandedPaths
  sidebarOpenRef.current = sidebarOpen
  phoneRef.current = isPhone
  globalSearchOpenRef.current = globalSearchOpen
  viewModeRef.current = viewMode

  useEffect(() => {
    if (viewMode === 'preview') setFindTarget('preview')
    if (viewMode === 'edit') setFindTarget('editor')
  }, [viewMode])

  useEffect(() => {
    const media = window.matchMedia('(max-width: 760px)')
    const onChange = () => setIsPhone(media.matches)
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])

  useEffect(() => {
    if (isPhone && viewMode === 'split') setViewMode('edit')
  }, [isPhone, viewMode])

  const filteredTree = useMemo(() => filterTree(tree, fileQuery), [tree, fileQuery])
  const hasFilter = fileQuery.trim().length > 0

  useEffect(() => {
    localStorage.setItem(
      UI_STORAGE_KEY,
      JSON.stringify({ sidebarWidth, sidebarOpen, splitRatio, fontFamily, fontSize }),
    )
  }, [sidebarWidth, sidebarOpen, splitRatio, fontFamily, fontSize])

  useEffect(() => {
    document.documentElement.style.setProperty('--font-content', cssFontFamily(fontFamily))
  }, [fontFamily])

  useEffect(() => {
    document.documentElement.style.setProperty('--font-content-size', `${fontSize}px`)
  }, [fontSize])

  const bumpFontSize = useCallback((delta: number) => {
    setFontSize((current) => clampFontSize(current + delta))
  }, [])

  const clearPeekTimer = () => {
    if (peekTimerRef.current !== null) {
      window.clearTimeout(peekTimerRef.current)
      peekTimerRef.current = null
    }
  }

  const toggleSidebar = useCallback(() => {
    const now = Date.now()
    if (now - lastToggleAtRef.current < 80) return
    lastToggleAtRef.current = now
    clearPeekTimer()
    setSidebarPeeking(false)
    setSidebarOpen((open) => !open)
    if (!sidebarOpenRef.current) {
      setSidebarWidth(lastSidebarWidthRef.current)
    }
  }, [])

  const focusFileSearch = useCallback(() => {
    clearPeekTimer()
    setSidebarPeeking(false)
    setSidebarOpen(true)
    window.setTimeout(() => {
      searchInputRef.current?.focus()
      searchInputRef.current?.select()
    }, 60)
  }, [])

  const toggleGlobalSearch = useCallback(() => {
    const now = Date.now()
    if (now - lastSearchToggleRef.current < 120) return
    lastSearchToggleRef.current = now
    if (!rootPathRef.current) {
      setStatus('请先打开文件夹')
      return
    }
    setGlobalSearchOpen((open) => !open)
  }, [])

  const openFind = useCallback(() => {
    const editorVisible = viewMode === 'edit' || viewMode === 'split'
    const previewVisible = viewMode === 'preview' || viewMode === 'split'
    if (previewVisible && (!editorVisible || findTarget === 'preview')) {
      previewRef.current?.openFind()
      return
    }
    editorRef.current?.openSearch()
  }, [viewMode, findTarget])

  const findStep = useCallback(
    (dir: 'next' | 'prev') => {
      const editorVisible = viewMode === 'edit' || viewMode === 'split'
      const previewVisible = viewMode === 'preview' || viewMode === 'split'
      const usePreview = previewVisible && (!editorVisible || findTarget === 'preview')
      if (usePreview) {
        if (dir === 'next') previewRef.current?.findNext()
        else previewRef.current?.findPrev()
        return
      }
      if (dir === 'next') editorRef.current?.findNext()
      else editorRef.current?.findPrev()
    },
    [viewMode, findTarget],
  )

  const persistSession = useCallback(
    (next?: {
      rootPath?: string | null
      expandedPaths?: Set<string>
      activePath?: string | null
    }) => {
      const root = next?.rootPath !== undefined ? next.rootPath : rootPathRef.current
      if (!root) {
        clearSession()
        return
      }
      writeSession({
        rootPath: root,
        expandedPaths: [
          ...(next?.expandedPaths ?? expandedPathsRef.current),
        ],
        activePath:
          next?.activePath !== undefined ? next.activePath : activePathRef.current,
      })
    },
    [],
  )

  const refreshTree = useCallback(async (dir: string) => {
    const result = await window.tigermark.readDirectory(dir)
    if (!result.ok || !result.data) {
      setStatus(result.error ?? '读取目录失败')
      return null
    }
    setTree(result.data)
    setLibraryVersion((version) => version + 1)
    return result.data
  }, [])

  const toggleExpand = useCallback(
    (dirPath: string) => {
      setExpandedPaths((prev) => {
        const next = new Set(prev)
        if (next.has(dirPath)) next.delete(dirPath)
        else next.add(dirPath)
        persistSession({ expandedPaths: next })
        return next
      })
    },
    [persistSession],
  )

  const openDirectory = useCallback(async () => {
    if (window.tigermark.isRemote) {
      const result = await window.tigermark.openDirectory()
      if (!result.ok || !result.data) {
        setStatus(result.error ?? '桌面端尚未打开文件夹')
        return
      }
      setRemoteName(window.tigermark.workspaceName ?? null)
      await refreshTree(result.data)
      setRootPath(result.data)
      setStatus(window.tigermark.workspaceName ? `已连接：${window.tigermark.workspaceName}` : '已连接桌面工作区')
      return
    }
    if (!(await confirmUnsavedRef.current())) return
    const result = await window.tigermark.openDirectory()
    if (!result.ok) {
      setStatus(result.error ?? '打开目录失败')
      return
    }
    if (!result.data) return
    const entries = await refreshTree(result.data)
    const nextExpanded = new Set(entries ? topLevelDirPaths(entries) : [])
    setRootPath(result.data)
    rootPathRef.current = result.data
    setActivePath(null)
    setContent('')
    setDirty(false)
    setFileQuery('')
    setExpandedPaths(nextExpanded)
    persistSession({
      rootPath: result.data,
      expandedPaths: nextExpanded,
      activePath: null,
    })
    setStatus(`已打开：${result.data}`)
  }, [persistSession, refreshTree])

  const openFile = useCallback(
    async (filePath: string, options?: { skipUnsavedCheck?: boolean }) => {
      if (
        !options?.skipUnsavedCheck &&
        dirtyRef.current &&
        activePathRef.current !== filePath
      ) {
        if (!(await confirmUnsavedRef.current())) return false
      }
      const result = await window.tigermark.readFile(filePath)
      if (!result.ok || result.data === undefined) {
        setStatus(result.error ?? '读取文件失败')
        return false
      }
      setActivePath(filePath)
      setContent(result.data)
      setDirty(false)
      persistSession({ activePath: filePath })
      if (!sidebarOpenRef.current) setSidebarPeeking(false)
      if (phoneRef.current) setSidebarOpen(false)
      return true
    },
    [persistSession],
  )

  const openGlobalMatch = useCallback(
    async (match: { path: string; line: number | null; query: string }) => {
      setGlobalSearchOpen(false)
      const board = isBoardPath(match.path)
      const jump =
        !board && match.line
          ? { path: match.path, line: match.line, query: match.query }
          : null
      jumpRef.current = jump
      if (!board && jump && viewModeRef.current === 'preview') setViewMode('split')
      if (pathsEqual(activePathRef.current, match.path)) {
        if (jump && editorRef.current) {
          editorRef.current.revealMatch(jump.line, jump.query)
          jumpRef.current = null
        }
        return
      }
      const opened = await openFile(match.path)
      if (!opened) jumpRef.current = null
    },
    [openFile],
  )

  useEffect(() => {
    const jump = jumpRef.current
    if (!jump || !activePath || !pathsEqual(jump.path, activePath) || isBoardPath(activePath)) return
    const frame = window.requestAnimationFrame(() => {
      if (!editorRef.current) return
      editorRef.current.revealMatch(jump.line, jump.query)
      if (jumpRef.current === jump) jumpRef.current = null
    })
    return () => window.cancelAnimationFrame(frame)
  }, [activePath, content, viewMode])

  const saveFile = useCallback(async () => {
    const path = activePathRef.current
    if (!path || savingRef.current) return false
    savingRef.current = true
    const snapshot = contentRef.current
    try {
      const result = await window.tigermark.writeFile(path, snapshot)
      if (!result.ok) {
        setStatus(result.error ?? '保存失败')
        return false
      }
      if (contentRef.current === snapshot) setDirty(false)
      setLibraryVersion((version) => version + 1)
      setStatus(`已保存 · ${basename(path)}`)
      return true
    } finally {
      savingRef.current = false
    }
  }, [])

  const persistOpenFile = useCallback(async () => {
    if (!dirtyRef.current || !activePathRef.current) return true
    const started = Date.now()
    while (savingRef.current && Date.now() - started < 5000) {
      await new Promise((resolve) => window.setTimeout(resolve, 40))
    }
    if (!dirtyRef.current) return true
    return saveFile()
  }, [saveFile])

  const confirmUnsaved = useCallback(async () => {
    if (!dirtyRef.current) return true
    if (leaveResolverRef.current) return false
    const choice = await new Promise<'save' | 'discard' | 'cancel'>((resolve) => {
      leaveResolverRef.current = resolve
      setLeavePrompt(true)
    })
    if (choice === 'cancel') return false
    if (choice === 'save') return saveFile()
    return true
  }, [saveFile])
  confirmUnsavedRef.current = confirmUnsaved

  const resolveLeave = (choice: 'save' | 'discard' | 'cancel') => {
    setLeavePrompt(false)
    const resolve = leaveResolverRef.current
    leaveResolverRef.current = null
    resolve?.(choice)
  }

  const handleContentChange = useCallback((value: string) => {
    setContent(value)
    setDirty(true)
  }, [])

  const handlePasteImage = useCallback(
    async (file: File) => {
      const mdPath = activePathRef.current
      if (!mdPath) {
        setStatus('请先打开一个 Markdown 文件再粘贴图片')
        return null
      }
      const bytes = await file.arrayBuffer()
      const result = await window.tigermark.saveImage(
        mdPath,
        bytes,
        file.type || 'image/png',
      )
      if (!result.ok || !result.data) {
        setStatus(result.error ?? '保存图片失败')
        return null
      }
      setStatus(`已插入图片 · ${result.data.relativePath}`)
      return result.data.relativePath
    },
    [],
  )

  const createFile = useCallback((dirPath: string) => {
    setNamePrompt({ kind: 'createFile', dirPath })
  }, [])

  const createFolder = useCallback((dirPath: string) => {
    setNamePrompt({ kind: 'createFolder', dirPath })
  }, [])

  const renameEntry = useCallback((entry: FileEntry) => {
    setNamePrompt({ kind: 'rename', entry })
  }, [])

  const deleteEntry = useCallback(
    async (entry: FileEntry) => {
      const label = entry.isDirectory ? '文件夹' : '文件'
      if (!window.confirm(`确定删除${label}「${entry.name}」？`)) return
      const result = await window.tigermark.deletePath(entry.path)
      if (!result.ok) {
        setStatus(result.error ?? '删除失败')
        return
      }
      const closedActive =
        activePathRef.current === entry.path ||
        activePathRef.current?.startsWith(entry.path + '/') ||
        activePathRef.current?.startsWith(entry.path + '\\')
      if (closedActive) {
        setActivePath(null)
        setContent('')
        setDirty(false)
      }
      setExpandedPaths((prev) => {
        const next = new Set(
          [...prev].filter(
            (p) => p !== entry.path && !p.startsWith(entry.path + '/') && !p.startsWith(entry.path + '\\'),
          ),
        )
        persistSession({
          expandedPaths: next,
          activePath: closedActive ? null : activePathRef.current,
        })
        return next
      })
      if (rootPath) await refreshTree(rootPath)
      setStatus(`已删除 ${entry.name}`)
    },
    [persistSession, refreshTree, rootPath],
  )

  const revealInFolder = useCallback(async (entry: FileEntry) => {
    const result = await window.tigermark.showItemInFolder(entry.path)
    if (!result.ok) {
      setStatus(result.error ?? '无法打开所在位置')
    }
  }, [])

  const handleNameConfirm = useCallback(
    async (prompt: NamePrompt, name: string) => {
      setNamePrompt(null)

      if (prompt.kind === 'createFile') {
        if (!(await confirmUnsavedRef.current())) return
        const fileName = prompt.board && !name.toLowerCase().endsWith('.board.json')
          ? `${name}.board.json`
          : name
        const result = await window.tigermark.createFile(prompt.dirPath, fileName)
        if (!result.ok || !result.data) {
          setStatus(result.error ?? '创建文件失败')
          return
        }
        setExpandedPaths((prev) => {
          const next = new Set(prev)
          next.add(prompt.dirPath)
          persistSession({ expandedPaths: next })
          return next
        })
        if (rootPath) await refreshTree(rootPath)
        await openFile(result.data, { skipUnsavedCheck: true })
        return
      }

      if (prompt.kind === 'createFolder') {
        const result = await window.tigermark.createDirectory(prompt.dirPath, name)
        if (!result.ok) {
          setStatus(result.error ?? '创建文件夹失败')
          return
        }
        setExpandedPaths((prev) => {
          const next = new Set(prev)
          next.add(prompt.dirPath)
          persistSession({ expandedPaths: next })
          return next
        })
        if (rootPath) await refreshTree(rootPath)
        setStatus(`已创建文件夹 ${name}`)
        return
      }

      if (name === prompt.entry.name) return
      const oldPath = prompt.entry.path
      const result = await window.tigermark.renamePath(oldPath, name)
      if (!result.ok || !result.data) {
        setStatus(result.error ?? '重命名失败')
        return
      }
      const newPath = result.data

      let nextExpanded = expandedPathsRef.current
      if (prompt.entry.isDirectory) {
        nextExpanded = new Set<string>()
        for (const p of expandedPathsRef.current) {
          if (p === oldPath) nextExpanded.add(newPath)
          else if (p.startsWith(oldPath + '/') || p.startsWith(oldPath + '\\')) {
            nextExpanded.add(newPath + p.slice(oldPath.length))
          } else {
            nextExpanded.add(p)
          }
        }
        setExpandedPaths(nextExpanded)
      }

      let nextActive = activePathRef.current
      if (activePathRef.current === oldPath) {
        nextActive = newPath
        setActivePath(newPath)
      } else if (
        activePathRef.current?.startsWith(oldPath + '/') ||
        activePathRef.current?.startsWith(oldPath + '\\')
      ) {
        nextActive = newPath + activePathRef.current.slice(oldPath.length)
        setActivePath(nextActive)
      }

      persistSession({
        expandedPaths: nextExpanded,
        activePath: nextActive,
      })
      if (rootPath) await refreshTree(rootPath)
      setStatus(`已重命名为 ${name}`)
    },
    [openFile, persistSession, refreshTree, rootPath],
  )

  const loadRemoteWorkspace = useCallback(async () => {
    const result = await window.tigermark.openDirectory()
    if (!result.ok || !result.data) {
      setRootPath(null)
      setTree([])
      setActivePath(null)
      setContent('')
      setDirty(false)
      setRemoteName(null)
      setStatus(result.error ?? '等待桌面端打开文件夹')
      return
    }
    const name = window.tigermark.workspaceName ?? null
    setRemoteName(name)
    const entries = await refreshTree(result.data)
    if (!entries) return
    setRootPath(result.data)
    setStatus(name ? `已连接：${name}` : '已连接桌面工作区')
    const session = readSession()
    if (session?.rootPath === result.data) {
      setExpandedPaths(new Set(session.expandedPaths))
      if (session.activePath && !dirtyRef.current) {
        const file = await window.tigermark.readFile(session.activePath)
        if (file.ok && file.data !== undefined) {
          setActivePath(session.activePath)
          setContent(file.data)
          setDirty(false)
        }
      }
    }
    persistSession({ rootPath: result.data })
  }, [persistSession, refreshTree])

  useEffect(() => {
    if (sessionReadyRef.current) return
    sessionReadyRef.current = true

    if (window.tigermark.isRemote) {
      void loadRemoteWorkspace().finally(() => setSessionSettled(true))
      return
    }

    const session = readSession()
    if (!session) {
      setSessionSettled(true)
      return
    }

    void (async () => {
      const entries = await refreshTree(session.rootPath)
      if (!entries) {
        clearSession()
        setStatus('上次打开的目录已失效，请重新选择')
        setSessionSettled(true)
        return
      }
      setRootPath(session.rootPath)
      setExpandedPaths(new Set(session.expandedPaths))

      if (session.activePath) {
        const result = await window.tigermark.readFile(session.activePath)
        if (result.ok && result.data !== undefined) {
          setActivePath(session.activePath)
          setContent(result.data)
          setDirty(false)
        } else {
          persistSession({
            rootPath: session.rootPath,
            expandedPaths: new Set(session.expandedPaths),
            activePath: null,
          })
        }
      }
      setSessionSettled(true)
    })()
  }, [loadRemoteWorkspace, persistSession, refreshTree])

  useEffect(() => {
    if (!sessionSettled || window.tigermark.isRemote) return
    void window.tigermark.setSyncWorkspace(rootPath)
  }, [sessionSettled, rootPath])

  useEffect(() => {
    if (window.tigermark.isRemote) {
      setSyncPeers(1)
      return
    }
    let stop = false
    const tick = async () => {
      const info = await window.tigermark.getSyncInfo()
      if (stop || !info) return
      setSyncPeers((current) => (current === info.clients ? current : info.clients))
    }
    void tick()
    const timer = window.setInterval(() => void tick(), 2000)
    return () => {
      stop = true
      window.clearInterval(timer)
    }
  }, [])

  useEffect(() => {
    if (!dirty || !activePath) return
    if (!window.tigermark.isRemote && syncPeers < 1 && !linked) return
    const timer = window.setTimeout(() => {
      void saveFile()
    }, 1000)
    return () => window.clearTimeout(timer)
  }, [dirty, content, activePath, syncPeers, linked, saveFile])

  useEffect(() => {
    const toAbsolute = (rel: string) => joinWorkspacePath(rootPathRef.current ?? '.', rel)
    return window.tigermark.onSync((event) => {
      if (!window.tigermark.isRemote && event.origin === 'desktop') return
      if (window.tigermark.isRemote && event.origin !== 'desktop' && event.kind !== 'workspace') {
        const own = sessionStorage.getItem('tigermark.clientId')
        if (own && event.origin === own) return
      }
      if (event.kind === 'reload') {
        const root = rootPathRef.current
        if (!root) return
        void (async () => {
          await refreshTree(root)
          const active = activePathRef.current
          if (active) await openFile(active, { skipUnsavedCheck: true })
        })()
        return
      }
      if (event.kind === 'workspace') {
        if (window.tigermark.isRemote) void loadRemoteWorkspace()
        return
      }
      const root = rootPathRef.current
      if (!root) return
      if (event.kind === 'tree') {
        void refreshTree(root)
        return
      }
      if (event.kind === 'delete' && event.path) {
        const target = toAbsolute(event.path)
        const active = activePathRef.current
        if (active && (pathsEqual(active, target) || isInsidePath(target, active))) {
          setActivePath(null)
          setContent('')
          setDirty(false)
          persistSession({ activePath: null })
        }
        void refreshTree(root)
        return
      }
      if (event.kind === 'rename' && event.from && event.path) {
        const from = toAbsolute(event.from)
        const next = toAbsolute(event.path)
        const active = activePathRef.current
        if (active && pathsEqual(active, from)) {
          setActivePath(next)
          persistSession({ activePath: next })
        } else if (active && isInsidePath(from, active)) {
          const suffix = active.replace(/\\/g, '/').slice(from.replace(/\\/g, '/').length)
          const joined = `${next.replace(/\\/g, '/')}${suffix}`
          const useBackslash = (rootPathRef.current ?? '').includes('\\')
          const restored = useBackslash ? joined.replace(/\//g, '\\') : joined
          setActivePath(restored)
          persistSession({ activePath: restored })
        }
        void refreshTree(root)
        return
      }
      if (event.kind === 'write' && event.path) {
        setLibraryVersion((version) => version + 1)
        if (!dirtyRef.current) {
          const target = toAbsolute(event.path)
          if (pathsEqual(activePathRef.current, target)) {
            void openFile(target, { skipUnsavedCheck: true })
          }
        }
      }
    })
  }, [loadRemoteWorkspace, openFile, persistSession, refreshTree])

  useEffect(() => {
    if (!sessionSettled || window.tigermark.isRemote) return
    let stop = false
    let busy = false
    let lastError = ''
    const tick = async () => {
      if (stop || busy) return
      const info = await window.tigermark.getSyncInfo()
      if (stop) return
      if (!info || info.sharing) {
        setLinked(false)
        return
      }
      if (!rootPathRef.current && window.tigermark.platform === 'android') {
        await openDirectory()
      }
      const root = rootPathRef.current
      if (!root) return
      const peers = await window.tigermark.discoverSync()
      const peer = peers[0]
      if (!peer) return
      busy = true
      try {
        await window.tigermark.setSyncWorkspace(root)
        const result = await window.tigermark.followSync(peer)
        if (stop) return
        if (!result.ok || !result.data) {
          const message = result.error ?? '同步失败'
          if (message !== lastError) {
            lastError = message
            setStatus(message)
          }
          setLinked(false)
          return
        }
        lastError = ''
        setLinked(true)
        if (result.data.pulled) {
          const from = result.data.name || peer.name
          setStatus(from ? `已从「${from}」同步 ${result.data.files} 个文件` : '已同步笔记')
        }
      } finally {
        busy = false
      }
    }
    void tick()
    const timer = window.setInterval(() => void tick(), 2000)
    return () => {
      stop = true
      window.clearInterval(timer)
    }
  }, [openDirectory, sessionSettled, setStatus])

  useEffect(() => {
    if (!window.tigermark?.onMenuOpenDirectory) return
    const offOpen = window.tigermark.onMenuOpenDirectory(openDirectory)
    const offSave = window.tigermark.onMenuSave(saveFile)
    const offView = window.tigermark.onMenuViewMode((mode) => {
      if (mode === 'edit' || mode === 'split' || mode === 'preview') {
        setViewMode(mode)
      }
    })
    const offSidebar = window.tigermark.onMenuToggleSidebar?.(toggleSidebar)
    const offFind = window.tigermark.onMenuFind?.(openFind)
    const offFindInFiles = window.tigermark.onMenuFindInFiles?.(toggleGlobalSearch)
    return () => {
      offOpen()
      offSave()
      offView()
      offSidebar?.()
      offFind?.()
      offFindInFiles?.()
    }
  }, [openDirectory, saveFile, toggleSidebar, openFind, toggleGlobalSearch])

  useEffect(() => {
    const onCloseRequest = () => {
      void (async () => {
        const ok = await persistOpenFile()
        if (ok) window.tigermark.allowClose()
        else window.tigermark.denyClose()
      })()
    }
    const offClose = window.tigermark?.onCloseRequest?.(onCloseRequest)

    const onHideRequest = () => {
      void (async () => {
        await persistOpenFile()
        window.tigermark.hideWindow()
      })()
    }
    const offHide = window.tigermark?.onHideRequest?.(onHideRequest)

    const onQuitRequest = () => {
      void (async () => {
        const ok = await persistOpenFile()
        if (ok) window.tigermark.quit()
      })()
    }
    const offQuit = window.tigermark?.onQuitRequest?.(onQuitRequest)

    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!dirtyRef.current) return
      e.preventDefault()
      e.returnValue = ''
    }
    if (!window.tigermark?.onCloseRequest) {
      window.addEventListener('beforeunload', onBeforeUnload)
    }

    return () => {
      offClose?.()
      offHide?.()
      offQuit?.()
      window.removeEventListener('beforeunload', onBeforeUnload)
    }
  }, [persistOpenFile])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void saveFile()
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'p') {
        e.preventDefault()
        if (globalSearchOpenRef.current) return
        focusFileSearch()
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b') {
        e.preventDefault()
        toggleSidebar()
      }
      if ((e.metaKey || e.ctrlKey) && (e.key === '=' || e.key === '+')) {
        e.preventDefault()
        bumpFontSize(1)
      }
      if ((e.metaKey || e.ctrlKey) && e.key === '-') {
        e.preventDefault()
        bumpFontSize(-1)
      }
      if ((e.metaKey || e.ctrlKey) && e.key === '0') {
        e.preventDefault()
        setFontSize(DEFAULT_FONT_SIZE)
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        if (e.shiftKey) toggleGlobalSearch()
        else if (!globalSearchOpenRef.current) openFind()
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'g') {
        e.preventDefault()
        if (globalSearchOpenRef.current) return
        findStep(e.shiftKey ? 'prev' : 'next')
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [saveFile, focusFileSearch, toggleSidebar, bumpFontSize, openFind, findStep, toggleGlobalSearch])

  const onResizeStart = (e: { preventDefault(): void; clientX: number }) => {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = sidebarWidth
    setIsResizing(true)
    setSidebarPeeking(false)
    const onMove = (ev: MouseEvent) => {
      const raw = startWidth + ev.clientX - startX
      setSidebarWidth(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, raw)))
    }
    const onUp = (ev: MouseEvent) => {
      const raw = startWidth + ev.clientX - startX
      setIsResizing(false)
      if (raw < SIDEBAR_COLLAPSE) {
        lastSidebarWidthRef.current = startWidth
        setSidebarWidth(startWidth)
        setSidebarOpen(false)
      } else {
        const next = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, raw))
        lastSidebarWidthRef.current = next
        setSidebarWidth(next)
      }
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const onSplitResizeStart = (e: { preventDefault(): void }) => {
    e.preventDefault()
    if (!panesRef.current) return
    setIsSplitResizing(true)
    const onMove = (ev: MouseEvent) => {
      const box = panesRef.current?.getBoundingClientRect()
      if (!box || box.width <= 0) return
      const next = (ev.clientX - box.left) / box.width
      setSplitRatio(Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, next)))
    }
    const onUp = () => {
      setIsSplitResizing(false)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const onSidebarEnter = () => {
    if (sidebarOpen) return
    clearPeekTimer()
    setSidebarPeeking(true)
  }

  const onSidebarLeave = () => {
    if (sidebarOpen) return
    clearPeekTimer()
    peekTimerRef.current = window.setTimeout(() => {
      setSidebarPeeking(false)
      peekTimerRef.current = null
    }, 280)
  }

  const sidebarVisible = sidebarOpen || (!isPhone && sidebarPeeking)
  const showEditor = viewMode === 'edit' || viewMode === 'split'
  const showPreview = viewMode === 'preview' || viewMode === 'split'
  const boardActive = Boolean(activePath && isBoardPath(activePath))
  const folderLabel = rootPath ? remoteName || (rootPath === '.' ? '工作区' : basename(rootPath)) : null

  return (
    <div className={`app${isMac ? ' is-mac' : ''}${isPhone ? ' is-phone' : ''}${isRemote ? ' is-remote' : ''}`}>
      <Toolbar
        isMac={isMac}
        fileName={activePath ? basename(activePath).replace(/\.board\.json$/i, '') : null}
        folderName={folderLabel}
        dirty={dirty}
        viewMode={viewMode}
        theme={theme}
        canSave={Boolean(activePath)}
        sidebarOpen={sidebarOpen}
        onToggleSidebar={toggleSidebar}
        onOpenFolder={openDirectory}
        onSave={() => void saveFile()}
        onViewModeChange={setViewMode}
        onThemeChange={setTheme}
        onNewFile={() => {
          if (!rootPath) {
            setStatus('请先打开文件夹')
            return
          }
          void createFile(rootPath)
        }}
        onCommandCenter={() => {
          if (!rootPath) {
            void openDirectory()
            return
          }
          focusFileSearch()
        }}
        searchOpen={globalSearchOpen}
        onGlobalSearch={toggleGlobalSearch}
        fontFamily={fontFamily}
        onFontChange={setFontFamily}
        fontSize={fontSize}
        onFontSizeChange={(size) => setFontSize(clampFontSize(size))}
        isRemote={isRemote}
        syncPeers={syncPeers}
        boardActive={boardActive}
        onNewBoard={() => {
          if (!rootPath) {
            setStatus('请先打开文件夹')
            return
          }
          setNamePrompt({ kind: 'createFile', dirPath: rootPath, board: true })
        }}
        onOpenSync={() => setSyncOpen(true)}
      />

      <div className={`workspace${isResizing ? ' is-resizing' : ''}${sidebarOpen ? '' : ' sidebar-closed'}`}>
        {!sidebarOpen && !isPhone && (
          <div
            className="sidebar-hotzone"
            onMouseEnter={onSidebarEnter}
          />
        )}
        {isPhone && sidebarOpen && (
          <button
            type="button"
            className="sidebar-backdrop"
            aria-label="关闭侧边栏"
            onClick={() => setSidebarOpen(false)}
          />
        )}

        <div
          className={`sidebar-shell${sidebarOpen ? '' : sidebarPeeking ? ' is-overlay' : ' is-collapsed'}`}
          onMouseEnter={isPhone ? undefined : onSidebarEnter}
          onMouseLeave={isPhone ? undefined : onSidebarLeave}
        >
          <aside
            className="sidebar"
            style={{ width: sidebarVisible ? sidebarWidth : 0 }}
          >
            <div className="sidebar-header">
              <span className="sidebar-title">
                {folderLabel ?? '未打开目录'}
              </span>
              <div className="sidebar-actions">
                <button
                  type="button"
                  className="icon-btn"
                  title="打开文件夹"
                  onClick={() => void openDirectory()}
                >
                  <IconFolder />
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  title="新建文件"
                  disabled={!rootPath}
                  onClick={() => rootPath && void createFile(rootPath)}
                >
                  <IconNewFile />
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  title="新建文件夹"
                  disabled={!rootPath}
                  onClick={() => rootPath && void createFolder(rootPath)}
                >
                  <IconNewFolder />
                </button>
              </div>
            </div>

          {rootPath && (
            <div className="sidebar-search">
              <input
                ref={searchInputRef}
                className="sidebar-search-input"
                type="search"
                value={fileQuery}
                placeholder={
                  isPhone ? '搜索文件' : isMac ? '搜索文件… ⌘P' : '搜索文件… Ctrl+P'
                }
                aria-label="搜索文件"
                onChange={(e) => setFileQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    if (fileQuery) setFileQuery('')
                    else e.currentTarget.blur()
                  }
                }}
              />
              <button
                type="button"
                className="sidebar-search-global"
                title={isMac ? '全文搜索（⌘⇧F）' : '全文搜索（Ctrl+Shift+F）'}
                onClick={toggleGlobalSearch}
              >
                全文
              </button>
            </div>
          )}

          <div className="sidebar-body">
            {rootPath ? (
              hasFilter && filteredTree.length === 0 ? (
                <div className="sidebar-empty-filter">未找到匹配文件</div>
              ) : (
                <FileTree
                  entries={filteredTree}
                  activePath={activePath}
                  onOpenFile={openFile}
                  onCreateFile={createFile}
                  onCreateFolder={createFolder}
                  onDelete={deleteEntry}
                  onRename={renameEntry}
                  onReveal={(entry) => void revealInFolder(entry)}
                  revealLabel={
                    isRemote ? '' : revealInFolderLabel(window.tigermark?.platform ?? '')
                  }
                  expandedPaths={expandedPaths}
                  onToggleExpand={toggleExpand}
                  expandAll={hasFilter}
                />
              )
            ) : (
              <div className="empty-sidebar">
                <p>{isRemote ? '等待桌面端打开文件夹' : '打开本地文件夹'}</p>
                <button type="button" className="primary-btn" onClick={() => void openDirectory()}>
                  {isRemote ? '重新连接' : '选择目录'}
                </button>
              </div>
            )}
          </div>
        </aside>

        {sidebarVisible && (
          <div
            className={`resizer${isResizing ? ' is-resizing' : ''}`}
            role="separator"
            aria-orientation="vertical"
            aria-label="调整侧栏宽度"
            onMouseDown={onResizeStart}
            onDoubleClick={toggleSidebar}
          >
            <span className="resizer-grip" aria-hidden="true" />
          </div>
        )}
        </div>

        <main
          className="editor-area"
          onMouseDown={() => {
            if (!sidebarOpen) setSidebarPeeking(false)
          }}
        >
          {activePath && boardActive ? (
            <Whiteboard
              key={activePath}
              value={content}
              theme={resolvedTheme}
              onChange={handleContentChange}
            />
          ) : activePath ? (
            <div
              ref={panesRef}
              className={`panes panes-${viewMode}${isSplitResizing ? ' is-resizing' : ''}`}
            >
              {showEditor && (
                <section
                  className="pane editor-pane"
                  style={
                    viewMode === 'split'
                      ? { flex: `0 0 ${splitRatio * 100}%` }
                      : undefined
                  }
                  onFocusCapture={() => setFindTarget('editor')}
                >
                  <MarkdownEditor
                    key={activePath}
                    ref={editorRef}
                    value={content}
                    theme={resolvedTheme}
                    onChange={handleContentChange}
                    onPasteImage={handlePasteImage}
                    onMessage={setStatus}
                  />
                </section>
              )}
              {viewMode === 'split' && (
                <div
                  className={`resizer pane-resizer${isSplitResizing ? ' is-resizing' : ''}`}
                  role="separator"
                  aria-orientation="vertical"
                  aria-label="调整编辑与预览宽度"
                  onMouseDown={onSplitResizeStart}
                  onDoubleClick={() => setSplitRatio(0.5)}
                >
                  <span className="resizer-grip" aria-hidden="true" />
                </div>
              )}
              {showPreview && (
                <section
                  className="pane preview-pane"
                  onFocusCapture={() => setFindTarget('preview')}
                  onMouseDown={() => setFindTarget('preview')}
                >
                  <MarkdownPreview
                    ref={previewRef}
                    content={content}
                    baseDir={dirname(activePath)}
                  />
                </section>
              )}
            </div>
          ) : (
            <div className="empty-editor">
              <h1>TigerMark</h1>
              <p>
                {isRemote
                  ? '连接桌面端后，在这里查看和编辑同一份笔记'
                  : '左侧打开目录，选择 Markdown 文件开始写作'}
              </p>
              {!isPhone && !isRemote && (
              <div className="hint-row">
                <kbd>⌘/Ctrl</kbd>+<kbd>B</kbd> 侧边栏
                <span>·</span>
                <kbd>⌘/Ctrl</kbd>+<kbd>P</kbd> 搜索文件
                <span>·</span>
                <kbd>⌘/Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>F</kbd> 全文搜索
                <span>·</span>
                <kbd>⌘/Ctrl</kbd>+<kbd>F</kbd> 查找
                <span>·</span>
                <kbd>⌘/Ctrl</kbd>+<kbd>S</kbd> 保存
                <span>·</span>
                <kbd>⌘/Ctrl</kbd>+<kbd>1/2/3</kbd> 切换视图
              </div>
              )}
            </div>
          )}
        </main>
      </div>

      {namePrompt?.kind === 'createFile' && (
        <NameDialog
          title={namePrompt.board ? '新建白板' : '新建文件'}
          label={namePrompt.board ? '白板名称' : '文件名（可省略 .md）'}
          defaultValue={namePrompt.board ? '白板' : 'untitled'}
          confirmLabel="创建"
          onConfirm={(name) => void handleNameConfirm(namePrompt, name)}
          onCancel={() => setNamePrompt(null)}
        />
      )}
      {namePrompt?.kind === 'createFolder' && (
        <NameDialog
          title="新建文件夹"
          label="文件夹名"
          defaultValue="new-folder"
          confirmLabel="创建"
          onConfirm={(name) => void handleNameConfirm(namePrompt, name)}
          onCancel={() => setNamePrompt(null)}
        />
      )}
      {namePrompt?.kind === 'rename' && (
        <NameDialog
          title="重命名"
          label="新名称"
          defaultValue={namePrompt.entry.name}
          confirmLabel="重命名"
          onConfirm={(name) => void handleNameConfirm(namePrompt, name)}
          onCancel={() => setNamePrompt(null)}
        />
      )}
      {syncOpen && <SyncDialog onClose={() => setSyncOpen(false)} />}
      {rootPath && (
        <GlobalSearch
          open={globalSearchOpen}
          rootPath={rootPath}
          libraryVersion={libraryVersion}
          tree={tree}
          activePath={activePath}
          activeContent={content}
          activeDirty={dirty}
          onClose={() => setGlobalSearchOpen(false)}
          onOpenMatch={(match) => void openGlobalMatch(match)}
        />
      )}
      {leavePrompt && (
        <ConfirmLeaveDialog
          fileName={activePath ? basename(activePath) : '未命名文件'}
          onSave={() => resolveLeave('save')}
          onDiscard={() => resolveLeave('discard')}
          onCancel={() => resolveLeave('cancel')}
        />
      )}
      {toast && (
        <div key={toast.id} className="toast" role="status">
          {toast.text}
        </div>
      )}
    </div>
  )
}
