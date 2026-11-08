import { useEffect, useState } from 'react'
import type { OneDriveStatus } from '../vite-env'

interface SyncDialogProps {
  rootPath: string | null
  skipPath: string | null
  onClose: () => void
  onDidSync: () => void
}

export function SyncDialog({ rootPath, skipPath, onClose, onDidSync }: SyncDialogProps) {
  const [drive, setDrive] = useState<OneDriveStatus | null>(null)
  const [driveError, setDriveError] = useState('')
  const [driveNote, setDriveNote] = useState('')
  const [driveTask, setDriveTask] = useState<'' | 'login' | 'sync' | 'logout'>('')
  const driveBusy = driveTask !== ''

  useEffect(() => {
    let stop = false
    void window.tigermark.oneDriveStatus().then((result) => {
      if (stop) return
      if (result.ok && result.data) setDrive(result.data)
      else setDrive({ connected: false, enabled: false, account: '' })
    })
    return () => {
      stop = true
    }
  }, [])

  const connectDrive = async () => {
    setDriveTask('login')
    setDriveError('')
    setDriveNote('')
    const result = await window.tigermark.oneDriveLogin()
    setDriveTask('')
    if (!result.ok || !result.data) {
      setDriveError(result.error ?? '连接 OneDrive 失败')
      return
    }
    setDrive(result.data)
  }

  const disconnectDrive = async () => {
    setDriveTask('logout')
    setDriveError('')
    const result = await window.tigermark.oneDriveLogout()
    setDriveTask('')
    if (!result.ok) {
      setDriveError(result.error ?? '断开失败')
      return
    }
    setDrive({ connected: false, enabled: false, account: '' })
    setDriveNote('')
  }

  const syncDrive = async () => {
    if (!rootPath) return
    setDriveTask('sync')
    setDriveError('')
    setDriveNote('')
    const result = await window.tigermark.oneDriveSync(rootPath, skipPath)
    setDriveTask('')
    if (!result.ok || !result.data) {
      setDriveError(result.error ?? '同步失败')
      return
    }
    const report = result.data
    const unsaved = report.unsavedSkipped ? '当前未保存的文件这次没有同步。' : ''
    setDriveNote(
      `已同步到 ${report.folder}：上传 ${report.uploaded} 个，下载 ${report.downloaded} 个。${unsaved}`,
    )
    onDidSync()
  }

  const setDriveEnabled = async (enabled: boolean) => {
    setDriveError('')
    if (!enabled) setDriveNote('')
    const result = await window.tigermark.oneDriveSetEnabled(enabled)
    if (!result.ok || !result.data) {
      setDriveError(result.error ?? '无法切换 OneDrive 同步')
      return
    }
    setDrive(result.data)
    if (enabled) await syncDrive()
  }

  return (
    <div className="dialog-backdrop" onMouseDown={onClose}>
      <div
        className="dialog sync-dialog"
        role="dialog"
        aria-labelledby="sync-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 id="sync-title">OneDrive 同步</h2>
        <p className="dialog-message">
          默认关闭。连接后还要开启同步，才会把当前文件夹和 OneDrive 的 TigerMark 目录对齐。较新的文件会覆盖较旧的，不会删除任何一边的文件。
        </p>
        {!rootPath ? <p className="sync-error">请先打开一个文件夹，再开启同步。</p> : null}
        {drive?.connected ? (
          <p className="sync-meta">
            已连接{drive.account ? `：${drive.account}` : ''}。
            {drive.enabled ? '同步已开启。' : '同步尚未开启。'}
          </p>
        ) : (
          <p className="sync-meta">尚未连接。</p>
        )}
        {driveError ? <p className="sync-error">{driveError}</p> : null}
        {driveNote ? <p className="sync-meta">{driveNote}</p> : null}
        <div className="dialog-actions">
          <button type="button" className="tool-btn" onClick={onClose}>
            关闭
          </button>
          {!drive?.connected ? (
            <button
              type="button"
              className="tool-btn primary"
              disabled={driveBusy}
              onClick={() => void connectDrive()}
            >
              {driveTask === 'login' ? '正在连接…' : '连接 OneDrive'}
            </button>
          ) : drive.enabled ? (
            <>
              <button
                type="button"
                className="tool-btn"
                disabled={driveBusy}
                onClick={() => void setDriveEnabled(false)}
              >
                停止同步
              </button>
              <button
                type="button"
                className="tool-btn primary"
                disabled={driveBusy || !rootPath}
                onClick={() => void syncDrive()}
              >
                {driveTask === 'sync' ? '正在同步…' : '同步笔记'}
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="tool-btn"
                disabled={driveBusy}
                onClick={() => void disconnectDrive()}
              >
                {driveTask === 'logout' ? '正在断开…' : '断开'}
              </button>
              <button
                type="button"
                className="tool-btn primary"
                disabled={driveBusy || !rootPath}
                onClick={() => void setDriveEnabled(true)}
              >
                开始同步
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
