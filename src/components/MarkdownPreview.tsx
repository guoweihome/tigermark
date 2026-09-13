import { useMemo } from 'react'
import { marked, Renderer } from 'marked'
import DOMPurify from 'dompurify'

interface MarkdownPreviewProps {
  content: string
  baseDir?: string | null
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

export function MarkdownPreview({ content, baseDir }: MarkdownPreviewProps) {
  const html = useMemo(() => {
    const renderer = new Renderer()
    renderer.image = ({ href, title, text }) => {
      const src = toPreviewSrc(href, baseDir)
      const titleAttr = title ? ` title="${escapeAttr(title)}"` : ''
      const alt = escapeAttr(text || '')
      return `<img src="${escapeAttr(src)}" alt="${alt}"${titleAttr} />`
    }

    const raw = marked.parse(content || '', { renderer }) as string
    return DOMPurify.sanitize(raw, {
      ADD_ATTR: ['target'],
      ALLOWED_URI_REGEXP:
        /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|asset|data):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
    })
  }, [content, baseDir])

  return (
    <div className="preview-scroll">
      <article
        className="markdown-body"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  )
}
