import { TZDate } from '@date-fns/tz'
import { addDays, addHours, addMinutes, addMonths, addWeeks, format as formatDate } from 'date-fns'

export interface TemplateContext {
  /** The occurrence's scheduled start as a UTC instant. */
  occurrenceStart: number
  /** IANA zone of the series this occurrence belongs to. */
  timezone: string
  event: { name: string }
  series: { name: string }
  occurrence: { index: number }
  encoder?: { label: string }
  counters?: Record<string, number>
  /**
   * What the schedule source said about this service.
   *
   * Present only for an occurrence that came from a plan source, and every
   * field inside it is optional, because Planning Center lets a plan have no
   * title and a time have no name. A template asking for one that is not
   * there fails with a message naming the field rather than rendering an
   * empty string — a YouTube broadcast called "Sunday Service — " is worse
   * than a template error at T-30, which is early enough to fix.
   */
  plan?: {
    planTitle?: string
    seriesTitle?: string
    timeName?: string
    planDate?: string
    planUrl?: string
  }
}

export interface TemplateIssue {
  token: string
  message: string
}

export interface RenderResult {
  text: string
  issues: TemplateIssue[]
}

export class TemplateError extends Error {
  readonly issues: TemplateIssue[]
  constructor(issues: TemplateIssue[]) {
    super(
      `Template could not be rendered: ${issues.map((i) => `${i.token} — ${i.message}`).join('; ')}`,
    )
    this.name = 'TemplateError'
    this.issues = issues
  }
}

const TOKEN = /\{\{([^}]*)\}\}/g

/**
 * Renders a name template.
 *
 * Deliberately a small token substitution engine, not a general-purpose
 * template language: an app holding OAuth tokens and stream keys does not need
 * a Turing-complete evaluator, and the expressive power buys nothing here.
 *
 * Everything date-shaped resolves against the occurrence's scheduled start
 * expressed in the *series* timezone — never the server's clock at render
 * time. See docs/plan/06-templating-and-secrets.md.
 */
export function renderTemplate(template: string, ctx: TemplateContext): RenderResult {
  const issues: TemplateIssue[] = []
  const text = template.replace(TOKEN, (whole, body: string) => {
    const raw = body.trim()
    if (raw === '') {
      issues.push({ token: whole, message: 'empty token' })
      return whole
    }
    try {
      const parsed = parseToken(raw)
      return resolve(parsed, ctx)
    } catch (error) {
      issues.push({ token: whole, message: error instanceof Error ? error.message : String(error) })
      return whole
    }
  })
  return { text, issues }
}

/** Used in the prepare phase so a bad template fails at T−30m, not on air. */
export function renderTemplateOrThrow(template: string, ctx: TemplateContext): string {
  const result = renderTemplate(template, ctx)
  if (result.issues.length > 0) throw new TemplateError(result.issues)
  return result.text
}

interface ParsedToken {
  name: string
  positional: string | undefined
  options: Record<string, string>
}

function parseToken(raw: string): ParsedToken {
  const parts = tokenize(raw)
  const name = parts.shift()
  if (!name || name.kind !== 'bare') throw new Error('token must start with a name')

  let positional: string | undefined
  const options: Record<string, string> = {}
  for (const part of parts) {
    if (part.kind === 'quoted') {
      if (positional !== undefined) throw new Error('only one quoted argument is allowed')
      positional = part.value
    } else if (part.kind === 'pair') {
      options[part.key] = part.value
    } else {
      throw new Error(`unexpected "${part.value}"`)
    }
  }
  return { name: name.value, positional, options }
}

type Part =
  | { kind: 'bare'; value: string }
  | { kind: 'quoted'; value: string }
  | { kind: 'pair'; key: string; value: string }

function tokenize(raw: string): Part[] {
  const parts: Part[] = []
  const pattern = /"([^"]*)"|([A-Za-z_][\w.]*)=(?:"([^"]*)"|(\S+))|([A-Za-z_][\w.]*)/g
  let match: RegExpExecArray | null
  let consumed = 0
  while ((match = pattern.exec(raw)) !== null) {
    consumed = pattern.lastIndex
    if (match[1] !== undefined) parts.push({ kind: 'quoted', value: match[1] })
    else if (match[2] !== undefined)
      parts.push({ kind: 'pair', key: match[2], value: match[3] ?? match[4] ?? '' })
    else if (match[5] !== undefined) parts.push({ kind: 'bare', value: match[5] })
  }
  if (raw.slice(consumed).trim() !== '')
    throw new Error(`could not parse "${raw.slice(consumed).trim()}"`)
  return parts
}

function resolve(token: ParsedToken, ctx: TemplateContext): string {
  switch (token.name) {
    case 'date':
      return formatInZone(token, ctx, 'yyyy-MM-dd')
    case 'time':
      return formatInZone(token, ctx, 'h:mm a')
    case 'event.name':
      return ctx.event.name
    case 'series.name':
      return ctx.series.name
    case 'occurrence.index':
      return String(ctx.occurrence.index)
    case 'encoder.label':
      if (!ctx.encoder) throw new Error('no encoder is attached to this event')
      return ctx.encoder.label
    case 'plan.title':
      return planField(ctx, 'planTitle', 'plan title')
    case 'plan.seriesTitle':
      return planField(ctx, 'seriesTitle', 'teaching series')
    case 'plan.timeName':
      return planField(ctx, 'timeName', 'name for this service time')
    case 'plan.date':
      return planField(ctx, 'planDate', 'date')
    case 'plan.url':
      return planField(ctx, 'planUrl', 'link')
    case 'counter': {
      const name = token.positional
      if (!name) throw new Error('counter needs a name, e.g. {{counter "sermons"}}')
      const value = ctx.counters?.[name]
      if (value === undefined) throw new Error(`no counter named "${name}"`)
      const pad = token.options.pad ? Number(token.options.pad) : 0
      if (!Number.isInteger(pad) || pad < 0)
        throw new Error('pad must be a non-negative whole number')
      return String(value).padStart(pad, '0')
    }
    default:
      throw new Error(`unknown token "${token.name}"`)
  }
}

/**
 * One field from the schedule source.
 *
 * Two different failures, said differently on purpose. "This event is not
 * paired" is a setup mistake; "the plan has no title yet" is somebody
 * upstream not having filled it in, which is a Saturday-afternoon problem
 * with a different owner and a different fix.
 */
function planField(
  ctx: TemplateContext,
  field: 'planTitle' | 'seriesTitle' | 'timeName' | 'planDate' | 'planUrl',
  described: string,
): string {
  if (!ctx.plan) {
    throw new Error('this event does not take its schedule from Planning Center')
  }
  const value = ctx.plan[field]
  if (value === undefined || value === '') {
    throw new Error(`the plan for this service has no ${described} yet`)
  }
  return value
}

function formatInZone(token: ParsedToken, ctx: TemplateContext, fallbackFormat: string): string {
  const pattern = token.positional ?? fallbackFormat
  let moment = new TZDate(ctx.occurrenceStart, ctx.timezone)
  if (token.options.offset !== undefined) moment = applyOffset(moment, token.options.offset)
  try {
    return formatDate(moment, pattern)
  } catch (error) {
    throw new Error(
      `"${pattern}" is not a valid date format (${error instanceof Error ? error.message : error})`,
    )
  }
}

const OFFSET = /^([+-]?\d+)(m|h|d|w|M)$/

/** Calendar-aware offsets: "-1d" across a DST boundary still means yesterday. */
function applyOffset(moment: TZDate, spec: string): TZDate {
  const match = OFFSET.exec(spec.trim())
  if (!match) throw new Error(`offset "${spec}" must look like -1d, +2h, -30m, +1w or +1M`)
  const amount = Number(match[1])
  switch (match[2]) {
    case 'm':
      return addMinutes(moment, amount)
    case 'h':
      return addHours(moment, amount)
    case 'd':
      return addDays(moment, amount)
    case 'w':
      return addWeeks(moment, amount)
    default:
      return addMonths(moment, amount)
  }
}
