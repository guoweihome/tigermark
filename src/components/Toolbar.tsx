import type { ViewMode } from '../vite-env'
import type { ThemePreference } from '../theme'

interface ToolbarProps {
  fileName: string | null
  dirty: boolean
  viewMode: ViewMode
  theme: ThemePreference
  canSave: boolean
  onOpenFolder: () => void
  onSave: () => void
  onViewModeChange: (mode: ViewMode) => void
  onThemeChange: (theme: ThemePreference) => void
  onNewFile: () => void
}

const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '暗色' },
  { value: 'system', label: '系统' },
]

export function Toolbar({
  fileName,
  dirty,
  viewMode,
  theme,
  canSave,
  onOpenFolder,
  onSave,
  onViewModeChange,
  onThemeChange,
  onNewFile,
}: ToolbarProps) {
  return (
    <header className="toolbar">
      <div className="toolbar-brand">
        <span className="brand-mark">TM</span>
        <span className="brand-name">TigerMark</span>
      </div>

      <div className="toolbar-file">
        {fileName ? (
          <>
            <span className="file-name">{fileName}</span>
            {dirty && <span className="dirty-dot" title="未保存" />}
          </>
        ) : (
          <span className="file-name muted">无打开文件</span>
        )}
      </div>

      <div className="toolbar-actions">
        <button type="button" className="tool-btn" onClick={onOpenFolder}>
          打开文件夹
        </button>
        <button type="button" className="tool-btn" onClick={onNewFile}>
          新建
        </button>
        <button
          type="button"
          className="tool-btn primary"
          disabled={!canSave || !dirty}
          onClick={onSave}
        >
          保存
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

        <div className="view-toggle" role="group" aria-label="主题">
          {THEME_OPTIONS.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              className={theme === value ? 'active' : ''}
              onClick={() => onThemeChange(value)}
              title={label}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
    </header>
  )
}
