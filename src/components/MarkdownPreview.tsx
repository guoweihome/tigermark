import { useMemo } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'

interface MarkdownPreviewProps {
  content: string
}

marked.setOptions({
  gfm: true,
  breaks: true,
})

export function MarkdownPreview({ content }: MarkdownPreviewProps) {
  const html = useMemo(() => {
    const raw = marked.parse(content || '') as string
    return DOMPurify.sanitize(raw)
  }, [content])

  return (
    <div className="preview-scroll">
      <article
        className="markdown-body"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  )
}
