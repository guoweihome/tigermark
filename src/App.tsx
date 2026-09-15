import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FileEntry, ViewMode } from './vite-env'
import { ConfirmLeaveDialog } from './components/ConfirmLeaveDialog'
import { FileTree } from './components/FileTree'
import { MarkdownEditor } from './components/MarkdownEditor'
import { MarkdownPreview } from './components/MarkdownPreview'
import { NameDialog } from './components/NameDialog'
import { IconFolder, IconNewFile, IconNewFolder } from './components/icons'
import { Toolbar } from './components/Toolbar'
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
  return index === -1 ? normalized : normalized.slice(0, index)
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
  | { kind: 'createFile'; dirPath: string }
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
  const [, setStatus] = useState('打开一个文件夹开始编辑')
  const [sidebarWidth, setSidebarWidth] = useState(() => readUiPrefs().sidebarWidth)
  const [sidebarOpen, setSidebarOpen] = useState(() => readUiPrefs().sidebarOpen)
  const [sidebarPeeking, setSidebarPeeking] = useState(false)
  const [isResizing, setIsResizing] = useState(false)
  const [splitRatio, setSplitRatio] = useState(() => readUiPrefs().splitRatio)
  const [isSplitResizing, setIsSplitResizing] = useState(false)
  const [fontFamily, setFontFamily] = useState(() => readUiPrefs().fontFamily)
  const [fontSize, setFontSize] = useState(() => readUiPrefs().fontSize)
  const [fileQuery, setFileQuery] = useState('')
  const [namePrompt, setNamePrompt] = useState<NamePrompt | null>(null)
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set())
  const savingRef = useRef(false)
  const searchInputRef = useRef<HTMLInputElement>(null)
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
  const [leavePrompt, setLeavePrompt] = useState(false)
  const isMac = window.tigermark?.platform === 'darwin'

  contentRef.current = content
  activePathRef.current = activePath
  dirtyRef.current = dirty
  rootPathRef.current = rootPath
  expandedPathsRef.current = expandedPaths
  sidebarOpenRef.current = sidebarOpen

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
        if (!(await confirmUnsavedRef.current())) return
      }
      const result = await window.tigermark.readFile(filePath)
      if (!result.ok || result.data === undefined) {
        setStatus(result.error ?? '读取文件失败')
        return
      }
      setActivePath(filePath)
      setContent(result.data)
      setDirty(false)
      setStatus(filePath)
      persistSession({ activePath: filePath })
      if (!sidebarOpenRef.current) setSidebarPeeking(false)
    },
    [persistSession],
  )

  const saveFile = useCallback(async () => {
    const path = activePathRef.current
    if (!path || savingRef.current) return false
    savingRef.current = true
    try {
      const result = await window.tigermark.writeFile(path, contentRef.current)
      if (!result.ok) {
        setStatus(result.error ?? '保存失败')
        return false
      }
      setDirty(false)
      setStatus(`已保存 · ${basename(path)}`)
      return true
    } finally {
      savingRef.current = false
    }
  }, [])

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
        const result = await window.tigermark.createFile(prompt.dirPath, name)
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

  useEffect(() => {
    if (sessionReadyRef.current) return
    sessionReadyRef.current = true

    const session = readSession()
    if (!session) return

    void (async () => {
      const entries = await refreshTree(session.rootPath)
      if (!entries) {
        clearSession()
        setStatus('上次打开的目录已失效，请重新选择')
        return
      }
      setRootPath(session.rootPath)
      setExpandedPaths(new Set(session.expandedPaths))
      setStatus(`已打开：${session.rootPath}`)

      if (session.activePath) {
        const result = await window.tigermark.readFile(session.activePath)
        if (result.ok && result.data !== undefined) {
          setActivePath(session.activePath)
          setContent(result.data)
          setDirty(false)
          setStatus(session.activePath)
        } else {
          persistSession({
            rootPath: session.rootPath,
            expandedPaths: new Set(session.expandedPaths),
            activePath: null,
          })
        }
      }
    })()
  }, [persistSession, refreshTree])

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
    return () => {
      offOpen()
      offSave()
      offView()
      offSidebar?.()
    }
  }, [openDirectory, saveFile, toggleSidebar])

  useEffect(() => {
    const onCloseRequest = () => {
      void (async () => {
        const ok = await confirmUnsavedRef.current()
        if (ok) window.tigermark.allowClose()
        else window.tigermark.denyClose()
      })()
    }
    const offClose = window.tigermark?.onCloseRequest?.(onCloseRequest)

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
      window.removeEventListener('beforeunload', onBeforeUnload)
    }
  }, [])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void saveFile()
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'p') {
        e.preventDefault()
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
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [saveFile, focusFileSearch, toggleSidebar, bumpFontSize])

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

  const sidebarVisible = sidebarOpen || sidebarPeeking
  const showEditor = viewMode === 'edit' || viewMode === 'split'
  const showPreview = viewMode === 'preview' || viewMode === 'split'

  return (
    <div className={`app${isMac ? ' is-mac' : ''}`}>
      <Toolbar
        isMac={isMac}
        fileName={activePath ? basename(activePath) : null}
        folderName={rootPath ? basename(rootPath) : null}
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
        fontFamily={fontFamily}
        onFontChange={setFontFamily}
        fontSize={fontSize}
        onFontSizeChange={(size) => setFontSize(clampFontSize(size))}
      />

      <div className={`workspace${isResizing ? ' is-resizing' : ''}${sidebarOpen ? '' : ' sidebar-closed'}`}>
        {!sidebarOpen && (
          <div
            className="sidebar-hotzone"
            onMouseEnter={onSidebarEnter}
          />
        )}

        <div
          className={`sidebar-shell${sidebarOpen ? '' : sidebarPeeking ? ' is-overlay' : ' is-collapsed'}`}
          onMouseEnter={onSidebarEnter}
          onMouseLeave={onSidebarLeave}
        >
          <aside
            className="sidebar"
            style={{ width: sidebarVisible ? sidebarWidth : 0 }}
          >
            <div className="sidebar-header">
              <span className="sidebar-title">
                {rootPath ? basename(rootPath) : '未打开目录'}
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
                placeholder={isMac ? '搜索文件… ⌘P' : '搜索文件… Ctrl+P'}
                aria-label="搜索文件"
                onChange={(e) => setFileQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    if (fileQuery) setFileQuery('')
                    else e.currentTarget.blur()
                  }
                }}
              />
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
                  revealLabel={revealInFolderLabel(window.tigermark?.platform ?? '')}
                  expandedPaths={expandedPaths}
                  onToggleExpand={toggleExpand}
                  expandAll={hasFilter}
                />
              )
            ) : (
              <div className="empty-sidebar">
                <p>打开本地文件夹</p>
                <button type="button" className="primary-btn" onClick={() => void openDirectory()}>
                  选择目录
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
          {activePath ? (
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
                >
                  <MarkdownEditor
                    key={activePath}
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
                <section className="pane preview-pane">
                  <MarkdownPreview content={content} baseDir={dirname(activePath)} />
                </section>
              )}
            </div>
          ) : (
            <div className="empty-editor">
              <h1>TigerMark</h1>
              <p>左侧打开目录，选择 Markdown 文件开始写作</p>
              <div className="hint-row">
                <kbd>⌘/Ctrl</kbd>+<kbd>B</kbd> 侧边栏
                <span>·</span>
                <kbd>⌘/Ctrl</kbd>+<kbd>P</kbd> 搜索文件
                <span>·</span>
                <kbd>⌘/Ctrl</kbd>+<kbd>S</kbd> 保存
                <span>·</span>
                <kbd>⌘/Ctrl</kbd>+<kbd>1/2/3</kbd> 切换视图
              </div>
            </div>
          )}
        </main>
      </div>

      {namePrompt?.kind === 'createFile' && (
        <NameDialog
          title="新建文件"
          label="文件名（可省略 .md）"
          defaultValue="untitled"
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
      {leavePrompt && (
        <ConfirmLeaveDialog
          fileName={activePath ? basename(activePath) : '未命名文件'}
          onSave={() => resolveLeave('save')}
          onDiscard={() => resolveLeave('discard')}
          onCancel={() => resolveLeave('cancel')}
        />
      )}
    </div>
  )
}
