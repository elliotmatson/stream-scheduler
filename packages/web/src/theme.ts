import { useCallback, useEffect, useState } from 'react'

/**
 * Theme preference: an explicit choice, or "follow the machine".
 *
 * `system` is the default and is a real third state rather than a snapshot of
 * the OS setting at first load — an operator whose desktop flips to dark at
 * dusk should see the same thing happen here, and a booth machine pinned to
 * dark should stay dark whatever the OS does.
 */
export type ThemePreference = 'system' | 'light' | 'dark'

const STORAGE_KEY = 'scheduler.theme'
const DARK_QUERY = '(prefers-color-scheme: dark)'

export function readStoredTheme(): ThemePreference {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored
  } catch {
    // Private browsing, or storage disabled. The default is still correct.
  }
  return 'system'
}

/**
 * Writes the preference onto `<html>`.
 *
 * `system` removes the attribute rather than resolving it, so the CSS media
 * query stays in charge and the page follows the OS with no JavaScript at
 * all — including before this module has run. See the inline script in
 * index.html.
 */
export function applyTheme(preference: ThemePreference): void {
  const root = document.documentElement
  if (preference === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', preference)
}

export interface Theme {
  preference: ThemePreference
  /** What is actually on screen right now, with `system` resolved. */
  resolved: 'light' | 'dark'
  setPreference: (next: ThemePreference) => void
}

export function useTheme(): Theme {
  const [preference, setStored] = useState<ThemePreference>(readStoredTheme)
  const [systemDark, setSystemDark] = useState(
    () => typeof window.matchMedia === 'function' && window.matchMedia(DARK_QUERY).matches,
  )

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const query = window.matchMedia(DARK_QUERY)
    const onChange = (event: MediaQueryListEvent): void => setSystemDark(event.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])

  const setPreference = useCallback((next: ThemePreference) => {
    setStored(next)
    applyTheme(next)
    try {
      window.localStorage.setItem(STORAGE_KEY, next)
    } catch {
      // The choice still applies to this tab; it just will not be remembered.
    }
  }, [])

  useEffect(() => {
    applyTheme(preference)
  }, [preference])

  return {
    preference,
    resolved: preference === 'system' ? (systemDark ? 'dark' : 'light') : preference,
    setPreference,
  }
}
