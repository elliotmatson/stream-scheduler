import type { ReactNode } from 'react'

export function StatusPill({ status }: { status: string }): ReactNode {
  return <span className={`pill ${toneFor(status)}`}>{label(status)}</span>
}

/** Maps every run, occurrence and device state onto one of four tones. */
export function toneFor(status: string): string {
  switch (status) {
    case 'live':
      return 'live'
    case 'completed':
    case 'done':
    case 'ready':
    case 'connected':
    case 'ok':
      return 'ok'
    case 'failed':
    case 'disconnected':
    case 'reauth_required':
      return 'bad'
    case 'preparing':
    case 'starting':
    case 'stopping':
    case 'completing':
    case 'running':
    case 'degraded':
      return 'warn'
    default:
      return ''
  }
}

function label(status: string): string {
  return status.replace(/_/g, ' ')
}

export function ErrorBanner({ error }: { error: string | undefined }): ReactNode {
  if (!error) return null
  return (
    <div className="banner error" role="alert">
      {error}
    </div>
  )
}

export function Empty({ children }: { children: ReactNode }): ReactNode {
  return <div className="empty">{children}</div>
}

export function Card({ title, children }: { title?: string; children: ReactNode }): ReactNode {
  return (
    <section className="card">
      {title ? <h2>{title}</h2> : null}
      {children}
    </section>
  )
}
