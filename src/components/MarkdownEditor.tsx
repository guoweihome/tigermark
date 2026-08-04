import { useEffect, useRef } from 'react'
import { EditorView, keymap, lineNumbers, highlightActiveLine } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching } from '@codemirror/language'

interface MarkdownEditorProps {
  value: string
  onChange: (value: string) => void
}

export function MarkdownEditor({ value, onChange }: MarkdownEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  useEffect(() => {
    if (!hostRef.current) return

    const updateListener = EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        onChangeRef.current(update.state.doc.toString())
      }
    })

    const state = EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        history(),
        bracketMatching(),
        markdown(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap]),
        EditorView.lineWrapping,
        updateListener,
        EditorView.theme({
          '&': {
            height: '100%',
            fontSize: '14.5px',
          },
          '.cm-scroller': {
            fontFamily:
              '"JetBrains Mono", "SF Mono", "Cascadia Code", "Fira Code", ui-monospace, monospace',
            lineHeight: '1.65',
          },
          '.cm-content': {
            padding: '16px 0',
            caretColor: '#e8c07d',
          },
          '.cm-gutters': {
            backgroundColor: 'transparent',
            border: 'none',
            color: '#5c6575',
            minWidth: '40px',
          },
          '.cm-activeLine': {
            backgroundColor: 'rgba(232, 192, 125, 0.06)',
          },
          '.cm-activeLineGutter': {
            backgroundColor: 'transparent',
            color: '#e8c07d',
          },
          '&.cm-focused .cm-cursor': {
            borderLeftColor: '#e8c07d',
          },
          '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
            backgroundColor: 'rgba(106, 156, 196, 0.35)',
          },
        }),
      ],
    })

    const view = new EditorView({
      state,
      parent: hostRef.current,
    })
    viewRef.current = view

    return () => {
      view.destroy()
      viewRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- remount via key when file changes
  }, [])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const current = view.state.doc.toString()
    if (current !== value) {
      view.dispatch({
        changes: { from: 0, to: current.length, insert: value },
      })
    }
  }, [value])

  return <div className="cm-host" ref={hostRef} />
}
