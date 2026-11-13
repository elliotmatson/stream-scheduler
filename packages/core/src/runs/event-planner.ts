import { fingerprint, sameQuality, sameStreamUrl } from '@scheduler/plugin-sdk'
import type { Clock, DestinationMetadata, JsonObject, NodeState } from '@scheduler/plugin-sdk'
import type { Db } from '../db/index.js'
import type { ConnectionManager } from '../devices/connection-manager.js'
import type { DestinationRegistry } from '../destinations/registry.js'
import {
  deviceFor,
  effectiveTemplates,
  type EventOutput,
  type OutputTemplates,
} from '../events/outputs.js'
import type { SecretVault } from '../secrets/vault.js'
import { renderTemplateOrThrow, sanitizeFilename } from '../template/index.js'
import type { TemplateContext } from '../template/render.js'
import { RecordingLedger } from './artifacts.js'
import type { CommittedStep, RunPlan, RunPlanner, StepContext, StepDefinition } from './steps.js'
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
/** Whether a device is on the quality that was asked for, whichever of its
 *  spellings the asking used — "Streaming High" and "6-9" are one bitrate
 *  on an ATEM. */
function qualityMatches(state: NodeState, asked: string): boolean {
  const quality = state.options?.quality
  if (!quality) return false
  return [quality.current, ...(quality.aliases ?? [])].some(
    (reported) => reported !== undefined && sameQuality(reported, asked),
  )
}

export class EventPlanner implements RunPlanner {
  /**
   * Written as recordings start and closed as they stop.
   *
   * Built here rather than injected: it holds no state of its own, only
   * SQL over the same database, so a second instance elsewhere is the same
   * ledger. Threading it through every construction site would buy
   * nothing and cost six signatures.
   */
  private readonly ledger: RecordingLedger

  constructor(private readonly deps: EventPlannerDeps) {
    this.ledger = new RecordingLedger({ db: deps.db })
  }

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
          {
            url: target.url,
            key: target.key,
            ...(output.settings.quality ? { quality: output.settings.quality } : {}),
          },
          {
            what: 'Stream target',
            expected:
              `${target.url} with key ${fingerprint(target.key)}` +
              (output.settings.quality ? ` at ${output.settings.quality}` : ''),
            satisfiedBy: (state) =>
              sameStreamUrl(state.streaming?.targetUrl, target.url) &&
              state.streaming?.keyFingerprint === fingerprint(target.key) &&
              // A device reports `current` in the vocabulary it takes, and
              // may take more than one for the same setting — "Streaming
              // High" and "6-9" are one bitrate on an ATEM.
              (!output.settings.quality || qualityMatches(state, output.settings.quality)),
          },
        )
      },
    })

    steps.push({
      kind: `${output.id}.startStreaming`,
      phase: 'start',
      outputId: output.id,
      label: `${output.label}: start streaming`,
      execute: async () => {
        await this.deps.connections.applyAndVerify(
          device.deviceId,
          device.nodeId,
          'startStreaming',
          {},
          {
            what: 'Streaming',
            expected: 'active',
            satisfiedBy: (state) => state.streaming?.active === true,
            // Going live is not a local setting: the encoder has to open an
            // RTMP session across the internet before it will say it is
            // streaming. An ATEM sits in Connecting for several seconds
            // doing it, and that is a stream coming up, not a failure.
            settleMs: 25_000,
          },
        )
      },
      // Undone when the output fails after this — the broadcast refusing
      // to go live, say. Left pushing, the encoder would carry on sending
      // the service to a broadcast that is about to be deleted.
      compensate: async () => {
        await this.deps.connections.applyAndVerify(
          device.deviceId,
          device.nodeId,
          'stopStreaming',
          {},
          {
            what: 'Streaming',
            expected: 'stopped',
            satisfiedBy: (state) => state.streaming?.active === false,
          },
        )
      },
    })

    const drivesBroadcast =
      output.destinationId !== null &&
      output.destinationId !== undefined &&
      (this.deps.destinations?.controlsLifecycle(output.destinationId) ?? false)
    if (drivesBroadcast) steps.push(this.destinationLifecycleStep(output, 'goLive'))

    steps.push({
      kind: `${output.id}.stopStreaming`,
      phase: 'stop',
      outputId: output.id,
      label: `${output.label}: stop streaming`,
      execute: async () => {
        await this.deps.connections.applyAndVerify(
          device.deviceId,
          device.nodeId,
          'stopStreaming',
          {},
          {
            what: 'Streaming',
            expected: 'stopped',
            satisfiedBy: (state) => state.streaming?.active === false,
          },
        )
      },
    })
    // After the encoder has stopped, never before: the executor stops at the
    // first failed step, and a broadcast that would not end must not be the
    // reason the encoder was never told to stop.
    if (drivesBroadcast) steps.push(this.destinationLifecycleStep(output, 'endBroadcast'))

    if (output.destinationId)
      steps.push(this.destinationFinalizeStep(output, entry, context, templates))
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
    const metadata = (): DestinationMetadata => this.metadataFor(output, entry, context, templates)

    return {
      kind: `${output.id}.prepare`,
      phase: 'prepare',
      outputId: output.id,
      label: `${output.label}: create the broadcast`,
      request: { destination: destinationId },
      execute: async (ctx) => {
        const destination = await registry.open(destinationId, {
          runId: ctx.runId,
          overrides: overridesOf(output),
        })
        try {
          const result = await destination.prepare({
            idempotencyKey: ctx.idempotencyKey,
            metadata: metadata(),
            firstAttemptAt: ctx.firstAttemptAt,
          })
          return this.recordIngest(result, keyRef(ctx.runId, output.id))
        } finally {
          await destination.dispose()
        }
      },
      reconcile: async (ctx) => {
        const destination = await registry.open(destinationId, {
          runId: ctx.runId,
          overrides: overridesOf(output),
        })
        try {
          const existing = await destination.reconcile({
            idempotencyKey: ctx.idempotencyKey,
            metadata: metadata(),
            firstAttemptAt: ctx.firstAttemptAt,
          })
          return existing ? this.recordIngest(existing, keyRef(ctx.runId, output.id)) : undefined
        } finally {
          await destination.dispose()
        }
      },
      compensate: (ctx) => this.discardPrepared(registry, destinationId, output.id, ctx),
    }
  }

  /** Undoes a prepare: the broadcast it made, and the key it stored. */
  private async discardPrepared(
    registry: DestinationRegistry,
    destinationId: string,
    outputId: string,
    ctx: StepContext,
  ): Promise<void> {
    const externalId = ctx.outputs[`${outputId}.prepare`]?.externalId
    // The vault entry goes either way: an abandoned run must not leave
    // a live stream key behind.
    this.deps.vault.delete(keyRef(ctx.runId, outputId))
    if (!externalId) return
    const destination = await registry.open(destinationId, { runId: ctx.runId })
    try {
      await destination.discard({ externalId })
    } finally {
      await destination.dispose()
    }
  }

  orphans(records: readonly CommittedStep[]): StepDefinition[] {
    const definitions: StepDefinition[] = []
    for (const record of records) {
      const dot = record.kind.lastIndexOf('.')
      if (dot <= 0) continue
      const outputId = record.kind.slice(0, dot)
      const phase = PHASE_OF_ACTION[record.kind.slice(dot + 1)]
      if (!phase) continue
      const definition: StepDefinition = {
        kind: record.kind,
        phase,
        outputId,
        label: record.label ?? record.kind,
        execute: async () => {
          throw new Error('This output was removed from the event while the run was going.')
        },
      }
      // The one step that leaves something behind. It recorded which
      // service it made the broadcast on, which is all undoing it needs.
      const destinationId = destinationOf(record.request)
      if (phase === 'prepare' && destinationId && this.deps.destinations) {
        const registry = this.deps.destinations
        definition.compensate = (ctx) =>
          this.discardPrepared(registry, destinationId, outputId, ctx)
      }
      definitions.push(definition)
    }
    return definitions
  }

  /**
   * Puts the broadcast on air, or takes it off, for a service whose
   * broadcasts the scheduler drives.
   *
   * On air only once the encoder's own start has been verified, so the
   * service has something to show; off at the output's scheduled stop, so
   * an encoder that drops for a minute does not end the broadcast early.
   */
  private destinationLifecycleStep(
    output: EventOutput,
    action: 'goLive' | 'endBroadcast',
  ): StepDefinition {
    const registry = this.registryOrThrow(output)
    const destinationId = output.destinationId!
    return {
      kind: `${output.id}.${action}`,
      phase: action === 'goLive' ? 'start' : 'stop',
      outputId: output.id,
      label: `${output.label}: ${action === 'goLive' ? 'put the broadcast on air' : 'end the broadcast'}`,
      maxAttempts: 3,
      backoffMs: 5_000,
      execute: async (ctx) => {
        const externalId = ctx.outputs[`${output.id}.prepare`]?.externalId
        if (!externalId) return
        const destination = await registry.open(destinationId, { runId: ctx.runId })
        try {
          await destination[action]?.({ externalId })
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
        const destination = await registry.open(destinationId, {
          runId: ctx.runId,
          overrides: overridesOf(output),
        })
        try {
          await destination.finalize({
            externalId,
            metadata: this.metadataFor(output, entry, context, templates),
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
        execute: async (ctx) => {
          const filename = sanitizeFilename(renderTemplateOrThrow(template, context))
          const state = await this.deps.connections.applyAndVerify(
            device.deviceId,
            device.nodeId,
            'startRecording',
            {
              filename,
              ...(output.settings.slot === undefined ? {} : { slot: output.settings.slot }),
              // A recorder that shares an encoder with the streaming side
              // takes its quality here: there is no stream target to hang
              // it on.
              ...(output.settings.quality ? { quality: output.settings.quality } : {}),
              ...(output.settings.iso === undefined ? {} : { iso: output.settings.iso }),
            },
            {
              what: 'Recording',
              expected:
                `active as ${filename}` +
                (output.settings.quality ? ` at ${output.settings.quality}` : '') +
                (output.settings.iso === undefined
                  ? ''
                  : output.settings.iso
                    ? ', every input separately'
                    : ', programme only'),
              // A deck spinning up media takes a moment, and reports the
              // transport status only once it has.
              satisfiedBy: (state) =>
                state.recording?.active === true &&
                (!output.settings.quality || qualityMatches(state, output.settings.quality)) &&
                (output.settings.iso === undefined ||
                  state.recording.iso === undefined ||
                  state.recording.iso === output.settings.iso),
              settleMs: 10_000,
            },
          )
          // What the device actually called it, where it says so.
          //
          // Asking for a name and recording the answer are two different
          // things, and for a growing number of devices they are different
          // strings. A switcher appends its own extension; software that
          // owns its own output — OBS, ProPresenter, an audio console
          // writing a dated session — ignores the requested name entirely
          // and tells you afterwards what it used. A ledger holding only
          // what we asked for can never match the file that appeared, so
          // that recording could be made and then never swept.
          //
          // `readState` has always reported this; nothing here read it.
          // The requested name is still the fallback, for a deck like the
          // HyperDeck whose protocol indexes clips by position and has no
          // name to give back.
          const recorded = state.recording?.filename ?? filename

          // Recorded once the device has confirmed, so the ledger never
          // claims a file the deck refused to make — but before the step
          // returns, so a run that dies mid-service still leaves a record
          // of what it put on the card.
          this.ledger.started({
            runId: ctx.runId,
            outputId: output.id,
            deviceId: device.deviceId,
            nodeId: device.nodeId,
            ...(output.settings.slot === undefined ? {} : { slot: output.settings.slot }),
            filename: recorded,
            at: this.deps.clock.now(),
          })
          // Both names on the step, because when they differ the difference
          // is the whole story: the timeline should say what was asked for
          // and what the device did with it.
          return {
            response: {
              filename: recorded,
              ...(recorded === filename ? {} : { requested: filename }),
            },
          }
        },
      },
      {
        kind: `${output.id}.stopRecording`,
        phase: 'stop',
        outputId: output.id,
        label: `${output.label}: stop recording`,
        execute: async (ctx) => {
          await this.deps.connections.applyAndVerify(
            device.deviceId,
            device.nodeId,
            'stopRecording',
            {},
            {
              what: 'Recording',
              expected: 'stopped',
              satisfiedBy: (state) => state.recording?.active === false,
            },
          )
          // Closed only once the deck has actually stopped: a file still
          // being written is not a candidate for anything, and an open row
          // is how retention knows to leave it alone.
          this.ledger.finished(ctx.runId, output.id, this.deps.clock.now())
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
    if (timeline.templates.title)
      out.title = renderTemplateOrThrow(timeline.templates.title, context)
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
    output: EventOutput,
    entry: OutputWindow,
    context: TemplateContext,
    templates: OutputTemplates,
  ): DestinationMetadata {
    const row = this.deps.db
      .prepare('SELECT config FROM destination WHERE id = ?')
      .get(output.destinationId) as { config: string } | undefined
    // The account's defaults, with this stream's own choices over them.
    const config = {
      ...((row ? JSON.parse(row.config) : {}) as { privacy?: string; description?: string }),
      ...overridesOf(output),
    }
    // The event's description, else the account's default one. Rendered
    // either way, so a default can say {{date}} too.
    const description = templates.description || config.description

    return {
      // Rendered here rather than in the provider so every destination gets
      // the same names, and so a template mistake fails once, in prepare.
      title: templates.title ? renderTemplateOrThrow(templates.title, context) : context.event.name,
      description: description ? renderTemplateOrThrow(description, context) : '',
      // The output's own window, not the event's: a broadcast scheduled for
      // 7:00 when it actually airs at 11:00 is wrong on the channel page and
      // wrong in every subscriber's notification.
      scheduledStart: entry.startsAt,
      scheduledEnd: entry.endsAt,
      privacy: (config.privacy as DestinationMetadata['privacy']) ?? 'public',
    }
  }

  private deviceOrThrow(
    timeline: EventTimeline,
    output: EventOutput,
  ): { deviceId: string; nodeId: string } {
    const device = deviceFor(output)
    if (device) return device
    throw new Error(`"${output.label}" in "${timeline.label}" has no device to run on.`)
  }

  private registryOrThrow(output: EventOutput): DestinationRegistry {
    const registry = this.deps.destinations
    if (!registry) {
      throw new Error(
        `"${output.label}" streams to a service, but no streaming services are configured.`,
      )
    }
    return registry
  }

  private contextFor(timeline: EventTimeline): TemplateContext {
    const index = (
      this.deps.db
        .prepare(
          'SELECT COUNT(*) AS n FROM occurrence WHERE series_id = ? AND scheduled_start <= ?',
        )
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
      ...(timeline.plan === undefined ? {} : { plan: timeline.plan }),
    }
  }
}

const DEFAULT_FILENAME_TEMPLATE = '{{date "yyyy-MM-dd"}} {{event.name}}'

/** Where an output's issued stream key lives for the length of one run. */
/** Which phase each kind of step the planner makes belongs to. */
const PHASE_OF_ACTION: Record<string, StepDefinition['phase']> = {
  prepare: 'prepare',
  applyStreamTarget: 'start',
  startStreaming: 'start',
  startRecording: 'start',
  goLive: 'start',
  endBroadcast: 'stop',
  stopStreaming: 'stop',
  stopRecording: 'stop',
  finalize: 'complete',
}

function destinationOf(request: string | null): string | undefined {
  if (!request) return undefined
  try {
    const parsed = JSON.parse(request) as { destination?: unknown }
    return typeof parsed.destination === 'string' ? parsed.destination : undefined
  } catch {
    return undefined
  }
}

function keyRef(runId: string, outputId: string): string {
  return `run-ingest:${runId}:${outputId}`
}

/** One stream's own broadcast choices, in the shape a destination's config has. */
function overridesOf(output: EventOutput): Record<string, string> {
  const broadcast = output.settings.broadcast ?? {}
  return {
    ...(broadcast.privacy === undefined ? {} : { privacy: broadcast.privacy }),
    ...(broadcast.playlistId === undefined ? {} : { playlistId: broadcast.playlistId }),
  }
}
