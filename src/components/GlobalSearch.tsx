import { useEffect, useMemo, useRef, useState } from 'react'
import type { FileEntry } from '../vite-env'
import {
  collectNoteFiles,
  flattenHits,
  searchNotes,
  type NoteFile,
  type SearchHit,
  type TextRange,
} from '../search'
import { IconSearch } from './icons'

interface GlobalSearchProps {
  open: boolean
  rootPath: string
  libraryVersion: number
  tree: FileEntry[]
  activePath: string | null
  activeContent: string
  activeDirty: boolean
  onClose: () => void
  onOpenMatch: (match: { path: string; line: number | null; query: string }) => void
}

interface NoteIndex {
  key: string
  files: NoteFile[]
  contents: Map<string, string>
}

function samePath(left: string, right: string) {
  return left.replace(/\\/g, '/').replace(/\/+$/, '') === right.replace(/\\/g, '/').replace(/\/+$/, '')
}

function Highlight({ text, ranges }: { text: string; ranges: TextRange[] }) {
  if (ranges.length === 0) return <>{text}</>
  const parts: Array<string | { text: string; key: number }> = []
  let cursor = 0
  ranges.forEach((range, index) => {
    const start = Math.max(cursor, range.start)
    const end = Math.min(text.length, range.end)
    if (start > cursor) parts.push(text.slice(cursor, start))
    if (end > start) parts.push({ text: text.slice(start, end), key: index })
    cursor = Math.max(cursor, end)
  })
  if (cursor < text.length) parts.push(text.slice(cursor))
  return (
    <>
      {parts.map((part, index) =>
        typeof part === 'string' ? (
          <span key={index}>{part}</span>
        ) : (
          <mark key={part.key}>{part.text}</mark>
        ),
      )}
    </>
  )
}

export function GlobalSearch({
  open,
  rootPath,
  libraryVersion,
  tree,
  activePath,
  activeContent,
  activeDirty,
  onClose,
  onOpenMatch,
}: GlobalSearchProps) {
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [index, setIndex] = useState<NoteIndex | null>(null)
  const [loaded, setLoaded] = useState(0)
  const [total, setTotal] = useState(0)
  const [selected, setSelected] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const selectedRef = useRef<HTMLButtonElement>(null)
  const treeRef = useRef(tree)
  const cacheRef = useRef<NoteIndex | null>(null)
  const loadSeq = useRef(0)
  treeRef.current = tree
  const indexKey = `${rootPath}\0${libraryVersion}`
  const readyIndex = index?.key === indexKey ? index : null

  useEffect(() => {
    setQuery('')
    setDebouncedQuery('')
  }, [rootPath])

  useEffect(() => {
    if (!query.trim()) {
      setDebouncedQuery('')
      return
    }
    const timer = window.setTimeout(() => setDebouncedQuery(query), 80)
    return () => window.clearTimeout(timer)
  }, [query])

  useEffect(() => {
    setSelected(0)
  }, [debouncedQuery])

  useEffect(() => {
    if (!open) return
    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [open])

  useEffect(() => {
    if (!open) return
    const key = `${rootPath}\0${libraryVersion}`
    const cached = cacheRef.current
    if (cached?.key === key) {
      setIndex(cached)
      setTotal(cached.files.filter((file) => !file.board).length)
      setLoaded(cached.files.filter((file) => !file.board).length)
      return
    }

    const loadId = ++loadSeq.current
    let cancelled = false
    const files = collectNoteFiles(treeRef.current, rootPath)
    const readable = files.filter((file) => !file.board)
    setLoaded(0)
    setTotal(readable.length)

    void (async () => {
      const contents = new Map<string, string>()
      const queue = [...readable]
      let done = 0
        const worker = async () => {
          for (;;) {
            const file = queue.shift()
            if (!file || cancelled) return
            try {
              const result = await window.tigermark.readFile(file.path)
              if (cancelled || loadSeq.current !== loadId) return
              if (result.ok && result.data !== undefined) contents.set(file.path, result.data)
            } catch {
              if (cancelled || loadSeq.current !== loadId) return
            }
            done += 1
            if (done % 8 === 0 || done === readable.length) setLoaded(done)
          }
        }
      const workers = Math.min(6, Math.max(readable.length, 1))
      await Promise.all(Array.from({ length: workers }, () => worker()))
      if (cancelled || loadSeq.current !== loadId) return
      const next = { key, files, contents }
      cacheRef.current = next
      setIndex(next)
      setLoaded(readable.length)
    })()

    return () => {
      cancelled = true
    }
  }, [open, rootPath, libraryVersion])

  const contents = useMemo(() => {
    const base = readyIndex?.contents ?? new Map<string, string>()
    if (!readyIndex || !activeDirty || !activePath) return base
    const next = new Map(base)
    for (const file of readyIndex.files) {
      if (samePath(file.path, activePath)) {
        next.set(file.path, activeContent)
        break
      }
    }
    return next
  }, [readyIndex, activeDirty, activePath, activeContent])

  const result = useMemo(() => {
    if (!readyIndex) return { groups: [], total: 0, truncated: false }
    return searchNotes(readyIndex.files, contents, debouncedQuery)
  }, [readyIndex, contents, debouncedQuery])

  const flat = useMemo(() => flattenHits(result.groups), [result.groups])
  const activeIndex = flat.length === 0 ? 0 : Math.min(selected, flat.length - 1)

  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, result.groups])

  if (!open) return null

  const openHit = (hit: SearchHit) => {
    onOpenMatch({ path: hit.path, line: hit.line, query: debouncedQuery })
  }

  const loading = !readyIndex
  const status = loading
    ? total > 0
      ? `正在读取笔记… ${loaded}/${total}`
      : '正在读取笔记…'
    : !debouncedQuery.trim()
      ? '输入关键词，搜索当前文件夹里的全部笔记'
      : result.total === 0
        ? '未找到匹配内容'
        : `${result.groups.length} 个文件 · ${result.total} 个结果${result.truncated ? ' · 还有更多' : ''}`

  return (
    <div className="global-search-backdrop" onMouseDown={onClose}>
      <div
        className="global-search"
        role="dialog"
        aria-modal="true"
        aria-label="全文搜索"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="global-search-input-row">
          <IconSearch />
          <input
            ref={inputRef}
            className="global-search-input"
            type="text"
            role="searchbox"
            spellCheck={false}
            placeholder="搜索全部笔记…"
            aria-label="搜索全部笔记"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                setSelected((current) => {
                  const base = Math.min(current, Math.max(flat.length - 1, 0))
                  return Math.min(flat.length - 1, base + 1)
                })
              } else if (event.key === 'ArrowUp') {
                event.preventDefault()
                setSelected((current) => Math.max(0, Math.min(current, flat.length - 1) - 1))
              } else if (event.key === 'Enter') {
                event.preventDefault()
                const hit = flat[activeIndex]
                if (hit) openHit(hit)
              } else if (event.key === 'Escape') {
                event.preventDefault()
                event.stopPropagation()
                onClose()
              }
            }}
          />
        </div>

        <div className="global-search-results" role="listbox" aria-label="搜索结果">
          {!loading && debouncedQuery.trim() && result.groups.length === 0 ? (
            <div className="global-search-empty">未找到「{debouncedQuery.trim()}」</div>
          ) : !loading && !debouncedQuery.trim() ? (
            <div className="global-search-empty">
              多个词需要出现在同一行。文件名也会参与匹配。
            </div>
          ) : (
            result.groups.map((group) => (
              <section key={group.path} className="global-search-group">
                <div className="global-search-file" title={group.relativePath}>
                  <Highlight text={group.relativePath} ranges={group.nameRanges} />
                </div>
                {group.hits.map((hit, hitIndex) => {
                  const index = flat.indexOf(hit)
                  const active = index === activeIndex
                  return (
                    <button
                      key={`${hit.path}:${hit.line ?? 'name'}:${hitIndex}`}
                      ref={active ? selectedRef : undefined}
                      type="button"
                      role="option"
                      aria-selected={active}
                      className={`global-search-hit${active ? ' is-active' : ''}`}
                      onMouseEnter={() => setSelected(index)}
                      onClick={() => openHit(hit)}
                    >
                      <span className="global-search-line">{hit.filename ? '名称' : hit.line}</span>
                      <span className="global-search-snippet">
                        {hit.lead ? '…' : null}
                        <Highlight text={hit.text} ranges={hit.ranges} />
                        {hit.tail ? '…' : null}
                      </span>
                    </button>
                  )
                })}
              </section>
            ))
          )}
        </div>

        <div className="global-search-status">
          <span>{status}</span>
          <span className="global-search-keys">↑↓ 选择 · Enter 打开 · Esc 关闭</span>
        </div>
      </div>
    </div>
  )
}
