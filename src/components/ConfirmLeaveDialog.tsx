import { useEffect, useRef } from 'react'

interface ConfirmLeaveDialogProps {
  fileName: string
  onSave: () => void
  onDiscard: () => void
  onCancel: () => void
}

export function ConfirmLeaveDialog({
  fileName,
  onSave,
  onDiscard,
  onCancel,
}: ConfirmLeaveDialogProps) {
  const saveRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    saveRef.current?.focus()
  }, [])

  return (
    <div className="dialog-backdrop" onClick={onCancel}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="leave-dialog-title"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel()
          if (e.key === 'Enter') onSave()
        }}
      >
        <h2 id="leave-dialog-title">尚未保存</h2>
        <p className="dialog-message">
          「{fileName}」有未保存的更改。要保存后再离开吗？
        </p>
        <div className="dialog-actions leave-actions">
          <button type="button" className="tool-btn" onClick={onDiscard}>
            不保存
          </button>
          <div className="dialog-actions-end">
            <button type="button" className="tool-btn" onClick={onCancel}>
              取消
            </button>
            <button
              ref={saveRef}
              type="button"
              className="tool-btn primary"
              onClick={onSave}
            >
              保存
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
