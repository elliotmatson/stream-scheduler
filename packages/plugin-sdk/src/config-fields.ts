import type { JsonValue } from './json.js'

/**
 * Declarative config, so nobody hand-writes a settings form per encoder.
 * The host renders these and validates submitted values against them.
 *
 * `secret` is special: the host routes those values through the vault. A plugin
 * receives the resolved value at call time and never sees the storage path, so
 * it cannot accidentally log or persist one.
 */
export type ConfigField =
  | {
      type: 'textinput'
      id: string
      label: string
      default?: string
      required?: boolean
      regex?: string
      tooltip?: string
    }
  | {
      type: 'number'
      id: string
      label: string
      default?: number
      min?: number
      max?: number
      required?: boolean
      tooltip?: string
    }
  | { type: 'checkbox'; id: string; label: string; default?: boolean; tooltip?: string }
  | {
      type: 'dropdown'
      id: string
      label: string
      choices: { id: string; label: string }[]
      default?: string
      required?: boolean
      tooltip?: string
      /**
       * Names a list only the service can supply — a channel's playlists,
       * say. The host fetches it and offers those alongside `choices`, so a
       * plugin does not have to invent a widget and nobody has to paste an
       * id copied out of a URL.
       */
      choicesFrom?: 'playlists'
    }
  | { type: 'secret'; id: string; label: string; required?: boolean; tooltip?: string }
  | { type: 'static-text'; id: string; label: string; value: string }

export type ConfigValues = Record<string, JsonValue>

export interface ConfigValidationIssue {
  field: string
  message: string
}

/** Validates submitted config against a plugin's declared fields. */
export function validateConfig(
  fields: ConfigField[],
  values: ConfigValues,
): ConfigValidationIssue[] {
  const issues: ConfigValidationIssue[] = []
  for (const field of fields) {
    if (field.type === 'static-text') continue
    const value = values[field.id]
    const missing = value === undefined || value === null || value === ''
    if (missing) {
      if ('required' in field && field.required) {
        issues.push({ field: field.id, message: `${field.label} is required` })
      }
      continue
    }
    switch (field.type) {
      case 'textinput':
        if (typeof value !== 'string')
          issues.push({ field: field.id, message: `${field.label} must be text` })
        else if (field.regex && !new RegExp(field.regex).test(value))
          issues.push({ field: field.id, message: `${field.label} is not in the expected format` })
        break
      case 'number':
        if (typeof value !== 'number' || !Number.isFinite(value))
          issues.push({ field: field.id, message: `${field.label} must be a number` })
        else if (field.min !== undefined && value < field.min)
          issues.push({ field: field.id, message: `${field.label} must be at least ${field.min}` })
        else if (field.max !== undefined && value > field.max)
          issues.push({ field: field.id, message: `${field.label} must be at most ${field.max}` })
        break
      case 'checkbox':
        if (typeof value !== 'boolean')
          issues.push({ field: field.id, message: `${field.label} must be true or false` })
        break
      case 'dropdown':
        if (!field.choices.some((c) => c.id === value))
          issues.push({
            field: field.id,
            message: `${field.label} is not one of the available choices`,
          })
        break
      case 'secret':
        if (typeof value !== 'string')
          issues.push({ field: field.id, message: `${field.label} must be text` })
        break
    }
  }
  return issues
}

/** Fills in declared defaults for anything the user left unset. */
export function applyConfigDefaults(fields: ConfigField[], values: ConfigValues): ConfigValues {
  const out: ConfigValues = { ...values }
  for (const field of fields) {
    if (field.type === 'static-text' || field.type === 'secret') continue
    if (out[field.id] === undefined && field.default !== undefined) out[field.id] = field.default
  }
  return out
}
