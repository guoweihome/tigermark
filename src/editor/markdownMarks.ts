import { syntaxTree } from '@codemirror/language'
import { RangeSetBuilder } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view'

const EXTRA_MARK_NODES = new Set([
  'CodeInfo',
  'URL',
  'TaskMarker',
  'HorizontalRule',
  'TableDelimiter',
  'Escape',
  'Entity',
])

const markDecoration = Decoration.mark({ class: 'cm-md-mark' })

function isMarkdownMark(name: string) {
  return name.endsWith('Mark') || EXTRA_MARK_NODES.has(name)
}

function highlightMarkdownMarks(view: EditorView) {
  const builder = new RangeSetBuilder<Decoration>()
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter(node) {
        if (isMarkdownMark(node.name)) {
          builder.add(node.from, node.to, markDecoration)
        }
      },
    })
  }
  return builder.finish()
}

export const markdownMarkHighlighter = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet

    constructor(view: EditorView) {
      this.decorations = highlightMarkdownMarks(view)
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = highlightMarkdownMarks(update.view)
      }
    }
  },
  { decorations: (value) => value.decorations },
)
