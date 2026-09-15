import type { ViewMode } from '../vite-env'
import type { ThemePreference } from '../theme'
import {
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  PRESET_FONTS,
  listAvailableFonts,
} from '../fonts'
import { useEffect, useState } from 'react'

interface ToolbarProps {
  isMac: boolean
  fileName: string | null
  folderName: string | null
  dirty: boolean
  viewMode: ViewMode
  theme: ThemePreference
  canSave: boolean
  sidebarOpen: boolean
  onToggleSidebar: () => void
  onOpenFolder: () => void
  onSave: () => void
  onViewModeChange: (mode: ViewMode) => void
  onThemeChange: (theme: ThemePreference) => void
  onNewFile: () => void
  onCommandCenter: () => void
  fontFamily: string
  onFontChange: (font: string) => void
  fontSize: number
  onFontSizeChange: (size: number) => void
}

const THEME_CYCLE: ThemePreference[] = ['light', 'dark', 'system']
const THEME_LABEL: Record<ThemePreference, string> = {
  light: '浅色',
  dark: '暗色',
  system: '系统',
}

function IconSidebar({ active }: { active: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M2.5 1.5A1.5 1.5 0 0 0 1 3v10a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 15 13V3a1.5 1.5 0 0 0-1.5-1.5h-11zm0 1h4V12.5h-4a.5.5 0 0 1-.5-.5V3a.5.5 0 0 1 .5-.5zm5 0H13.5a.5.5 0 0 1 .5.5v9.5a.5.5 0 0 1-.5.5H7.5V2.5z" />
      {active ? null : <path d="M2.5 2.5h4v10h-4a.5.5 0 0 1-.5-.5V3a.5.5 0 0 1 .5-.5z" opacity="0.35" />}
    </svg>
  )
}

function IconFolder() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M1.75 2.5A1.75 1.75 0 0 0 0 4.25v7.5A1.75 1.75 0 0 0 1.75 13.5h12.5A1.75 1.75 0 0 0 16 11.75v-6A1.75 1.75 0 0 0 14.25 4H8.06l-.72-1.08A1.75 1.75 0 0 0 5.9 2.5H1.75z" />
    </svg>
  )
}

function IconPlus() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M8 1.75a.75.75 0 0 1 .75.75v4.75H13.5a.75.75 0 0 1 0 1.5H8.75V13.5a.75.75 0 0 1-1.5 0V8.75H2.5a.75.75 0 0 1 0-1.5h4.75V2.5A.75.75 0 0 1 8 1.75z" />
    </svg>
  )
}

function IconSave() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M2.5 1.5A1.5 1.5 0 0 0 1 3v10a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 15 13V5.06a1.5 1.5 0 0 0-.44-1.06L12 1.94A1.5 1.5 0 0 0 10.94 1.5H2.5zM3 3h7v3.5H3V3zm0 10V8h10v5H3z" />
    </svg>
  )
}

function IconSun() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M8 11.5A3.5 3.5 0 1 0 8 4.5a3.5 3.5 0 0 0 0 7zM8 1.25a.75.75 0 0 1 .75.75v1a.75.75 0 0 1-1.5 0v-1A.75.75 0 0 1 8 1.25zm0 11a.75.75 0 0 1 .75.75v1a.75.75 0 0 1-1.5 0v-1A.75.75 0 0 1 8 12.25zM1.25 8a.75.75 0 0 1 .75-.75h1a.75.75 0 0 1 0 1.5h-1A.75.75 0 0 1 1.25 8zm11 0a.75.75 0 0 1 .75-.75h1a.75.75 0 0 1 0 1.5h-1a.75.75 0 0 1-.75-.75zM3.22 3.22a.75.75 0 0 1 1.06 0l.7.7a.75.75 0 1 1-1.06 1.06l-.7-.7a.75.75 0 0 1 0-1.06zm7.8 7.8a.75.75 0 0 1 1.06 0l.7.7a.75.75 0 1 1-1.06 1.06l-.7-.7a.75.75 0 0 1 0-1.06zM12.78 3.22a.75.75 0 0 1 0 1.06l-.7.7a.75.75 0 1 1-1.06-1.06l.7-.7a.75.75 0 0 1 1.06 0zM4.98 11.02a.75.75 0 0 1 0 1.06l-.7.7a.75.75 0 1 1-1.06-1.06l.7-.7a.75.75 0 0 1 1.06 0z" />
    </svg>
  )
}

function IconMoon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M6.2 1.8a.75.75 0 0 1 .12 1.05 5.25 5.25 0 1 0 6.83 6.83.75.75 0 0 1 1.22.85A6.75 6.75 0 1 1 5.15 1.67a.75.75 0 0 1 1.05.13z" />
    </svg>
  )
}

function IconMonitor() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M1.75 2.5A1.75 1.75 0 0 0 0 4.25v6.5A1.75 1.75 0 0 0 1.75 12.5H6.5v1H4.75a.75.75 0 0 0 0 1.5h6.5a.75.75 0 0 0 0-1.5H9.5v-1h4.75A1.75 1.75 0 0 0 16 10.75v-6.5A1.75 1.75 0 0 0 14.25 2.5h-12.5zM1.5 4.25c0-.14.11-.25.25-.25h12.5c.14 0 .25.11.25.25v6.5a.25.25 0 0 1-.25.25H1.75a.25.25 0 0 1-.25-.25v-6.5z" />
    </svg>
  )
}

function ThemeIcon({ theme }: { theme: ThemePreference }) {
  if (theme === 'dark') return <IconMoon />
  if (theme === 'light') return <IconSun />
  return <IconMonitor />
}

export function Toolbar({
  isMac,
  fileName,
  folderName,
  dirty,
  viewMode,
  theme,
  canSave,
  sidebarOpen,
  onToggleSidebar,
  onOpenFolder,
  onSave,
  onViewModeChange,
  onThemeChange,
  onNewFile,
  onCommandCenter,
  fontFamily,
  onFontChange,
  fontSize,
  onFontSizeChange,
}: ToolbarProps) {
  const [fonts, setFonts] = useState<string[]>(() => {
    const presets: string[] = [...PRESET_FONTS]
    return presets.includes(fontFamily) ? presets : [fontFamily, ...presets]
  })

  useEffect(() => {
    let cancelled = false
    void listAvailableFonts().then((list) => {
      if (cancelled) return
      setFonts((prev) => {
        const extra = prev.filter((font) => !list.includes(font))
        return extra.length > 0 ? [...extra, ...list] : list
      })
    })
    return () => {
      cancelled = true
    }
  }, [])
  const shortcut = isMac ? '⌘P' : 'Ctrl+P'
  const title = folderName
    ? fileName
      ? `${folderName} / ${fileName}`
      : folderName
    : '打开文件夹开始写作'
  const nextTheme = THEME_CYCLE[(THEME_CYCLE.indexOf(theme) + 1) % THEME_CYCLE.length]

  return (
    <header className={`toolbar${isMac ? ' is-mac' : ''}`} data-tauri-drag-region>
      <div className="toolbar-left">
        <button
          type="button"
          className={`titlebar-btn${sidebarOpen ? ' active' : ''}`}
          title={sidebarOpen ? `隐藏侧边栏（${isMac ? '⌘B' : 'Ctrl+B'}）` : `显示侧边栏（${isMac ? '⌘B' : 'Ctrl+B'}）`}
          aria-pressed={sidebarOpen}
          onClick={onToggleSidebar}
        >
          <IconSidebar active={sidebarOpen} />
        </button>
        <button
          type="button"
          className="titlebar-btn"
          title="打开文件夹"
          onClick={onOpenFolder}
        >
          <IconFolder />
        </button>
        <button type="button" className="titlebar-btn" title="新建文件" onClick={onNewFile}>
          <IconPlus />
        </button>
      </div>

      <button
        type="button"
        className="command-center"
        title="搜索文件"
        onClick={onCommandCenter}
      >
        <span className="command-center-title">
          {fileName ? (
            <>
              {folderName && <span className="command-center-folder">{folderName}</span>}
              {folderName && <span className="command-center-sep">/</span>}
              <span className="command-center-file">{fileName}</span>
              {dirty && <span className="dirty-dot" title="未保存" />}
            </>
          ) : (
            <span className="command-center-placeholder">{title}</span>
          )}
        </span>
        <kbd className="command-center-key">{shortcut}</kbd>
      </button>

      <div className="toolbar-right">
        <button
          type="button"
          className={`titlebar-btn${dirty ? ' accent' : ''}`}
          title="保存"
          disabled={!canSave || !dirty}
          onClick={onSave}
        >
          <IconSave />
        </button>

        <div className="view-toggle" role="group" aria-label="视图模式">
          {(
            [
              ['edit', '编辑'],
              ['split', '分屏'],
              ['preview', '预览'],
            ] as const
          ).map(([mode, label]) => (
            <button
              key={mode}
              type="button"
              className={viewMode === mode ? 'active' : ''}
              onClick={() => onViewModeChange(mode)}
            >
              {label}
            </button>
          ))}
        </div>

        <label className="font-select-wrap" title="编辑与预览字体">
          <select
            className="font-select"
            aria-label="字体"
            value={fontFamily}
            onChange={(e) => onFontChange(e.target.value)}
          >
            {fonts.map((font) => (
              <option key={font} value={font} style={{ fontFamily: font }}>
                {font}
              </option>
            ))}
          </select>
        </label>

        <div className="font-size-control" title="编辑与预览字号">
          <button
            type="button"
            className="titlebar-btn"
            aria-label="减小字号"
            disabled={fontSize <= FONT_SIZE_MIN}
            onClick={() => onFontSizeChange(fontSize - 1)}
          >
            A−
          </button>
          <span className="font-size-value" aria-live="polite">
            {fontSize}
          </span>
          <button
            type="button"
            className="titlebar-btn"
            aria-label="增大字号"
            disabled={fontSize >= FONT_SIZE_MAX}
            onClick={() => onFontSizeChange(fontSize + 1)}
          >
            A+
          </button>
        </div>

        <button
          type="button"
          className="titlebar-btn"
          title={`主题：${THEME_LABEL[theme]}（点击切换）`}
          onClick={() => onThemeChange(nextTheme)}
        >
          <ThemeIcon theme={theme} />
        </button>
      </div>
    </header>
  )
}
