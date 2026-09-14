import { fingerprint } from '@scheduler/plugin-sdk'
import type { Clock, JsonObject } from '@scheduler/plugin-sdk'
import type { Db } from '../db/index.js'
import type { ConnectionManager } from '../devices/connection-manager.js'
import type { SecretVault } from '../secrets/vault.js'
import { renderTemplateOrThrow, sanitizeFilename } from '../template/index.js'
import type { TemplateContext } from '../template/render.js'
import type { RunPlan, RunPlanner, StepDefinition } from './steps.js'

/**
 * One node of a pipeline: a device, which of its nodes to drive, and what to
 * give it. See docs/plan/02-domain-model.md for the wider graph model.
 */
export interface PipelineNodeSpec {
  id: string
  deviceId: string
  nodeId: string
  /** A `stream_credential` row, for nodes that need a stream key. */
  credentialId?: string
  /** Overrides the series' filename template for this recorder. */
  filenameTemplate?: string
}

export interface PipelineGraph {
  nodes: PipelineNodeSpec[]
  links?: { from: string; to: string }[]
}

export interface SeriesTemplates {
  title?: string
  description?: string
  filename?: string
}

export interface DevicePlannerDeps {
  db: Db
  connections: ConnectionManager
  vault: SecretVault
  clock: Clock
}

/**
 * Builds the steps that drive encoders and recorders for an occurrence.
 *
 * Every write goes through `applyAndVerify`, and every step is safe to run
 * again: starting an already-started stream is a no-op we confirm by reading
 * the device back, which is what lets the executor retry without a special
 * case per device.
 */
export class DevicePlanner implements RunPlanner {
  constructor(private readonly deps: DevicePlannerDeps) {}

  plan(occurrenceId: string): RunPlan {
    const context = this.contextFor(occurrenceId)
    const graph = this.graphFor(occurrenceId)
    const steps: StepDefinition[] = []

    for (const node of graph.nodes) {
      const connections = this.deps.connections

      if (node.credentialId) {
        const credentialId = node.credentialId
        steps.push({
          kind: `${node.id}.applyStreamTarget`,
          phase: 'prepare',
          request: { device: node.deviceId, node: node.nodeId },
          execute: async () => {
            const target = this.resolveTarget(credentialId)
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
    }

    return steps
  }

  /**
   * Renders every template up front so a typo fails the prepare phase at
   * T-30m rather than putting "{{speaker.nmae}}" in a public title.
   */
  previewNames(occurrenceId: string): { title?: string; description?: string; filename?: string } {
    const { templates, template } = this.contextFor(occurrenceId)
    const out: { title?: string; description?: string; filename?: string } = {}
    if (templates.title) out.title = renderTemplateOrThrow(templates.title, template)
    if (templates.description) out.description = renderTemplateOrThrow(templates.description, template)
    if (templates.filename) out.filename = sanitizeFilename(renderTemplateOrThrow(templates.filename, template))
    return out
  }

  private supports(node: PipelineNodeSpec, action: string): boolean {
    const connection = this.deps.connections.get(node.deviceId)
    if (!connection) return false
    const definition = connection.nodes.find((n) => n.id === node.nodeId)
    return definition?.supports.includes(action as never) ?? false
  }

  private resolveTarget(credentialId: string): { url: string; key: string } {
    const row = this.deps.db
      .prepare('SELECT ingest_url, secret_ref FROM stream_credential WHERE id = ?')
      .get(credentialId) as { ingest_url: string | null; secret_ref: string } | undefined
    if (!row) throw new Error(`No stream credential with id "${credentialId}".`)
    if (!row.ingest_url) throw new Error(`Stream credential "${credentialId}" has no ingest URL.`)
    return { url: row.ingest_url, key: this.deps.vault.reveal(row.secret_ref) }
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
    return { nodes: parsed.nodes ?? [], links: parsed.links ?? [] }
  }

  private contextFor(occurrenceId: string): { templates: SeriesTemplates; template: TemplateContext } {
    const row = this.deps.db
      .prepare(
        `SELECT o.scheduled_start, o.series_id, s.label, s.timezone, s.templates
           FROM occurrence o
           JOIN event_series s ON s.id = o.series_id
          WHERE o.id = ?`,
      )
      .get(occurrenceId) as
      | { scheduled_start: number; series_id: string; label: string; timezone: string; templates: string }
      | undefined
    if (!row) throw new Error(`No occurrence with id "${occurrenceId}".`)

    const index = (
      this.deps.db
        .prepare('SELECT COUNT(*) AS n FROM occurrence WHERE series_id = ? AND scheduled_start <= ?')
        .get(row.series_id, row.scheduled_start) as { n: number }
    ).n

    return {
      templates: JSON.parse(row.templates) as SeriesTemplates,
      template: {
        // Rendered against the occurrence's own start in the series zone, so
        // a 09:00 service prepared at 08:30 still names its own day, and a
        // UTC container does not put yesterday's date on an evening event.
        occurrenceStart: row.scheduled_start,
        timezone: row.timezone,
        event: { name: row.label },
        series: { name: row.label },
        occurrence: { index },
      },
    }
  }
}

export function isPipelineGraph(value: unknown): value is PipelineGraph {
  if (!value || typeof value !== 'object') return false
  const nodes = (value as { nodes?: unknown }).nodes
  return Array.isArray(nodes) && nodes.every((n) => isNodeSpec(n))
}

function isNodeSpec(value: unknown): value is PipelineNodeSpec {
  if (!value || typeof value !== 'object') return false
  const node = value as JsonObject
  return typeof node.id === 'string' && typeof node.deviceId === 'string' && typeof node.nodeId === 'string'
}
