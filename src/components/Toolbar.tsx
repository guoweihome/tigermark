import type { ViewMode } from '../vite-env'
import type { ThemePreference } from '../theme'
import {
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  PRESET_FONTS,
  listAvailableFonts,
} from '../fonts'
import { useEffect, useState } from 'react'
import {
  IconFolder,
  IconMonitor,
  IconMoon,
  IconPlus,
  IconSave,
  IconSidebar,
  IconSun,
} from './icons'

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
          <IconSidebar />
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
