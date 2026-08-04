import { useEffect, useRef, useState } from 'react'

interface NameDialogProps {
  title: string
  label?: string
  defaultValue?: string
  confirmLabel?: string
  onConfirm: (value: string) => void
  onCancel: () => void
}

export function NameDialog({
  title,
  label = '名称',
  defaultValue = '',
  confirmLabel = '确定',
  onConfirm,
  onCancel,
}: NameDialogProps) {
  const [value, setValue] = useState(defaultValue)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const input = inputRef.current
    if (!input) return
    input.focus()
    input.select()
  }, [])

  const submit = () => {
    const trimmed = value.trim()
    if (!trimmed) return
    onConfirm(trimmed)
  }

  return (
    <div className="dialog-backdrop" onClick={onCancel}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="name-dialog-title"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel()
          if (e.key === 'Enter') submit()
        }}
      >
        <h2 id="name-dialog-title">{title}</h2>
        <label className="dialog-field">
          <span>{label}</span>
          <input
            ref={inputRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            spellCheck={false}
          />
        </label>
        <div className="dialog-actions">
          <button type="button" className="tool-btn" onClick={onCancel}>
            取消
          </button>
          <button
            type="button"
            className="tool-btn primary"
            disabled={!value.trim()}
            onClick={submit}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
