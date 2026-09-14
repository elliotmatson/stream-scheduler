import type { ReactNode } from 'react'

/**
 * Inline 16px icons, stroked in `currentColor` so they follow the theme and
 * the nav's active state without a second set for dark.
 *
 * Hand-drawn rather than pulled from an icon package: nine glyphs is not
 * worth a dependency, and a bundled icon font would be the largest asset in
 * an app that otherwise ships under 200 kB.
 */
function Glyph({ children }: { children: ReactNode }): ReactNode {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  )
}

/** A gauge: what is happening right now, at a glance. */
export function IconNow(): ReactNode {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M4 18a8 8 0 1 1 16 0" strokeLinecap="round" />
      <path d="M12 18 15.5 11" strokeLinecap="round" />
    </svg>
  )
}

export function IconSchedule(): ReactNode {
  return (
    <Glyph>
      <rect x="2" y="3" width="12" height="11" rx="2" />
      <path d="M2 6.5h12M5.5 1.5v3M10.5 1.5v3" />
    </Glyph>
  )
}

export function IconEvents(): ReactNode {
  return (
    <Glyph>
      <path d="M2.5 4h11M2.5 8h11M2.5 12h7" />
      <circle cx="12.5" cy="12" r="1.5" />
    </Glyph>
  )
}

export function IconDevices(): ReactNode {
  return (
    <Glyph>
      <rect x="1.5" y="3.5" width="13" height="9" rx="2" />
      <path d="M4.5 7h3M4.5 9.5h5" />
      <circle cx="12" cy="7" r="1" />
    </Glyph>
  )
}

export function IconServices(): ReactNode {
  return (
    <Glyph>
      <path d="M8 2v12" />
      <path d="M4.6 4.6a4.8 4.8 0 0 0 0 6.8M11.4 4.6a4.8 4.8 0 0 1 0 6.8" />
      <circle cx="8" cy="8" r="1.5" />
    </Glyph>
  )
}

export function IconRuns(): ReactNode {
  return (
    <Glyph>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.5V8l2.5 1.5" />
    </Glyph>
  )
}

export function IconAlerts(): ReactNode {
  return (
    <Glyph>
      <path d="M4 6.5a4 4 0 0 1 8 0c0 2.6.8 3.8 1.3 4.4.2.3 0 .6-.3.6H3c-.3 0-.5-.3-.3-.6.5-.6 1.3-1.8 1.3-4.4Z" />
      <path d="M6.5 13.5a1.8 1.8 0 0 0 3 0" />
    </Glyph>
  )
}

export function IconSystem(): ReactNode {
  return (
    <Glyph>
      <rect x="1.5" y="2.5" width="13" height="9" rx="1.5" />
      <path d="M5.5 14h5" />
    </Glyph>
  )
}

export function IconSun(): ReactNode {
  return (
    <Glyph>
      <circle cx="8" cy="8" r="3" />
      <path d="M8 1v1.5M8 13.5V15M15 8h-1.5M2.5 8H1M12.9 3.1l-1 1M4.1 11.9l-1 1M12.9 12.9l-1-1M4.1 4.1l-1-1" />
    </Glyph>
  )
}

export function IconMoon(): ReactNode {
  return (
    <Glyph>
      <path d="M13.2 9.6A5.6 5.6 0 0 1 6.4 2.8a5.6 5.6 0 1 0 6.8 6.8Z" />
    </Glyph>
  )
}

/** The brand mark: a play triangle inside the sidebar's rounded square. */
export function IconBrand(): ReactNode {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" focusable="false">
      <path d="M5.4 3.3a.8.8 0 0 1 1.2-.7l5.6 4.1a.8.8 0 0 1 0 1.3l-5.6 4.1a.8.8 0 0 1-1.2-.7V3.3Z" />
    </svg>
  )
}
