import { HighlightStyle, syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language'
import { EditorView } from '@codemirror/view'
import { tags } from '@lezer/highlight'

const darkHighlightStyle = HighlightStyle.define([
  { tag: tags.meta, color: '#8b949e' },
  { tag: tags.link, textDecoration: 'underline', color: '#7eb0e0' },
  { tag: tags.heading, textDecoration: 'underline', fontWeight: 'bold', color: '#eef1f6' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strong, fontWeight: 'bold' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: tags.keyword, color: '#ff7b72' },
  { tag: [tags.atom, tags.bool, tags.url, tags.contentSeparator, tags.labelName], color: '#79c0ff' },
  { tag: [tags.literal, tags.inserted], color: '#a5d6ff' },
  { tag: [tags.string, tags.deleted], color: '#a5d6a7' },
  { tag: [tags.regexp, tags.escape, tags.special(tags.string)], color: '#e08a4f' },
  { tag: tags.definition(tags.variableName), color: '#d2a8ff' },
  { tag: tags.local(tags.variableName), color: '#ffa198' },
  { tag: [tags.typeName, tags.namespace], color: '#7ee787' },
  { tag: tags.className, color: '#f0b27a' },
  { tag: [tags.special(tags.variableName), tags.macroName], color: '#d2a8ff' },
  { tag: tags.definition(tags.propertyName), color: '#79c0ff' },
  { tag: tags.comment, color: '#8b949e' },
  { tag: tags.invalid, color: '#f07178' },
  { tag: tags.monospace, color: '#e8edf4' },
  { tag: tags.processingInstruction, color: '#8b949e' },
])

const darkEditorTheme = EditorView.theme(
  {
    '&': {
      height: '100%',
      fontSize: '14.5px',
      color: '#eef1f6',
      backgroundColor: 'transparent',
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
      color: '#7a8494',
      minWidth: '40px',
    },
    '.cm-activeLine': {
      backgroundColor: 'rgba(232, 192, 125, 0.08)',
    },
    '.cm-activeLineGutter': {
      backgroundColor: 'transparent',
      color: '#e8c07d',
    },
    '&.cm-focused .cm-cursor': {
      borderLeftColor: '#e8c07d',
    },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
      backgroundColor: 'rgba(126, 176, 224, 0.35)',
    },
  },
  { dark: true },
)

const lightEditorTheme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: '14.5px',
    color: '#1c2430',
    backgroundColor: 'transparent',
  },
  '.cm-scroller': {
    fontFamily:
      '"JetBrains Mono", "SF Mono", "Cascadia Code", "Fira Code", ui-monospace, monospace',
    lineHeight: '1.65',
  },
  '.cm-content': {
    padding: '16px 0',
    caretColor: '#c45c26',
  },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    border: 'none',
    color: '#5c6575',
    minWidth: '40px',
  },
  '.cm-activeLine': {
    backgroundColor: 'rgba(196, 92, 38, 0.06)',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'transparent',
    color: '#c45c26',
  },
  '&.cm-focused .cm-cursor': {
    borderLeftColor: '#c45c26',
  },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
    backgroundColor: 'rgba(106, 156, 196, 0.35)',
  },
})

export function editorThemeExtensions(mode: 'light' | 'dark') {
  if (mode === 'dark') {
    return [darkEditorTheme, syntaxHighlighting(darkHighlightStyle, { fallback: true })]
  }
  return [
    lightEditorTheme,
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
  ]
}
