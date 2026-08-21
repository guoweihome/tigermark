import { useEffect, useState } from 'react'

export type ThemePreference = 'light' | 'dark' | 'system'

const STORAGE_KEY = 'tigermark.theme'

function systemPrefersDark() {
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

function resolveTheme(preference: ThemePreference): 'light' | 'dark' {
  if (preference === 'system') {
    return systemPrefersDark() ? 'dark' : 'light'
  }
  return preference
}

function readStoredPreference(): ThemePreference {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (raw === 'light' || raw === 'dark' || raw === 'system') return raw
  return 'system'
}

export function useTheme() {
  const [preference, setPreferenceState] = useState<ThemePreference>(() =>
    typeof window === 'undefined' ? 'system' : readStoredPreference(),
  )
  const [resolved, setResolved] = useState<'light' | 'dark'>(() =>
    typeof window === 'undefined' ? 'light' : resolveTheme(readStoredPreference()),
  )

  useEffect(() => {
    const apply = () => {
      const next = resolveTheme(preference)
      setResolved(next)
      document.documentElement.setAttribute('data-theme', next)
      document.documentElement.style.colorScheme = next
    }
    apply()
    void window.tigermark?.setNativeTheme?.(preference)

    if (preference !== 'system') return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => apply()
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [preference])

  const setPreference = (next: ThemePreference) => {
    localStorage.setItem(STORAGE_KEY, next)
    setPreferenceState(next)
  }

  return { preference, resolved, setPreference }
}
