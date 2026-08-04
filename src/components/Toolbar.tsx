import type { ViewMode } from '../vite-env'

interface ToolbarProps {
  fileName: string | null
  dirty: boolean
  viewMode: ViewMode
  canSave: boolean
  onOpenFolder: () => void
  onSave: () => void
  onViewModeChange: (mode: ViewMode) => void
  onNewFile: () => void
}

export function Toolbar({
  fileName,
  dirty,
  viewMode,
  canSave,
  onOpenFolder,
  onSave,
  onViewModeChange,
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
      </div>
    </header>
  )
}
