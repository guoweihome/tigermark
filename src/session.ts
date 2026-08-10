const STORAGE_KEY = 'tigermark.session'

export interface SessionState {
  rootPath: string
  expandedPaths: string[]
  activePath: string | null
}

export function readSession(): SessionState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<SessionState>
    if (typeof parsed.rootPath !== 'string' || !parsed.rootPath) return null
    return {
      rootPath: parsed.rootPath,
      expandedPaths: Array.isArray(parsed.expandedPaths)
        ? parsed.expandedPaths.filter((p): p is string => typeof p === 'string')
        : [],
      activePath: typeof parsed.activePath === 'string' ? parsed.activePath : null,
    }
  } catch {
    return null
  }
}

export function writeSession(session: SessionState) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(session))
}

export function clearSession() {
  localStorage.removeItem(STORAGE_KEY)
}
