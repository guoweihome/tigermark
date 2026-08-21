import { app, dialog } from 'electron'
import { autoUpdater } from 'electron-updater'

const UPDATE_FEED =
  process.env.TIGERMARK_UPDATE_URL ?? 'https://www.pytiger.com/tigermark/updates'

let manualCheck = false
let checking = false

function setupFeed() {
  autoUpdater.setFeedURL({
    provider: 'generic',
    url: UPDATE_FEED,
  })
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
}

export function setupAutoUpdater() {
  if (!app.isPackaged) return

  setupFeed()

  autoUpdater.on('update-available', (info) => {
    void dialog
      .showMessageBox({
        type: 'info',
        title: '发现新版本',
        message: `TigerMark ${info.version} 已发布`,
        detail: '下载完成后可以重启安装。当前编辑中的文件请先保存。',
        buttons: ['立即更新', '稍后'],
        defaultId: 0,
        cancelId: 1,
      })
      .then(({ response }) => {
        if (response === 0) void autoUpdater.downloadUpdate()
      })
  })

  autoUpdater.on('update-not-available', () => {
    if (!manualCheck) return
    void dialog.showMessageBox({
      type: 'info',
      title: '检查更新',
      message: '已是最新版本',
      detail: `当前版本 ${app.getVersion()}`,
    })
  })

  autoUpdater.on('update-downloaded', (info) => {
    void dialog
      .showMessageBox({
        type: 'info',
        title: '更新已就绪',
        message: `新版本 ${info.version} 已下载完成`,
        detail: '重启后完成安装。未保存的更改会先提示保存。',
        buttons: ['立即重启', '稍后'],
        defaultId: 0,
        cancelId: 1,
      })
      .then(({ response }) => {
        if (response === 0) autoUpdater.quitAndInstall()
      })
  })

  autoUpdater.on('error', (error) => {
    if (!manualCheck) return
    void dialog.showMessageBox({
      type: 'error',
      title: '检查更新失败',
      message: '暂时无法检查更新',
      detail: error.message,
    })
  })

  setTimeout(() => {
    void checkForUpdates(false)
  }, 5000)
}

export async function checkForUpdates(fromMenu = true) {
  if (!app.isPackaged) {
    if (fromMenu) {
      await dialog.showMessageBox({
        type: 'info',
        title: '检查更新',
        message: '开发模式不会自动更新',
        detail: '安装正式包之后，启动时会检查新版本。',
      })
    }
    return
  }

  if (checking) return
  checking = true
  manualCheck = fromMenu
  setupFeed()
  try {
    await autoUpdater.checkForUpdates()
  } catch (error) {
    if (fromMenu) {
      const message = error instanceof Error ? error.message : String(error)
      await dialog.showMessageBox({
        type: 'error',
        title: '检查更新失败',
        message: '暂时无法检查更新',
        detail: message,
      })
    }
  } finally {
    checking = false
  }
}
