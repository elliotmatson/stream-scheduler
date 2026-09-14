import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { ConfigField } from './api.ts'

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

export function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: ReactNode
}): ReactNode {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  )
}

/**
 * Renders a plugin's declared config fields.
 *
 * Every device, streaming service and alert channel describes its settings as
 * data, and this is the only place that turns those into inputs — so adding a
 * plugin needs no UI work, and a plugin cannot invent a widget that behaves
 * differently from every other one.
 */
export function ConfigFields({
  fields,
  values,
  onChange,
}: {
  fields: ConfigField[]
  values: Record<string, unknown>
  onChange: (values: Record<string, unknown>) => void
}): ReactNode {
  const set = (id: string, value: unknown): void => onChange({ ...values, [id]: value })

  return (
    <>
      {fields.map((field) => {
        if (field.type === 'static-text') {
          return (
            <p key={field.id} className="muted" style={{ margin: 0 }}>
              {field.value}
            </p>
          )
        }

        const hint = field.tooltip
        const label = 'required' in field && field.required ? `${field.label} *` : field.label

        if (field.type === 'checkbox') {
          return (
            <label key={field.id} className="row" style={{ gap: 8 }}>
              <input
                type="checkbox"
                checked={Boolean(values[field.id] ?? field.default ?? false)}
                onChange={(event) => set(field.id, event.target.checked)}
              />
              <span>{field.label}</span>
            </label>
          )
        }

        if (field.type === 'dropdown') {
          return (
            <Field key={field.id} label={label} hint={hint}>
              <select
                value={String(values[field.id] ?? field.default ?? field.choices[0]?.id ?? '')}
                onChange={(event) => set(field.id, event.target.value)}
              >
                {field.choices.map((choice) => (
                  <option key={choice.id} value={choice.id}>
                    {choice.label}
                  </option>
                ))}
              </select>
            </Field>
          )
        }

        if (field.type === 'number') {
          return (
            <Field key={field.id} label={label} hint={hint}>
              <input
                type="number"
                min={field.min}
                max={field.max}
                value={String(values[field.id] ?? field.default ?? '')}
                onChange={(event) =>
                  // An empty box is "unset", not zero: coercing it would
                  // silently store a port of 0.
                  set(field.id, event.target.value === '' ? undefined : Number(event.target.value))
                }
              />
            </Field>
          )
        }

        return (
          <Field key={field.id} label={label} hint={hint}>
            <input
              type={field.type === 'secret' ? 'password' : 'text'}
              autoComplete={field.type === 'secret' ? 'new-password' : 'off'}
              value={String(values[field.id] ?? ('default' in field ? (field.default ?? '') : ''))}
              onChange={(event) => set(field.id, event.target.value)}
            />
          </Field>
        )
      })}
    </>
  )
}

/**
 * A delete button that asks first.
 *
 * Removing a device or an event is a click away from a screen an operator
 * uses under time pressure, and there is no undo.
 */
export function ConfirmButton({
  label,
  confirmLabel,
  disabled,
  onConfirm,
}: {
  label: string
  confirmLabel?: string
  disabled?: boolean
  onConfirm: () => void
}): ReactNode {
  const [armed, setArmed] = useState(false)

  useEffect(() => {
    if (!armed) return
    const timer = setTimeout(() => setArmed(false), 5000)
    return () => clearTimeout(timer)
  }, [armed])

  return (
    <button
      className="danger"
      disabled={disabled}
      onClick={() => {
        if (armed) onConfirm()
        setArmed(!armed)
      }}
    >
      {armed ? (confirmLabel ?? 'Really remove?') : label}
    </button>
  )
}
