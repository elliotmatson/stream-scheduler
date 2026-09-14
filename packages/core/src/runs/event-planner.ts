import { fingerprint } from '@scheduler/plugin-sdk'
import type { Clock, DestinationMetadata, JsonObject } from '@scheduler/plugin-sdk'
import type { Db } from '../db/index.js'
import type { ConnectionManager } from '../devices/connection-manager.js'
import type { DestinationRegistry } from '../destinations/registry.js'
import { deviceFor, effectiveTemplates, type EventOutput, type OutputTemplates } from '../events/outputs.js'
import type { SecretVault } from '../secrets/vault.js'
import { renderTemplateOrThrow, sanitizeFilename } from '../template/index.js'
import type { TemplateContext } from '../template/render.js'
import type { RunPlan, RunPlanner, StepDefinition } from './steps.js'
import { timelineFor, type EventTimeline, type OutputWindow } from './timeline.js'

export interface EventPlannerDeps {
  db: Db
  connections: ConnectionManager
  vault: SecretVault
  clock: Clock
  /** Omit to run device-only events, as the app does before any streaming
   *  service is connected. */
  destinations?: DestinationRegistry
}

/** What one output's names render to, for the preview and pre-flight. */
export interface OutputPreview {
  outputId: string
  label: string
  kind: EventOutput['kind']
  startsAt: number
  endsAt: number
  title?: string
  description?: string
  filename?: string
}

/**
 * Turns an event's outputs into the run steps that drive them.
 *
 * Two orderings matter and are the whole point. Across the event: every
 * destination prepares up front, so the broadcasts exist and their keys are
 * known long before anything has to go live. Within an output: the encoder
 * is pointed at the key and that write is read back, and only then is it
 * told to start.
 *
 * Retargeting deliberately happens at the output's own start rather than in
 * prepare. One encoder feeding four services across a morning can only hold
 * one target at a time, so the target has to be applied at the moment that
 * service goes on air and not before.
 */
export class EventPlanner implements RunPlanner {
  constructor(private readonly deps: EventPlannerDeps) {}

  plan(occurrenceId: string, options: { forcedAt?: number } = {}): RunPlan {
    const timeline = timelineFor(this.deps.db, occurrenceId, options)
    const context = this.contextFor(timeline)
    const steps: StepDefinition[] = []
    for (const entry of timeline.outputs) {
      steps.push(...this.outputSteps(timeline, entry, context))
    }
    return steps
  }

  private outputSteps(
    timeline: EventTimeline,
    entry: OutputWindow,
    context: TemplateContext,
  ): StepDefinition[] {
    const output = entry.output
    const templates = effectiveTemplates(timeline.templates, output.templates)
    return output.kind === 'recording'
      ? this.recordingSteps(timeline, entry, context, templates)
      : this.streamSteps(timeline, entry, context, templates)
  }

  // -- streams ------------------------------------------------------------

  private streamSteps(
    timeline: EventTimeline,
    entry: OutputWindow,
    context: TemplateContext,
    templates: OutputTemplates,
  ): StepDefinition[] {
    const output = entry.output
    const device = this.deviceOrThrow(timeline, output)
    const steps: StepDefinition[] = []

    if (output.destinationId) {
      steps.push(this.destinationPrepareStep(output, entry, context, templates))
    } else if (!output.credentialId) {
      throw new Error(
        `"${output.label}" has nowhere to stream to: give it a streaming service or a stream key.`,
      )
    }

    const destinationId = output.destinationId
    const credentialId = output.credentialId

    steps.push({
      kind: `${output.id}.applyStreamTarget`,
      phase: 'start',
      outputId: output.id,
      label: `${output.label}: point the encoder at it`,
      request: { device: device.deviceId, node: device.nodeId },
      execute: async (ctx) => {
        const target = destinationId
          ? // The vault reference is derived, not carried: step outputs are
            // persisted through the scrubber, so anything passed that way
            // whose key looks like a secret comes back "[redacted]".
            this.targetFromDestination(
              ctx.outputs[`${output.id}.prepare`]?.response,
              keyRef(ctx.runId, output.id),
            )
          : this.targetFromCredential(credentialId!)

        await this.deps.connections.applyAndVerify(
          device.deviceId,
          device.nodeId,
          'applyStreamTarget',
          // The quality is the event's if it named one, and otherwise
          // absent, which leaves the device on whatever it is set to.
          { url: target.url, key: target.key, ...(output.settings.quality ? { quality: output.settings.quality } : {}) },
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

    steps.push({
      kind: `${output.id}.startStreaming`,
      phase: 'start',
      outputId: output.id,
      label: `${output.label}: go live`,
      execute: async () => {
        await this.deps.connections.applyAndVerify(device.deviceId, device.nodeId, 'startStreaming', {}, {
          what: 'Streaming',
          expected: 'active',
          satisfiedBy: (state) => state.streaming?.active === true,
          // Going live is not a local setting: the encoder has to open an
          // RTMP session across the internet before it will say it is
          // streaming. An ATEM sits in Connecting for several seconds
          // doing it, and that is a stream coming up, not a failure.
          settleMs: 25_000,
        })
      },
    })

    steps.push({
      kind: `${output.id}.stopStreaming`,
      phase: 'stop',
      outputId: output.id,
      label: `${output.label}: stop`,
      execute: async () => {
        await this.deps.connections.applyAndVerify(device.deviceId, device.nodeId, 'stopStreaming', {}, {
          what: 'Streaming',
          expected: 'stopped',
          satisfiedBy: (state) => state.streaming?.active === false,
        })
      },
    })

    if (output.destinationId) steps.push(this.destinationFinalizeStep(output, entry, context, templates))
    return steps
  }

  private destinationPrepareStep(
    output: EventOutput,
    entry: OutputWindow,
    context: TemplateContext,
    templates: OutputTemplates,
  ): StepDefinition {
    const registry = this.registryOrThrow(output)
    const destinationId = output.destinationId!
    const metadata = (): DestinationMetadata => this.metadataFor(destinationId, entry, context, templates)

    return {
      kind: `${output.id}.prepare`,
      phase: 'prepare',
      outputId: output.id,
      label: `${output.label}: create the broadcast`,
      request: { destination: destinationId },
      execute: async (ctx) => {
        const destination = await registry.open(destinationId, { runId: ctx.runId })
        try {
          const result = await destination.prepare({ idempotencyKey: ctx.idempotencyKey, metadata: metadata() })
          return this.recordIngest(result, keyRef(ctx.runId, output.id))
        } finally {
          await destination.dispose()
        }
      },
      reconcile: async (ctx) => {
        const destination = await registry.open(destinationId, { runId: ctx.runId })
        try {
          const existing = await destination.reconcile({
            idempotencyKey: ctx.idempotencyKey,
            metadata: metadata(),
          })
          return existing ? this.recordIngest(existing, keyRef(ctx.runId, output.id)) : undefined
        } finally {
          await destination.dispose()
        }
      },
      compensate: async (ctx) => {
        const externalId = ctx.outputs[`${output.id}.prepare`]?.externalId
        // The vault entry goes either way: an abandoned run must not leave
        // a live stream key behind.
        this.deps.vault.delete(keyRef(ctx.runId, output.id))
        if (!externalId) return
        const destination = await registry.open(destinationId, { runId: ctx.runId })
        try {
          await destination.discard({ externalId })
        } finally {
          await destination.dispose()
        }
      },
    }
  }

  private destinationFinalizeStep(
    output: EventOutput,
    entry: OutputWindow,
    context: TemplateContext,
    templates: OutputTemplates,
  ): StepDefinition {
    const registry = this.registryOrThrow(output)
    const destinationId = output.destinationId!

    return {
      kind: `${output.id}.finalize`,
      phase: 'complete',
      outputId: output.id,
      label: `${output.label}: close the broadcast`,
      execute: async (ctx) => {
        const externalId = ctx.outputs[`${output.id}.prepare`]?.externalId
        if (!externalId) return
        const destination = await registry.open(destinationId, { runId: ctx.runId })
        try {
          await destination.finalize({
            externalId,
            metadata: this.metadataFor(destinationId, entry, context, templates),
          })
        } finally {
          await destination.dispose()
          // The per-run key has done its job; leaving it encrypted on disk
          // forever serves nobody.
          this.deps.vault.delete(keyRef(ctx.runId, output.id))
        }
      },
    }
  }

  // -- recordings ---------------------------------------------------------

  private recordingSteps(
    timeline: EventTimeline,
    entry: OutputWindow,
    context: TemplateContext,
    templates: OutputTemplates,
  ): StepDefinition[] {
    const output = entry.output
    const device = this.deviceOrThrow(timeline, output)
    const template = templates.filename ?? DEFAULT_FILENAME_TEMPLATE

    return [
      {
        kind: `${output.id}.startRecording`,
        phase: 'start',
        outputId: output.id,
        label: `${output.label}: start recording`,
        execute: async () => {
          const filename = sanitizeFilename(renderTemplateOrThrow(template, context))
          await this.deps.connections.applyAndVerify(
            device.deviceId,
            device.nodeId,
            'startRecording',
            { filename, ...(output.settings.slot === undefined ? {} : { slot: output.settings.slot }) },
            {
              what: 'Recording',
              expected: `active as ${filename}`,
              // A deck spinning up media takes a moment, and reports the
              // transport status only once it has.
              satisfiedBy: (state) => state.recording?.active === true,
              settleMs: 10_000,
            },
          )
          return { response: { filename } }
        },
      },
      {
        kind: `${output.id}.stopRecording`,
        phase: 'stop',
        outputId: output.id,
        label: `${output.label}: stop recording`,
        execute: async () => {
          await this.deps.connections.applyAndVerify(device.deviceId, device.nodeId, 'stopRecording', {}, {
            what: 'Recording',
            expected: 'stopped',
            satisfiedBy: (state) => state.recording?.active === false,
          })
        },
      },
    ]
  }

  // -- preview ------------------------------------------------------------

  /** What each output's names render to, for the editor and pre-flight. */
  previewOutputs(occurrenceId: string): OutputPreview[] {
    const timeline = timelineFor(this.deps.db, occurrenceId)
    const context = this.contextFor(timeline)

    return timeline.outputs.map((entry) => {
      const templates = effectiveTemplates(timeline.templates, entry.output.templates)
      const preview: OutputPreview = {
        outputId: entry.output.id,
        label: entry.output.label,
        kind: entry.output.kind,
        startsAt: entry.startsAt,
        endsAt: entry.endsAt,
      }
      if (entry.output.kind === 'recording') {
        preview.filename = sanitizeFilename(
          renderTemplateOrThrow(templates.filename ?? DEFAULT_FILENAME_TEMPLATE, context),
        )
      } else {
        preview.title = templates.title
          ? renderTemplateOrThrow(templates.title, context)
          : context.event.name
        if (templates.description) {
          preview.description = renderTemplateOrThrow(templates.description, context)
        }
      }
      return preview
    })
  }

  /** The event's own templates, rendered. Kept for the series-level preview. */
  previewNames(occurrenceId: string): { title?: string; description?: string; filename?: string } {
    const timeline = timelineFor(this.deps.db, occurrenceId)
    const context = this.contextFor(timeline)
    const out: { title?: string; description?: string; filename?: string } = {}
    if (timeline.templates.title) out.title = renderTemplateOrThrow(timeline.templates.title, context)
    if (timeline.templates.description) {
      out.description = renderTemplateOrThrow(timeline.templates.description, context)
    }
    if (timeline.templates.filename) {
      out.filename = sanitizeFilename(renderTemplateOrThrow(timeline.templates.filename, context))
    }
    // An output's own templates are just as capable of failing to render, and
    // the point of a preview is to find that out now rather than at 08:30.
    this.previewOutputs(occurrenceId)
    return out
  }

  // -- plumbing -----------------------------------------------------------

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
    ref: string,
  ): { externalId: string; response: JsonObject } {
    this.deps.vault.store(result.ingest.key, ref)
    return {
      externalId: result.externalId,
      response: {
        ingestUrl: result.ingest.url,
        ...(result.watchUrl === undefined ? {} : { watchUrl: result.watchUrl }),
      },
    }
  }

  private targetFromDestination(response: unknown, ref: string): { url: string; key: string } {
    const record = (response ?? {}) as { ingestUrl?: unknown }
    if (typeof record.ingestUrl !== 'string') {
      throw new Error('The streaming service did not provide an ingest URL for this run.')
    }
    return { url: record.ingestUrl, key: this.deps.vault.reveal(ref) }
  }

  private targetFromCredential(credentialId: string): { url: string; key: string } {
    const row = this.deps.db
      .prepare('SELECT ingest_url, secret_ref FROM stream_credential WHERE id = ?')
      .get(credentialId) as { ingest_url: string | null; secret_ref: string } | undefined
    if (!row) throw new Error(`No stream credential with id "${credentialId}".`)
    if (!row.ingest_url) throw new Error(`Stream credential "${credentialId}" has no ingest URL.`)
    return { url: row.ingest_url, key: this.deps.vault.reveal(row.secret_ref) }
  }

  private metadataFor(
    destinationId: string,
    entry: OutputWindow,
    context: TemplateContext,
    templates: OutputTemplates,
  ): DestinationMetadata {
    const row = this.deps.db.prepare('SELECT config FROM destination WHERE id = ?').get(destinationId) as
      | { config: string }
      | undefined
    const config = (row ? JSON.parse(row.config) : {}) as { privacy?: string }

    return {
      // Rendered here rather than in the provider so every destination gets
      // the same names, and so a template mistake fails once, in prepare.
      title: templates.title ? renderTemplateOrThrow(templates.title, context) : context.event.name,
      description: templates.description ? renderTemplateOrThrow(templates.description, context) : '',
      // The output's own window, not the event's: a broadcast scheduled for
      // 7:00 when it actually airs at 11:00 is wrong on the channel page and
      // wrong in every subscriber's notification.
      scheduledStart: entry.startsAt,
      scheduledEnd: entry.endsAt,
      privacy: (config.privacy as DestinationMetadata['privacy']) ?? 'public',
    }
  }

  private deviceOrThrow(timeline: EventTimeline, output: EventOutput): { deviceId: string; nodeId: string } {
    const device = deviceFor(output)
    if (device) return device
    throw new Error(`"${output.label}" in "${timeline.label}" has no device to run on.`)
  }

  private registryOrThrow(output: EventOutput): DestinationRegistry {
    const registry = this.deps.destinations
    if (!registry) {
      throw new Error(`"${output.label}" streams to a service, but no streaming services are configured.`)
    }
    return registry
  }

  private contextFor(timeline: EventTimeline): TemplateContext {
    const index = (
      this.deps.db
        .prepare('SELECT COUNT(*) AS n FROM occurrence WHERE series_id = ? AND scheduled_start <= ?')
        .get(timeline.seriesId, timeline.windowStart) as { n: number }
    ).n

    return {
      // Always the occurrence's own start in the event's zone, so a 09:00
      // service prepared at 08:30 still names its own day and a UTC
      // container does not date an evening event yesterday.
      occurrenceStart: timeline.windowStart,
      timezone: timeline.timezone,
      event: { name: timeline.label },
      series: { name: timeline.label },
      occurrence: { index },
    }
  }
}

const DEFAULT_FILENAME_TEMPLATE = '{{date "yyyy-MM-dd"}} {{event.name}}'

/** Where an output's issued stream key lives for the length of one run. */
function keyRef(runId: string, outputId: string): string {
  return `run-ingest:${runId}:${outputId}`
}
