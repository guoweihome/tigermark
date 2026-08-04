# TigerMark

跨平台桌面 Markdown 编辑器（Windows / macOS / Linux）。

## 功能

- 左侧目录树：打开本地文件夹，浏览 / 新建 / 重命名 / 删除 Markdown 文件与子目录
- 右侧编辑与预览：CodeMirror 编辑、实时渲染预览，支持仅编辑 / 分屏 / 仅预览
- 快捷键：`Ctrl/⌘+O` 打开文件夹，`Ctrl/⌘+S` 保存，`Ctrl/⌘+1/2/3` 切换视图

## 开发

```bash
npm install
npm run dev
```

## 打包

```bash
npm run dist
```

产物输出到 `release/`，按当前平台生成安装包（macOS dmg、Windows nsis、Linux AppImage/deb）。

## 技术栈

Electron · Vite · React · TypeScript · CodeMirror · marked
