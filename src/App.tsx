import { useCallback, useEffect, useRef, useState } from 'react'
import type { FileEntry, ViewMode } from './vite-env'
import { FileTree } from './components/FileTree'
import { MarkdownEditor } from './components/MarkdownEditor'
import { MarkdownPreview } from './components/MarkdownPreview'
import { Toolbar } from './components/Toolbar'

function basename(filePath: string) {
  return filePath.split(/[/\\]/).pop() ?? filePath
}

export default function App() {
  const [rootPath, setRootPath] = useState<string | null>(null)
  const [tree, setTree] = useState<FileEntry[]>([])
  const [activePath, setActivePath] = useState<string | null>(null)
  const [content, setContent] = useState('')
  const [dirty, setDirty] = useState(false)
  const [viewMode, setViewMode] = useState<ViewMode>('split')
  const [status, setStatus] = useState('打开一个文件夹开始编辑')
  const [sidebarWidth, setSidebarWidth] = useState(260)
  const savingRef = useRef(false)
  const contentRef = useRef(content)
  const activePathRef = useRef(activePath)
  const dirtyRef = useRef(dirty)

  contentRef.current = content
  activePathRef.current = activePath
  dirtyRef.current = dirty

  const refreshTree = useCallback(async (dir: string) => {
    const result = await window.tigermark.readDirectory(dir)
    if (!result.ok || !result.data) {
      setStatus(result.error ?? '读取目录失败')
      return
    }
    setTree(result.data)
  }, [])

  const openDirectory = useCallback(async () => {
    if (dirtyRef.current) {
      const leave = window.confirm('当前文件尚未保存，确定继续？')
      if (!leave) return
    }
    const result = await window.tigermark.openDirectory()
    if (!result.ok) {
      setStatus(result.error ?? '打开目录失败')
      return
    }
    if (!result.data) return
    setRootPath(result.data)
    setActivePath(null)
    setContent('')
    setDirty(false)
    await refreshTree(result.data)
    setStatus(`已打开：${result.data}`)
  }, [refreshTree])

  const openFile = useCallback(async (filePath: string) => {
    if (dirtyRef.current && activePathRef.current !== filePath) {
      const leave = window.confirm('当前文件尚未保存，确定切换？')
      if (!leave) return
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
  }, [])

  const saveFile = useCallback(async () => {
    const path = activePathRef.current
    if (!path || savingRef.current) return
    savingRef.current = true
    try {
      const result = await window.tigermark.writeFile(path, contentRef.current)
      if (!result.ok) {
        setStatus(result.error ?? '保存失败')
        return
      }
      setDirty(false)
      setStatus(`已保存 · ${basename(path)}`)
    } finally {
      savingRef.current = false
    }
  }, [])

  const handleContentChange = useCallback((value: string) => {
    setContent(value)
    setDirty(true)
  }, [])

  const createFile = useCallback(
    async (dirPath: string) => {
      const name = window.prompt('新文件名（可省略 .md）', 'untitled')
      if (!name) return
      const result = await window.tigermark.createFile(dirPath, name)
      if (!result.ok || !result.data) {
        setStatus(result.error ?? '创建文件失败')
        return
      }
      if (rootPath) await refreshTree(rootPath)
      await openFile(result.data)
    },
    [openFile, refreshTree, rootPath],
  )

  const createFolder = useCallback(
    async (dirPath: string) => {
      const name = window.prompt('新文件夹名')
      if (!name) return
      const result = await window.tigermark.createDirectory(dirPath, name)
      if (!result.ok) {
        setStatus(result.error ?? '创建文件夹失败')
        return
      }
      if (rootPath) await refreshTree(rootPath)
    },
    [refreshTree, rootPath],
  )

  const deleteEntry = useCallback(
    async (entry: FileEntry) => {
      const label = entry.isDirectory ? '文件夹' : '文件'
      if (!window.confirm(`确定删除${label}「${entry.name}」？`)) return
      const result = await window.tigermark.deletePath(entry.path)
      if (!result.ok) {
        setStatus(result.error ?? '删除失败')
        return
      }
      if (activePathRef.current === entry.path || activePathRef.current?.startsWith(entry.path + '/')) {
        setActivePath(null)
        setContent('')
        setDirty(false)
      }
      if (rootPath) await refreshTree(rootPath)
      setStatus(`已删除 ${entry.name}`)
    },
    [refreshTree, rootPath],
  )

  const renameEntry = useCallback(
    async (entry: FileEntry) => {
      const name = window.prompt('重命名为', entry.name)
      if (!name || name === entry.name) return
      const result = await window.tigermark.renamePath(entry.path, name)
      if (!result.ok || !result.data) {
        setStatus(result.error ?? '重命名失败')
        return
      }
      if (activePathRef.current === entry.path) {
        setActivePath(result.data)
      }
      if (rootPath) await refreshTree(rootPath)
    },
    [refreshTree, rootPath],
  )

  useEffect(() => {
    if (!window.tigermark?.onMenuOpenDirectory) return
    const offOpen = window.tigermark.onMenuOpenDirectory(openDirectory)
    const offSave = window.tigermark.onMenuSave(saveFile)
    const offView = window.tigermark.onMenuViewMode((mode) => {
      if (mode === 'edit' || mode === 'split' || mode === 'preview') {
        setViewMode(mode)
      }
    })
    return () => {
      offOpen()
      offSave()
      offView()
    }
  }, [openDirectory, saveFile])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void saveFile()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [saveFile])

  const onResizeStart = (e: { preventDefault(): void; clientX: number }) => {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = sidebarWidth
    const onMove = (ev: MouseEvent) => {
      const next = Math.min(480, Math.max(180, startWidth + ev.clientX - startX))
      setSidebarWidth(next)
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const showEditor = viewMode === 'edit' || viewMode === 'split'
  const showPreview = viewMode === 'preview' || viewMode === 'split'

  return (
    <div className="app">
      <Toolbar
        fileName={activePath ? basename(activePath) : null}
        dirty={dirty}
        viewMode={viewMode}
        canSave={Boolean(activePath)}
        onOpenFolder={openDirectory}
        onSave={() => void saveFile()}
        onViewModeChange={setViewMode}
        onNewFile={() => {
          if (!rootPath) {
            setStatus('请先打开文件夹')
            return
          }
          void createFile(rootPath)
        }}
      />

      <div className="workspace">
        <aside className="sidebar" style={{ width: sidebarWidth }}>
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
                📂
              </button>
              <button
                type="button"
                className="icon-btn"
                title="新建文件"
                disabled={!rootPath}
                onClick={() => rootPath && void createFile(rootPath)}
              >
                ＋
              </button>
              <button
                type="button"
                className="icon-btn"
                title="新建文件夹"
                disabled={!rootPath}
                onClick={() => rootPath && void createFolder(rootPath)}
              >
                ▣
              </button>
            </div>
          </div>

          <div className="sidebar-body">
            {rootPath ? (
              <FileTree
                entries={tree}
                activePath={activePath}
                onOpenFile={openFile}
                onCreateFile={createFile}
                onCreateFolder={createFolder}
                onDelete={deleteEntry}
                onRename={renameEntry}
              />
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

        <div className="resizer" onMouseDown={onResizeStart} />

        <main className="editor-area">
          {activePath ? (
            <div className={`panes panes-${viewMode}`}>
              {showEditor && (
                <section className="pane editor-pane">
                  <MarkdownEditor
                    key={activePath}
                    value={content}
                    onChange={handleContentChange}
                  />
                </section>
              )}
              {viewMode === 'split' && <div className="pane-divider" />}
              {showPreview && (
                <section className="pane preview-pane">
                  <MarkdownPreview content={content} />
                </section>
              )}
            </div>
          ) : (
            <div className="empty-editor">
              <h1>TigerMark</h1>
              <p>左侧打开目录，选择 Markdown 文件开始写作</p>
              <div className="hint-row">
                <kbd>⌘/Ctrl</kbd>+<kbd>O</kbd> 打开文件夹
                <span>·</span>
                <kbd>⌘/Ctrl</kbd>+<kbd>S</kbd> 保存
                <span>·</span>
                <kbd>⌘/Ctrl</kbd>+<kbd>1/2/3</kbd> 切换视图
              </div>
            </div>
          )}
        </main>
      </div>

      <footer className="status-bar">
        <span>{status}</span>
        <span>{dirty ? '未保存' : '已同步'}</span>
      </footer>
    </div>
  )
}
