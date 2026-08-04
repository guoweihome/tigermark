import { EditorSelection } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'

/** Ensure typing `# ` mid-line pushes the heading onto its own line. */
export function headingInputHandler(
  view: EditorView,
  from: number,
  to: number,
  text: string,
): boolean {
  if (text !== ' ') return false

  const line = view.state.doc.lineAt(from)
  const before = view.state.doc.sliceString(line.from, from)
  const match = before.match(/(#{1,6})$/)
  if (!match) return false

  const hashes = match[1]
  const prefix = before.slice(0, -hashes.length)
  if (/^\s*$/.test(prefix)) return false

  const hashFrom = from - hashes.length
  const insert = `\n${hashes} `
  view.dispatch({
    changes: { from: hashFrom, to, insert },
    selection: { anchor: hashFrom + insert.length },
    userEvent: 'input.type',
  })
  return true
}

export function applyHeading(view: EditorView, level: number) {
  const line = view.state.doc.lineAt(view.state.selection.main.head)
  const raw = line.text.replace(/^\s+/, '')
  const text = raw.replace(/^#{1,6}\s+/, '')
  let insert = `${'#'.repeat(level)} ${text}`
  let cursorOffset = insert.length

  if (line.number > 1) {
    const prev = view.state.doc.line(line.number - 1)
    if (prev.text.trim() !== '') {
      insert = `\n${insert}`
      cursorOffset += 1
    }
  }

  view.dispatch({
    changes: { from: line.from, to: line.to, insert },
    selection: { anchor: line.from + cursorOffset },
    userEvent: 'input',
  })
  view.focus()
}

export function insertTable(view: EditorView) {
  const table = [
    '| 列1 | 列2 | 列3 |',
    '| --- | --- | --- |',
    '|     |     |     |',
    '|     |     |     |',
  ].join('\n')

  const { from, to } = view.state.selection.main
  let insert = table

  if (from > 0) {
    const before = view.state.doc.sliceString(from - 1, from)
    if (before !== '\n') {
      insert = `\n\n${insert}`
    }
  }

  const after = view.state.doc.sliceString(to, Math.min(view.state.doc.length, to + 1))
  if (after && after !== '\n') {
    insert = `${insert}\n\n`
  } else {
    insert = `${insert}\n`
  }

  const firstCell = insert.indexOf('|     |')
  const anchor = firstCell >= 0 ? from + firstCell + 2 : from + insert.length

  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor },
    userEvent: 'input',
  })
  view.focus()
}

function findJsonRange(docText: string, cursor: number): { from: number; to: number } | null {
  let start = -1
  let openChar: '{' | '[' | null = null
  for (let i = Math.min(cursor, docText.length - 1); i >= 0; i--) {
    const ch = docText[i]
    if (ch === '{' || ch === '[') {
      start = i
      openChar = ch
      break
    }
  }
  if (start < 0 || !openChar) return null

  const closeChar = openChar === '{' ? '}' : ']'
  let depth = 0
  let inString = false
  let escape = false

  for (let i = start; i < docText.length; i++) {
    const ch = docText[i]
    if (inString) {
      if (escape) escape = false
      else if (ch === '\\') escape = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === openChar) depth++
    else if (ch === closeChar) {
      depth--
      if (depth === 0) return { from: start, to: i + 1 }
    }
  }
  return null
}

export function formatJson(
  view: EditorView,
): { ok: true } | { ok: false; error: string } {
  const { state } = view
  const sel = state.selection.main
  let from = sel.from
  let to = sel.to
  let text: string

  if (sel.empty) {
    const range = findJsonRange(state.doc.toString(), sel.head)
    if (!range) {
      return { ok: false, error: '请先选中 JSON，或将光标放在 JSON 对象/数组内' }
    }
    from = range.from
    to = range.to
    text = state.sliceDoc(from, to)
  } else {
    text = state.sliceDoc(from, to)
  }

  try {
    const parsed = JSON.parse(text.trim())
    const formatted = JSON.stringify(parsed, null, 2)
    view.dispatch({
      changes: { from, to, insert: formatted },
      selection: EditorSelection.range(from, from + formatted.length),
      userEvent: 'input',
    })
    view.focus()
    return { ok: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: `JSON 格式化失败：${message}` }
  }
}
