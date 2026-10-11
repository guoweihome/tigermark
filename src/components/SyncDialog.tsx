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

  const setSharing = async (enabled: boolean) => {
    await window.tigermark.setSyncSharing(enabled)
    const next = await window.tigermark.getSyncInfo()
    setInfo(next)
  }

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
          两台设备连同一个 Wi-Fi。在这边点「开始同步」后，另一台 TigerMark 会自动发现并连上，把这边的笔记同步过去。电脑上开启就同步到手机，手机上开启就同步到电脑。
        </p>
        {info?.error ? (
          <p className="sync-error">{info.error}</p>
        ) : info?.sharing ? (
          <button type="button" className="sync-url" onClick={() => void copy()}>
            {info.pageUrl || '正在获取地址…'}
          </button>
        ) : (
          <p className="sync-meta">尚未开始。开始后，对方打开 TigerMark 就会自动连上。</p>
        )}
        {info && !info.workspaceOpen && (
          <p className="sync-error">请先打开一个文件夹，再把笔记同步出去。</p>
        )}
        <p className="sync-meta">
          {info?.sharing
            ? `正在同步 · 已连接 ${info.clients} 台设备`
            : '未开启。对方若已开始同步，这边会自动接收'}
          {info?.host ? ` · ${info.host}` : ''}
        </p>
        <div className="dialog-actions">
          <button type="button" className="tool-btn" onClick={onClose}>
            关闭
          </button>
          {info?.sharing ? (
            <>
              <button
                type="button"
                className="tool-btn"
                disabled={!info.pageUrl}
                onClick={() => void copy()}
              >
                {copied ? '已复制' : '复制地址'}
              </button>
              <button type="button" className="tool-btn primary" onClick={() => void setSharing(false)}>
                停止同步
              </button>
            </>
          ) : (
            <button
              type="button"
              className="tool-btn primary"
              disabled={!info?.workspaceOpen}
              onClick={() => void setSharing(true)}
            >
              开始同步
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
