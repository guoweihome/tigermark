interface EditorToolbarProps {
  disabled?: boolean
  onHeading: (level: number) => void
  onInsertTable: () => void
  onFormatJson: () => void
}

export function EditorToolbar({
  disabled,
  onHeading,
  onInsertTable,
  onFormatJson,
}: EditorToolbarProps) {
  return (
    <div className="editor-toolbar" role="toolbar" aria-label="编辑工具">
      <div className="editor-toolbar-group" role="group" aria-label="标题">
        {([1, 2, 3] as const).map((level) => (
          <button
            key={level}
            type="button"
            className="editor-tool-btn"
            title={`标题 ${level}（单独成行）`}
            disabled={disabled}
            onClick={() => onHeading(level)}
          >
            H{level}
          </button>
        ))}
      </div>

      <span className="editor-toolbar-sep" aria-hidden />

      <div className="editor-toolbar-group" role="group" aria-label="插入">
        <button
          type="button"
          className="editor-tool-btn"
          title="插入表格"
          disabled={disabled}
          onClick={onInsertTable}
        >
          表格
        </button>
        <button
          type="button"
          className="editor-tool-btn"
          title="格式化 JSON（选中内容或光标所在对象）"
          disabled={disabled}
          onClick={onFormatJson}
        >
          JSON 格式化
        </button>
      </div>
    </div>
  )
}
