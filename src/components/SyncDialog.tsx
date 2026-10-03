import { useEffect, useState } from 'react'
import type { SyncInfo } from '../vite-env'

interface SyncDialogProps {
  onClose: () => void
}

export function SyncDialog({ onClose }: SyncDialogProps) {
  const [info, setInfo] = useState<SyncInfo | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let stop = false
    const tick = async () => {
      const next = await window.tigermark.getSyncInfo()
      if (!stop) setInfo(next)
    }
    void tick()
    const timer = window.setInterval(() => void tick(), 2000)
    return () => {
      stop = true
      window.clearInterval(timer)
    }
  }, [])

  const copy = async () => {
    if (!info?.pageUrl) return
    try {
      await navigator.clipboard.writeText(info.pageUrl)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="dialog-backdrop" onMouseDown={onClose}>
      <div
        className="dialog sync-dialog"
        role="dialog"
        aria-labelledby="sync-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 id="sync-title">局域网同步</h2>
        <p className="dialog-message">
          手机和电脑连同一个 Wi-Fi。用手机浏览器打开下面的地址，即可查看和编辑当前文件夹里的笔记。保存后两边会互相更新。
        </p>
        {info?.error ? (
          <p className="sync-error">{info.error}</p>
        ) : (
          <button type="button" className="sync-url" onClick={() => void copy()}>
            {info?.pageUrl || '正在获取地址…'}
          </button>
        )}
        <p className="sync-meta">
          {info ? `已连接 ${info.clients} 台设备` : '正在检查连接'}
          {info?.host ? ` · ${info.host}` : ''}
        </p>
        <div className="dialog-actions">
          <button type="button" className="tool-btn" onClick={onClose}>
            关闭
          </button>
          <button
            type="button"
            className="tool-btn primary"
            disabled={!info?.pageUrl}
            onClick={() => void copy()}
          >
            {copied ? '已复制' : '复制地址'}
          </button>
        </div>
      </div>
    </div>
  )
}
