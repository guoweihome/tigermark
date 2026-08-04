import { useState } from 'react'
import type { FileEntry } from '../vite-env'

interface FileTreeProps {
  entries: FileEntry[]
  activePath: string | null
  onOpenFile: (path: string) => void
  onCreateFile: (dirPath: string) => void
  onCreateFolder: (dirPath: string) => void
  onDelete: (entry: FileEntry) => void
  onRename: (entry: FileEntry) => void
  depth?: number
}

export function FileTree(props: FileTreeProps) {
  return (
    <ul className="file-tree" role="tree">
      {props.entries.map((entry) => (
        <TreeNode key={entry.path} entry={entry} {...props} />
      ))}
    </ul>
  )
}

function TreeNode({
  entry,
  activePath,
  onOpenFile,
  onCreateFile,
  onCreateFolder,
  onDelete,
  onRename,
  depth = 0,
}: FileTreeProps & { entry: FileEntry }) {
  const [expanded, setExpanded] = useState(depth < 1)
  const [menuOpen, setMenuOpen] = useState(false)
  const isActive = activePath === entry.path

  if (entry.isDirectory) {
    return (
      <li role="treeitem" aria-expanded={expanded} className="tree-node">
        <div
          className={`tree-row ${isActive ? 'active' : ''}`}
          style={{ paddingLeft: 10 + depth * 14 }}
          onClick={() => setExpanded((v) => !v)}
          onContextMenu={(e) => {
            e.preventDefault()
            setMenuOpen(true)
          }}
        >
          <span className="chevron">{expanded ? '▾' : '▸'}</span>
          <span className="node-icon folder">{expanded ? '📂' : '📁'}</span>
          <span className="node-name">{entry.name}</span>
          <button
            type="button"
            className="node-more"
            title="更多"
            onClick={(e) => {
              e.stopPropagation()
              setMenuOpen((v) => !v)
            }}
          >
            ···
          </button>
        </div>

        {menuOpen && (
          <ContextMenu
            onClose={() => setMenuOpen(false)}
            actions={[
              { label: '新建文件', onClick: () => onCreateFile(entry.path) },
              { label: '新建文件夹', onClick: () => onCreateFolder(entry.path) },
              { label: '重命名', onClick: () => onRename(entry) },
              { label: '删除', onClick: () => onDelete(entry), danger: true },
            ]}
          />
        )}

        {expanded && entry.children && entry.children.length > 0 && (
          <ul role="group">
            {entry.children.map((child) => (
              <TreeNode
                key={child.path}
                entry={child}
                entries={[]}
                activePath={activePath}
                onOpenFile={onOpenFile}
                onCreateFile={onCreateFile}
                onCreateFolder={onCreateFolder}
                onDelete={onDelete}
                onRename={onRename}
                depth={depth + 1}
              />
            ))}
          </ul>
        )}
      </li>
    )
  }

  return (
    <li role="treeitem" className="tree-node">
      <div
        className={`tree-row ${isActive ? 'active' : ''}`}
        style={{ paddingLeft: 10 + depth * 14 }}
        onClick={() => onOpenFile(entry.path)}
        onContextMenu={(e) => {
          e.preventDefault()
          setMenuOpen(true)
        }}
      >
        <span className="chevron spacer" />
        <span className="node-icon file">📄</span>
        <span className="node-name">{entry.name}</span>
        <button
          type="button"
          className="node-more"
          title="更多"
          onClick={(e) => {
            e.stopPropagation()
            setMenuOpen((v) => !v)
          }}
        >
          ···
        </button>
      </div>

      {menuOpen && (
        <ContextMenu
          onClose={() => setMenuOpen(false)}
          actions={[
            { label: '重命名', onClick: () => onRename(entry) },
            { label: '删除', onClick: () => onDelete(entry), danger: true },
          ]}
        />
      )}
    </li>
  )
}

function ContextMenu({
  actions,
  onClose,
}: {
  actions: { label: string; onClick: () => void; danger?: boolean }[]
  onClose: () => void
}) {
  return (
    <>
      <div className="menu-backdrop" onClick={onClose} />
      <div className="context-menu">
        {actions.map((action) => (
          <button
            key={action.label}
            type="button"
            className={action.danger ? 'danger' : ''}
            onClick={() => {
              onClose()
              action.onClick()
            }}
          >
            {action.label}
          </button>
        ))}
      </div>
    </>
  )
}
