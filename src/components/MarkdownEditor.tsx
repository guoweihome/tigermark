import { useEffect, useRef } from 'react'
import { EditorView, keymap, lineNumbers, highlightActiveLine } from '@codemirror/view'
import { Compartment, EditorState } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { bracketMatching } from '@codemirror/language'
import { EditorToolbar } from './EditorToolbar'
import {
  applyHeading,
  formatJson,
  headingInputHandler,
  insertTable,
} from '../editor/commands'
import { editorThemeExtensions } from '../editor/theme'

interface MarkdownEditorProps {
  value: string
  onChange: (value: string) => void
  theme?: 'light' | 'dark'
  onPasteImage?: (file: File) => Promise<string | null>
  onMessage?: (message: string) => void
}

export function MarkdownEditor({
  value,
  onChange,
  theme = 'light',
  onPasteImage,
  onMessage,
}: MarkdownEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const themeCompartment = useRef(new Compartment())
  const onChangeRef = useRef(onChange)
  const onPasteImageRef = useRef(onPasteImage)
  const onMessageRef = useRef(onMessage)
  onChangeRef.current = onChange
  onPasteImageRef.current = onPasteImage
  onMessageRef.current = onMessage

  useEffect(() => {
    if (!hostRef.current) return

    const updateListener = EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        onChangeRef.current(update.state.doc.toString())
      }
    })

    const pasteHandler = EditorView.domEventHandlers({
      paste(event, view) {
        const handler = onPasteImageRef.current
        const clipboard = event.clipboardData
        if (!handler || !clipboard) return false

        const imageItem = Array.from(clipboard.items).find((item) =>
          item.type.startsWith('image/'),
        )
        if (!imageItem) return false

        const file = imageItem.getAsFile()
        if (!file) return false

        event.preventDefault()
        void (async () => {
          const markdownPath = await handler(file)
          if (!markdownPath) return
          const insert = `![image](${markdownPath})`
          const pos = view.state.selection.main.head
          view.dispatch({
            changes: { from: pos, to: view.state.selection.main.to, insert },
            selection: { anchor: pos + insert.length },
          })
          view.focus()
        })()
        return true
      },
    })

    const state = EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        history(),
        bracketMatching(),
        markdown(),
        keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap]),
        EditorView.lineWrapping,
        EditorView.inputHandler.of(headingInputHandler),
        updateListener,
        pasteHandler,
        themeCompartment.current.of(editorThemeExtensions(theme)),
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

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({
      effects: themeCompartment.current.reconfigure(editorThemeExtensions(theme)),
    })
  }, [theme])

  const withView = (fn: (view: EditorView) => void) => {
    const view = viewRef.current
    if (!view) return
    fn(view)
  }

  return (
    <div className="editor-shell">
      <EditorToolbar
        onHeading={(level) => withView((view) => applyHeading(view, level))}
        onInsertTable={() => withView(insertTable)}
        onFormatJson={() =>
          withView((view) => {
            const result = formatJson(view)
            if (!result.ok) onMessageRef.current?.(result.error)
            else onMessageRef.current?.('JSON 已格式化')
          })
        }
      />
      <div className="cm-host" ref={hostRef} />
    </div>
  )
}
