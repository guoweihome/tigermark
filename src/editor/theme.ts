import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { EditorView } from '@codemirror/view'
import { tags } from '@lezer/highlight'

const lightHighlightStyle = HighlightStyle.define([
  { tag: tags.heading1, color: '#1a1a1a', fontWeight: '700' },
  { tag: tags.heading2, color: '#1a1a1a', fontWeight: '700' },
  { tag: tags.heading3, color: '#1a1a1a', fontWeight: '700' },
  { tag: tags.heading4, color: '#1a1a1a', fontWeight: '600' },
  { tag: tags.heading, color: '#1a1a1a', fontWeight: '700' },
  { tag: tags.strong, color: '#1a1a1a', fontWeight: '700' },
  { tag: tags.emphasis, color: '#3a4452', fontStyle: 'italic' },
  { tag: tags.strikethrough, color: '#888', textDecoration: 'line-through' },
  { tag: tags.link, color: '#0c6ada' },
  { tag: tags.url, color: '#0c6ada' },
  { tag: tags.monospace, color: '#24292e' },
  { tag: tags.quote, color: '#777' },
  { tag: tags.meta, color: '#c45c26' },
  { tag: tags.processingInstruction, color: '#c45c26' },
  { tag: tags.contentSeparator, color: '#c45c26' },
  { tag: tags.punctuation, color: '#c45c26' },
  { tag: tags.comment, color: '#9aa3ad' },
  { tag: tags.keyword, color: '#bf3889' },
  { tag: tags.atom, color: '#8250df' },
  { tag: tags.string, color: '#0c6ada' },
])

const darkHighlightStyle = HighlightStyle.define([
  { tag: tags.heading1, color: '#f2f4f6', fontWeight: '700' },
  { tag: tags.heading2, color: '#f2f4f6', fontWeight: '700' },
  { tag: tags.heading3, color: '#f2f4f6', fontWeight: '700' },
  { tag: tags.heading4, color: '#e7e9ea', fontWeight: '600' },
  { tag: tags.heading, color: '#f2f4f6', fontWeight: '700' },
  { tag: tags.strong, color: '#f2f4f6', fontWeight: '700' },
  { tag: tags.emphasis, color: '#c5ccd6', fontStyle: 'italic' },
  { tag: tags.strikethrough, color: '#8b949e', textDecoration: 'line-through' },
  { tag: tags.link, color: '#1d9bf0' },
  { tag: tags.url, color: '#1d9bf0' },
  { tag: tags.monospace, color: '#e7e9ea' },
  { tag: tags.quote, color: '#abb2bf' },
  { tag: tags.meta, color: '#e08a4f' },
  { tag: tags.processingInstruction, color: '#e08a4f' },
  { tag: tags.contentSeparator, color: '#e08a4f' },
  { tag: tags.punctuation, color: '#e08a4f' },
  { tag: tags.comment, color: '#8b949e' },
  { tag: tags.keyword, color: '#c084fc' },
  { tag: tags.atom, color: '#99e0fc' },
  { tag: tags.string, color: '#8ffccd' },
])

const darkEditorTheme = EditorView.theme(
  {
    '&': {
      height: '100%',
      fontSize: 'var(--font-content-size)',
      color: '#e7e9ea',
      backgroundColor: 'transparent',
    },
    '.cm-scroller': {
      fontFamily: 'var(--font-content)',
      lineHeight: 'var(--font-content-line-height)',
    },
    '.cm-content': {
      padding: '28px 36px 80px 20px',
      caretColor: '#e7e9ea',
    },
    '.cm-gutters': {
      backgroundColor: 'transparent',
      border: 'none',
      color: '#7a8494',
      minWidth: '48px',
      paddingLeft: '16px',
    },
    '.cm-activeLine': {
      backgroundColor: 'transparent',
    },
    '.cm-activeLineGutter': {
      backgroundColor: 'transparent',
    },
    '&.cm-focused .cm-cursor': {
      borderLeftColor: '#e7e9ea',
    },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
      backgroundColor: 'rgba(29, 155, 240, 0.28)',
    },
    '.cm-md-mark': {
      color: 'var(--accent)',
    },
  },
  { dark: true },
)

const lightEditorTheme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: 'var(--font-content-size)',
    color: '#262626',
    backgroundColor: 'transparent',
  },
  '.cm-scroller': {
    fontFamily: 'var(--font-content)',
    lineHeight: 'var(--font-content-line-height)',
  },
  '.cm-content': {
    padding: '28px 36px 80px 20px',
    caretColor: '#262626',
  },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    border: 'none',
    color: '#9aa3ad',
    minWidth: '48px',
    paddingLeft: '16px',
  },
  '.cm-activeLine': {
    backgroundColor: 'transparent',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'transparent',
  },
  '&.cm-focused .cm-cursor': {
    borderLeftColor: '#262626',
  },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
    backgroundColor: 'rgba(12, 106, 218, 0.16)',
  },
  '.cm-md-mark': {
    color: 'var(--accent)',
  },
})

export function editorThemeExtensions(mode: 'light' | 'dark') {
  if (mode === 'dark') {
    return [darkEditorTheme, syntaxHighlighting(darkHighlightStyle, { fallback: true })]
  }
  return [lightEditorTheme, syntaxHighlighting(lightHighlightStyle, { fallback: true })]
}
