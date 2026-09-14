import { fingerprint } from '@scheduler/plugin-sdk'
import type { Clock, DestinationMetadata, JsonObject } from '@scheduler/plugin-sdk'
import type { Db } from '../db/index.js'
import type { ConnectionManager } from '../devices/connection-manager.js'
import type { DestinationRegistry } from '../destinations/registry.js'
import type { SecretVault } from '../secrets/vault.js'
import { renderTemplateOrThrow, sanitizeFilename } from '../template/index.js'
import type { TemplateContext } from '../template/render.js'
import type { RunPlan, RunPlanner, StepDefinition } from './steps.js'

/** One device node in a pipeline. */
export interface PipelineNodeSpec {
  id: string
  deviceId: string
  nodeId: string
  /** A `stream_credential` row: a key entered by hand. */
  credentialId?: string
  /** The id of a `destinations` entry that issues the key instead. */
  ingestFrom?: string
  filenameTemplate?: string
}

/** A streaming service this pipeline delivers to. */
export interface PipelineDestinationSpec {
  id: string
  destinationId: string
}

export interface PipelineGraph {
  nodes: PipelineNodeSpec[]
  destinations?: PipelineDestinationSpec[]
  links?: { from: string; to: string }[]
}

export interface SeriesTemplates {
  title?: string
  description?: string
  filename?: string
}

export interface PipelinePlannerDeps {
  db: Db
  connections: ConnectionManager
  vault: SecretVault
  clock: Clock
  /** Omit to run device-only pipelines, as the app does before any
   *  streaming service is connected. */
  destinations?: DestinationRegistry
}

/**
 * Turns a pipeline into the run steps that drive it.
 *
 * Order matters and is the whole point: destinations prepare first so the
 * ingest URL and key exist, encoders are then pointed at them and verified,
 * and only afterwards does anything go live. Every write is verified by a
 * read, and every step is safe to run twice.
 */
export class PipelinePlanner implements RunPlanner {
  constructor(private readonly deps: PipelinePlannerDeps) {}

  plan(occurrenceId: string): RunPlan {
    const context = this.contextFor(occurrenceId)
    const graph = this.graphFor(occurrenceId)
    const steps: StepDefinition[] = []

    for (const spec of graph.destinations ?? []) {
      steps.push(...this.destinationSteps(spec, occurrenceId, context))
    }
    for (const node of graph.nodes) {
      steps.push(...this.deviceSteps(node, context))
    }
    return steps
  }

  private destinationSteps(
    spec: PipelineDestinationSpec,
    occurrenceId: string,
    context: PlanContext,
  ): StepDefinition[] {
    const registry = this.deps.destinations
    if (!registry) {
      throw new Error(
        `Pipeline references destination "${spec.id}" but no streaming services are configured.`,
      )
    }

    const metadata = (): DestinationMetadata => this.metadataFor(spec.destinationId, context)
    const keyRef = (runId: string): string => `run-ingest:${runId}:${spec.id}`

    return [
      {
        kind: `${spec.id}.prepare`,
        phase: 'prepare',
        request: { destination: spec.destinationId },
        execute: async (ctx) => {
          const destination = await registry.open(spec.destinationId, { runId: ctx.runId })
          try {
            const result = await destination.prepare({ idempotencyKey: ctx.idempotencyKey, metadata: metadata() })
            return this.recordIngest(result, keyRef(ctx.runId))
          } finally {
            await destination.dispose()
          }
        },
        reconcile: async (ctx) => {
          const destination = await registry.open(spec.destinationId, { runId: ctx.runId })
          try {
            const existing = await destination.reconcile({
              idempotencyKey: ctx.idempotencyKey,
              metadata: metadata(),
            })
            return existing ? this.recordIngest(existing, keyRef(ctx.runId)) : undefined
          } finally {
            await destination.dispose()
          }
        },
        compensate: async (ctx) => {
          const externalId = ctx.outputs[`${spec.id}.prepare`]?.externalId
          // The vault entry goes either way: an abandoned run must not leave
          // a live stream key behind.
          this.deps.vault.delete(keyRef(ctx.runId))
          if (!externalId) return
          const destination = await registry.open(spec.destinationId, { runId: ctx.runId })
          try {
            await destination.discard({ externalId })
          } finally {
            await destination.dispose()
          }
        },
      },
      {
        kind: `${spec.id}.finalize`,
        phase: 'complete',
        execute: async (ctx) => {
          const externalId = ctx.outputs[`${spec.id}.prepare`]?.externalId
          if (!externalId) return
          const destination = await registry.open(spec.destinationId, { runId: ctx.runId })
          try {
            await destination.finalize({ externalId, metadata: metadata() })
          } finally {
            await destination.dispose()
            // The per-run key has done its job; leaving it encrypted on disk
            // forever serves nobody.
            this.deps.vault.delete(keyRef(ctx.runId))
          }
        },
      },
    ]
  }

  private deviceSteps(node: PipelineNodeSpec, context: PlanContext): StepDefinition[] {
    const connections = this.deps.connections
    const steps: StepDefinition[] = []

    if (node.credentialId || node.ingestFrom) {
      const credentialId = node.credentialId
      const ingestFrom = node.ingestFrom
      steps.push({
        kind: `${node.id}.applyStreamTarget`,
        phase: 'prepare',
        request: { device: node.deviceId, node: node.nodeId },
        execute: async (ctx) => {
          const target = ingestFrom
            ? // The vault reference is derived, not carried: step outputs are
              // persisted through the scrubber, so anything passed that way
              // whose key looks like a secret comes back "[redacted]".
              this.targetFromDestination(
                ctx.outputs[`${ingestFrom}.prepare`]?.response,
                `run-ingest:${ctx.runId}:${ingestFrom}`,
              )
            : this.targetFromCredential(credentialId!)

          await connections.applyAndVerify(
            node.deviceId,
            node.nodeId,
            'applyStreamTarget',
            { url: target.url, key: target.key },
            {
              what: 'Stream target',
              expected: `${target.url} with key ${fingerprint(target.key)}`,
              satisfiedBy: (state) =>
                state.streaming?.targetUrl === target.url &&
                state.streaming?.keyFingerprint === fingerprint(target.key),
            },
          )
        },
      })
    }

    if (this.supports(node, 'startStreaming')) {
      steps.push({
        kind: `${node.id}.startStreaming`,
        phase: 'start',
        execute: async () => {
          await connections.applyAndVerify(node.deviceId, node.nodeId, 'startStreaming', {}, {
            what: 'Streaming',
            expected: 'active',
            satisfiedBy: (state) => state.streaming?.active === true,
          })
        },
      })
      steps.push({
        kind: `${node.id}.stopStreaming`,
        phase: 'stop',
        execute: async () => {
          await connections.applyAndVerify(node.deviceId, node.nodeId, 'stopStreaming', {}, {
            what: 'Streaming',
            expected: 'stopped',
            satisfiedBy: (state) => state.streaming?.active === false,
          })
        },
      })
    }

    if (this.supports(node, 'startRecording')) {
      const template = node.filenameTemplate ?? context.templates.filename ?? '{{date "yyyy-MM-dd"}} {{event.name}}'
      steps.push({
        kind: `${node.id}.startRecording`,
        phase: 'start',
        execute: async () => {
          const filename = sanitizeFilename(renderTemplateOrThrow(template, context.template))
          await connections.applyAndVerify(node.deviceId, node.nodeId, 'startRecording', { filename }, {
            what: 'Recording',
            expected: `active as ${filename}`,
            satisfiedBy: (state) => state.recording?.active === true,
          })
          return { response: { filename } }
        },
      })
      steps.push({
        kind: `${node.id}.stopRecording`,
        phase: 'stop',
        execute: async () => {
          await connections.applyAndVerify(node.deviceId, node.nodeId, 'stopRecording', {}, {
            what: 'Recording',
            expected: 'stopped',
            satisfiedBy: (state) => state.recording?.active === false,
          })
        },
      })
    }

    return steps
  }

  /**
   * Puts the issued stream key in the vault and passes only a reference
   * forward.
   *
   * Step outputs are persisted into the run timeline, which is scrubbed but
   * should never have been handed the key in the first place. The next step
   * resolves the reference when it needs the value.
   */
  private recordIngest(
    result: { externalId: string; ingest: { url: string; key: string }; watchUrl?: string },
    keyRef: string,
  ): { externalId: string; response: JsonObject } {
    this.deps.vault.store(result.ingest.key, keyRef)
    return {
      externalId: result.externalId,
      // Only the URL travels through the timeline. The key lives in the
      // vault under a reference the next step derives from the run id.
      response: {
        ingestUrl: result.ingest.url,
        ...(result.watchUrl === undefined ? {} : { watchUrl: result.watchUrl }),
      },
    }
  }

  private targetFromDestination(response: unknown, keyRef: string): { url: string; key: string } {
    const record = (response ?? {}) as { ingestUrl?: unknown }
    if (typeof record.ingestUrl !== 'string') {
      throw new Error('The streaming service did not provide an ingest URL for this run.')
    }
    return { url: record.ingestUrl, key: this.deps.vault.reveal(keyRef) }
  }

  private targetFromCredential(credentialId: string): { url: string; key: string } {
    const row = this.deps.db
      .prepare('SELECT ingest_url, secret_ref FROM stream_credential WHERE id = ?')
      .get(credentialId) as { ingest_url: string | null; secret_ref: string } | undefined
    if (!row) throw new Error(`No stream credential with id "${credentialId}".`)
    if (!row.ingest_url) throw new Error(`Stream credential "${credentialId}" has no ingest URL.`)
    return { url: row.ingest_url, key: this.deps.vault.reveal(row.secret_ref) }
  }

  /** Rendered names for the next occurrences, for the template preview. */
  previewNames(occurrenceId: string): { title?: string; description?: string; filename?: string } {
    const { templates, template } = this.contextFor(occurrenceId)
    const out: { title?: string; description?: string; filename?: string } = {}
    if (templates.title) out.title = renderTemplateOrThrow(templates.title, template)
    if (templates.description) out.description = renderTemplateOrThrow(templates.description, template)
    if (templates.filename) out.filename = sanitizeFilename(renderTemplateOrThrow(templates.filename, template))
    return out
  }

  private metadataFor(destinationId: string, context: PlanContext): DestinationMetadata {
    const row = this.deps.db.prepare('SELECT config FROM destination WHERE id = ?').get(destinationId) as
      | { config: string }
      | undefined
    const config = (row ? JSON.parse(row.config) : {}) as { privacy?: string }

    return {
      // Rendered here rather than in the provider so every destination gets
      // the same names, and so a template mistake fails once, in prepare.
      title: context.templates.title
        ? renderTemplateOrThrow(context.templates.title, context.template)
        : context.template.event.name,
      description: context.templates.description
        ? renderTemplateOrThrow(context.templates.description, context.template)
        : '',
      scheduledStart: context.scheduledStart,
      scheduledEnd: context.scheduledEnd,
      privacy: (config.privacy as DestinationMetadata['privacy']) ?? 'public',
    }
  }

  private supports(node: PipelineNodeSpec, action: string): boolean {
    const connection = this.deps.connections.get(node.deviceId)
    if (!connection) return false
    const definition = connection.nodes.find((n) => n.id === node.nodeId)
    return definition?.supports.includes(action as never) ?? false
  }

  private graphFor(occurrenceId: string): PipelineGraph {
    const row = this.deps.db
      .prepare(
        `SELECT p.graph AS graph
           FROM occurrence o
           JOIN event_series s ON s.id = o.series_id
           JOIN pipeline p ON p.id = s.pipeline_id
          WHERE o.id = ?`,
      )
      .get(occurrenceId) as { graph: string } | undefined
    if (!row) throw new Error(`No occurrence with id "${occurrenceId}".`)
    const parsed = JSON.parse(row.graph) as Partial<PipelineGraph>
    return { nodes: parsed.nodes ?? [], destinations: parsed.destinations ?? [], links: parsed.links ?? [] }
  }

  private contextFor(occurrenceId: string): PlanContext {
    const row = this.deps.db
      .prepare(
        `SELECT o.scheduled_start, o.scheduled_end, o.series_id, s.label, s.timezone, s.templates
           FROM occurrence o
           JOIN event_series s ON s.id = o.series_id
          WHERE o.id = ?`,
      )
      .get(occurrenceId) as
      | {
          scheduled_start: number
          scheduled_end: number
          series_id: string
          label: string
          timezone: string
          templates: string
        }
      | undefined
    if (!row) throw new Error(`No occurrence with id "${occurrenceId}".`)

    const index = (
      this.deps.db
        .prepare('SELECT COUNT(*) AS n FROM occurrence WHERE series_id = ? AND scheduled_start <= ?')
        .get(row.series_id, row.scheduled_start) as { n: number }
    ).n

    return {
      templates: JSON.parse(row.templates) as SeriesTemplates,
      scheduledStart: row.scheduled_start,
      scheduledEnd: row.scheduled_end,
      template: {
        // Always the occurrence's own start in the series zone, so a 09:00
        // service prepared at 08:30 still names its own day and a UTC
        // container does not date an evening event yesterday.
        occurrenceStart: row.scheduled_start,
        timezone: row.timezone,
        event: { name: row.label },
        series: { name: row.label },
        occurrence: { index },
      },
    }
  }
}

interface PlanContext {
  templates: SeriesTemplates
  scheduledStart: number
  scheduledEnd: number
  template: TemplateContext
}
