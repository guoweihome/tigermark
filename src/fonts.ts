export const DEFAULT_FONT = 'IBM Plex Sans'

export const PRESET_FONTS = [
  'IBM Plex Sans',
  'JetBrains Mono',
  'Fraunces',
  'PingFang SC',
  'Hiragino Sans GB',
  'Songti SC',
  'STSong',
  'Noto Serif SC',
  'Noto Sans SC',
  'Georgia',
  'Times New Roman',
  'Palatino',
  'system-ui',
] as const

const GENERIC = new Set([
  'serif',
  'sans-serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui',
  'ui-sans-serif',
  'ui-serif',
  'ui-monospace',
  'ui-rounded',
])

export function cssFontFamily(name: string) {
  const trimmed = name.trim() || DEFAULT_FONT
  if (GENERIC.has(trimmed.toLowerCase())) {
    return `${trimmed}, var(--font-sans)`
  }
  const escaped = trimmed.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  return `"${escaped}", var(--font-sans)`
}

export async function listAvailableFonts(): Promise<string[]> {
  const families = new Set<string>(PRESET_FONTS)
  const query = window.queryLocalFonts
  if (typeof query !== 'function') return [...families]
  try {
    const fonts = await query()
    for (const font of fonts) {
      if (font.family) families.add(font.family)
    }
  } catch {
    // permission denied or unsupported
  }
  return [...families].sort((a, b) => a.localeCompare(b, 'zh-CN'))
}

export function revealInFolderLabel(platform: string) {
  if (platform === 'darwin') return '在访达中显示'
  if (platform === 'win32') return '在资源管理器中显示'
  return '打开所在位置'
}
