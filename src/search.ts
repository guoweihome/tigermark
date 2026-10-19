import type { FileEntry } from './vite-env'

export interface TextRange {
  start: number
  end: number
}

export interface NoteFile {
  path: string
  name: string
  relativePath: string
  board: boolean
}

export interface SearchHit {
  path: string
  line: number | null
  text: string
  ranges: TextRange[]
  lead: boolean
  tail: boolean
  filename: boolean
}

export interface SearchGroup {
  path: string
  relativePath: string
  nameRanges: TextRange[]
  hits: SearchHit[]
}

export interface SearchResult {
  groups: SearchGroup[]
  total: number
  truncated: boolean
}

const SNIPPET_RADIUS = 48
const MAX_MATCHES = 200
const MAX_MATCHES_PER_FILE = 30

export function toRelativePath(root: string, filePath: string) {
  const normRoot = root.replace(/\\/g, '/').replace(/\/+$/, '')
  const normFile = filePath.replace(/\\/g, '/')
  if (!normRoot || normRoot === '.') return normFile.replace(/^\.\//, '')
  const prefix = `${normRoot}/`
  if (
    normFile.length >= prefix.length &&
    normFile.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase()
  ) {
    return normFile.slice(prefix.length)
  }
  return normFile
}

export function collectNoteFiles(entries: FileEntry[], rootPath: string): NoteFile[] {
  const files: NoteFile[] = []
  const walk = (list: FileEntry[]) => {
    for (const entry of list) {
      if (entry.isDirectory) {
        walk(entry.children ?? [])
        continue
      }
      files.push({
        path: entry.path,
        name: entry.name,
        relativePath: toRelativePath(rootPath, entry.path),
        board: entry.name.toLowerCase().endsWith('.board.json'),
      })
    }
  }
  walk(entries)
  return files
}

export function queryTerms(query: string) {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean)
}

export function matchTerms(text: string, terms: string[]): TextRange[] | null {
  if (terms.length === 0) return null
  const lower = text.toLowerCase()
  const ranges: TextRange[] = []
  for (const term of terms) {
    let from = 0
    let found = false
    while (from < lower.length) {
      const index = lower.indexOf(term, from)
      if (index < 0) break
      found = true
      ranges.push({ start: index, end: index + term.length })
      from = index + Math.max(term.length, 1)
    }
    if (!found) return null
  }
  ranges.sort((a, b) => a.start - b.start || a.end - b.end)
  const merged: TextRange[] = []
  for (const range of ranges) {
    const last = merged[merged.length - 1]
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end)
    else merged.push({ ...range })
  }
  return merged
}

export function snippetAround(line: string, ranges: TextRange[]) {
  const source = line.replace(/\s+$/g, '')
  const clip = (start: number, end: number) =>
    ranges
      .filter((range) => range.end > start && range.start < end)
      .map((range) => ({
        start: Math.max(0, range.start - start),
        end: Math.min(range.end, end) - start,
      }))
      .filter((range) => range.end > range.start)

  if (source.length <= SNIPPET_RADIUS * 2) {
    return { text: source, ranges: clip(0, source.length), lead: false, tail: false }
  }

  const anchor = ranges[0]?.start ?? 0
  let start = Math.max(0, anchor - SNIPPET_RADIUS)
  const end = Math.min(source.length, Math.max(anchor + SNIPPET_RADIUS, (ranges[0]?.end ?? anchor) + 12))
  if (start > 0) {
    const space = source.lastIndexOf(' ', start + 16)
    if (space >= start - 12 && space < anchor) start = space + 1
  }
  return {
    text: source.slice(start, end),
    ranges: clip(start, end),
    lead: start > 0,
    tail: end < source.length,
  }
}

export function searchNotes(
  files: NoteFile[],
  contents: Map<string, string>,
  query: string,
): SearchResult {
  const terms = queryTerms(query)
  if (terms.length === 0) return { groups: [], total: 0, truncated: false }

  const groups: SearchGroup[] = []
  let total = 0
  let truncated = false

  for (const file of files) {
    if (total >= MAX_MATCHES) {
      truncated = true
      break
    }

    const stemPath = file.relativePath.replace(
      /\.(?:board\.json|markdown|mdown|mkd|txt|md)$/i,
      '',
    )
    const nameRanges = matchTerms(stemPath, terms) ?? []
    const hits: SearchHit[] = []
    const content = file.board ? undefined : contents.get(file.path)
    if (content) {
      const lines = content.split(/\r?\n/)
      for (let index = 0; index < lines.length; index += 1) {
        if (hits.length >= MAX_MATCHES_PER_FILE || total + hits.length >= MAX_MATCHES) {
          truncated = true
          break
        }
        const ranges = matchTerms(lines[index], terms)
        if (!ranges) continue
        const snippet = snippetAround(lines[index], ranges)
        hits.push({
          path: file.path,
          line: index + 1,
          text: snippet.text,
          ranges: snippet.ranges,
          lead: snippet.lead,
          tail: snippet.tail,
          filename: false,
        })
      }
    }

    if (nameRanges.length === 0 && hits.length === 0) continue

    if (hits.length === 0) {
      hits.push({
        path: file.path,
        line: null,
        text: '文件名匹配',
        ranges: [],
        lead: false,
        tail: false,
        filename: true,
      })
    }

    total += hits.length
    groups.push({
      path: file.path,
      relativePath: file.relativePath,
      nameRanges,
      hits,
    })
  }

  return { groups, total, truncated }
}

export function flattenHits(groups: SearchGroup[]) {
  return groups.flatMap((group) => group.hits)
}
