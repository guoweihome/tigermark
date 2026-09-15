import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { marked, Renderer } from 'marked'
import DOMPurify from 'dompurify'

interface MarkdownPreviewProps {
  content: string
  baseDir?: string | null
}

export type MarkdownPreviewHandle = {
  openFind: () => void
  findNext: () => void
  findPrev: () => void
}

marked.setOptions({
  gfm: true,
  breaks: true,
})

function isRemoteOrData(href: string) {
  return /^(https?:|data:|asset:|mailto:|#)/i.test(href)
}

function resolveLocalPath(baseDir: string, href: string) {
  const normalizedBase = baseDir.replace(/\\/g, '/').replace(/\/+$/, '')
  const normalizedHref = href.replace(/\\/g, '/')

  if (normalizedHref.startsWith('/') || /^[A-Za-z]:\//.test(normalizedHref)) {
    return normalizedHref
  }

  const parts = normalizedBase.split('/')
  for (const segment of normalizedHref.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (parts.length > 1) parts.pop()
      continue
    }
    parts.push(segment)
  }
  return parts.join('/')
}

function toPreviewSrc(href: string | null | undefined, baseDir?: string | null) {
  if (!href) return ''
  if (isRemoteOrData(href)) return href
  if (!baseDir) return href
  const absolute = resolveLocalPath(baseDir, href)
  if (window.tigermark?.toFileUrl) {
    return window.tigermark.toFileUrl(absolute)
  }
  return absolute
}

function escapeAttr(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function unwrapFindMarks(root: HTMLElement) {
  root.querySelectorAll('mark.tm-find').forEach((mark) => {
    const parent = mark.parentNode
    if (!parent) return
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark)
    parent.removeChild(mark)
    parent.normalize()
  })
}

function wrapFindMatches(root: HTMLElement, query: string): HTMLElement[] {
  unwrapFindMarks(root)
  if (!query) return []

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  while (walker.nextNode()) nodes.push(walker.currentNode as Text)

  const needle = query.toLowerCase()
  const marks: HTMLElement[] = []

  for (const textNode of nodes) {
    const text = textNode.data
    if (!text) continue
    const lower = text.toLowerCase()
    const ranges: { start: number; end: number }[] = []
    let from = 0
    while (from < text.length) {
      const idx = lower.indexOf(needle, from)
      if (idx === -1) break
      ranges.push({ start: idx, end: idx + query.length })
      from = idx + query.length
    }
    if (ranges.length === 0) continue

    for (let i = ranges.length - 1; i >= 0; i--) {
      const { start, end } = ranges[i]
      const range = document.createRange()
      range.setStart(textNode, start)
      range.setEnd(textNode, end)
      const mark = document.createElement('mark')
      mark.className = 'tm-find'
      range.surroundContents(mark)
      marks.unshift(mark)
    }
  }

  return marks
}

export const MarkdownPreview = forwardRef<MarkdownPreviewHandle, MarkdownPreviewProps>(
  function MarkdownPreview({ content, baseDir }, ref) {
    const articleRef = useRef<HTMLElement>(null)
    const inputRef = useRef<HTMLInputElement>(null)
    const marksRef = useRef<HTMLElement[]>([])
    const [findOpen, setFindOpen] = useState(false)
    const [query, setQuery] = useState('')
    const [active, setActive] = useState(0)
    const [total, setTotal] = useState(0)

    const html = useMemo(() => {
      const renderer = new Renderer()
      renderer.image = ({ href, title, text }) => {
        const src = toPreviewSrc(href, baseDir)
        const alt = escapeAttr(text || '')
        const img = `<img src="${escapeAttr(src)}" alt="${alt}" />`
        if (!title) return img
        return `<figure>${img}<figcaption>${escapeAttr(title)}</figcaption></figure>`
      }

      const raw = marked.parse(content || '', { renderer }) as string
      return DOMPurify.sanitize(raw, {
        ADD_ATTR: ['target'],
        ALLOWED_URI_REGEXP:
          /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|asset|data):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
      })
    }, [content, baseDir])

    const reveal = (index: number, list: HTMLElement[]) => {
      list.forEach((mark, i) => {
        mark.classList.toggle('tm-find-current', i === index)
      })
      list[index]?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }

    const applyFind = (nextQuery: string, preferIndex = 0, enabled = findOpen) => {
      const root = articleRef.current
      if (!root || !enabled) {
        if (root) unwrapFindMarks(root)
        marksRef.current = []
        setTotal(0)
        setActive(0)
        return
      }
      const list = wrapFindMatches(root, nextQuery.trim())
      marksRef.current = list
      setTotal(list.length)
      if (list.length === 0) {
        setActive(0)
        return
      }
      const index = ((preferIndex % list.length) + list.length) % list.length
      setActive(index)
      reveal(index, list)
    }

    useEffect(() => {
      applyFind(query, 0, findOpen)
      // html replacement resets marks
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [html, findOpen])

    const jump = (delta: number) => {
      const list = marksRef.current
      if (list.length === 0) return
      const index = (active + delta + list.length) % list.length
      setActive(index)
      reveal(index, list)
    }

    const openFind = () => {
      setFindOpen(true)
      requestAnimationFrame(() => {
        inputRef.current?.focus()
        inputRef.current?.select()
        applyFind(query, active, true)
      })
    }

    useImperativeHandle(ref, () => ({
      openFind,
      findNext: () => {
        if (!findOpen) openFind()
        else jump(1)
      },
      findPrev: () => {
        if (!findOpen) openFind()
        else jump(-1)
      },
    }))

    return (
      <div className="preview-scroll">
        {findOpen && (
          <div className="find-bar" role="search">
            <input
              ref={inputRef}
              className="find-bar-input"
              type="search"
              placeholder="在预览中查找"
              value={query}
              aria-label="在预览中查找"
              onChange={(e) => {
                const next = e.target.value
                setQuery(next)
                applyFind(next, 0)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  jump(e.shiftKey ? -1 : 1)
                }
                if (e.key === 'Escape') {
                  e.preventDefault()
                  setFindOpen(false)
                  unwrapFindMarks(articleRef.current!)
                  marksRef.current = []
                }
              }}
            />
            <span className="find-bar-count">
              {query.trim() ? (total === 0 ? '0/0' : `${active + 1}/${total}`) : ''}
            </span>
            <button type="button" className="find-bar-btn" title="上一个" onClick={() => jump(-1)}>
              ↑
            </button>
            <button type="button" className="find-bar-btn" title="下一个" onClick={() => jump(1)}>
              ↓
            </button>
            <button
              type="button"
              className="find-bar-btn"
              title="关闭"
              onClick={() => {
                setFindOpen(false)
                if (articleRef.current) unwrapFindMarks(articleRef.current)
                marksRef.current = []
              }}
            >
              ×
            </button>
          </div>
        )}
        <article
          ref={articleRef}
          className="markdown-body"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </div>
    )
  },
)
