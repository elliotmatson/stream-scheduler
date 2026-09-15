import type { Clock, NodeState } from '@scheduler/plugin-sdk'
import type { Db } from '../db/index.js'
import type { ConnectionManager } from '../devices/connection-manager.js'
import type { Logger } from '../log.js'
import type { RunStore } from './store.js'
import { timelineFor } from './timeline.js'

/**
 * What the devices were doing, minute by minute, while an event was on air.
 *
 * The status screen shows the last thing each device said, which answers
 * "is it working now". This answers the question asked afterwards — why the
 * stream went to pieces at 09:40 — and that one cannot be answered from a
 * single reading. A bitrate that sagged for two minutes, a cache that
 * climbed and never came down, a card that ran out: all of them are shapes
 * over time and invisible in a snapshot.
 *
 * Only while a run is on air, and only the nodes that run is using. The
 * rest of the week nothing is asked of the hardware at all.
 */

/** Slow enough to be polite to a box that is busy recording, fine enough to
 *  show the shape of a stall. */
export const DEFAULT_TELEMETRY_INTERVAL_MS = 15_000

/** Long enough to look back at a service somebody complained about. */
export const DEFAULT_TELEMETRY_RETENTION_MS = 30 * 86_400_000

/**
 * How full a device's cache has to get before somebody is told.
 *
 * Eighty rather than a hundred: at a hundred the stream has already gone.
 * A cache that touches eighty and comes back down is normal weather and
 * this fires anyway, which is the right trade — it is once per device per
 * run, and the alternative is finding out from the congregation.
 */
export const CACHE_WARNING_PERCENT = 80

export interface TelemetrySample {
  at: number
  outputId: string | null
  deviceId: string
  nodeId: string
  bitrateBps: number | null
  /** Recording headroom on the slot being written to. */
  remainingMs: number | null
  /** How long the thing has been running, as the device counts it. */
  elapsedMs: number | null
  cachePercent: number | null
  cacheBufferedMs: number | null
  inputPresent: boolean | null
  streaming: boolean | null
  recording: boolean | null
}

interface SampleRow {
  at: number
  output_id: string | null
  device_id: string
  node_id: string
  bitrate_bps: number | null
  remaining_ms: number | null
  elapsed_ms: number | null
  cache_percent: number | null
  cache_buffered_ms: number | null
  input_present: number | null
  streaming: number | null
  recording: number | null
}

export class TelemetryRecorder {
  private readonly db: Db
  private readonly store: RunStore
  private readonly connections: ConnectionManager
  private readonly clock: Clock
  private readonly logger: Logger
  private readonly intervalMs: number
  private readonly retentionMs: number
  private readonly onCacheHigh:
    | ((event: {
        runId: string
        occurrenceId: string
        deviceLabel: string
        outputLabel: string
        percent: number
      }) => void)
    | undefined
  private readonly cacheWarningPercent: () => number
  private lastSampledAt = 0
  private lastPrunedAt = 0
  /** Devices already shouted about, so a cache that sits high for an hour
   *  is one message rather than two hundred. */
  private readonly warned = new Set<string>()

  constructor(init: {
    db: Db
    store: RunStore
    connections: ConnectionManager
    clock: Clock
    logger: Logger
    intervalMs?: number
    retentionMs?: number
    /** Read per check, so a change takes effect without a restart. */
    cacheWarningPercent?: () => number
    onCacheHigh?: (event: {
      runId: string
      occurrenceId: string
      deviceLabel: string
      outputLabel: string
      percent: number
    }) => void
  }) {
    this.onCacheHigh = init.onCacheHigh
    this.cacheWarningPercent = init.cacheWarningPercent ?? (() => CACHE_WARNING_PERCENT)
    this.db = init.db
    this.store = init.store
    this.connections = init.connections
    this.clock = init.clock
    this.logger = init.logger
    this.intervalMs = init.intervalMs ?? DEFAULT_TELEMETRY_INTERVAL_MS
    this.retentionMs = init.retentionMs ?? DEFAULT_TELEMETRY_RETENTION_MS
  }

  /**
   * Called from the scheduler loop. Does nothing most of the time: nothing
   * is running, or it is not due yet.
   */
  async tick(): Promise<void> {
    const now = this.clock.now()
    if (now - this.lastSampledAt < this.intervalMs) return
    this.lastSampledAt = now

    const runs = this.store.listActiveRuns()
    if (runs.length > 0) await this.sample(runs, now)

    if (now - this.lastPrunedAt > 60 * 60_000) {
      this.lastPrunedAt = now
      this.prune(now)
    }
  }

  private async sample(runs: { id: string; occurrence_id: string }[], now: number): Promise<void> {
    for (const run of runs) {
      // One read per node, not per output: two outputs on one encoder are
      // two rows off the same answer, not two conversations with the box.
      const byNode = new Map<
        string,
        { deviceId: string; nodeId: string; outputIds: string[]; label: string }
      >()
      for (const entry of timelineFor(this.db, run.occurrence_id).outputs) {
        const { deviceId, nodeId, id, label } = entry.output
        if (!deviceId || !nodeId) continue
        const key = `${deviceId}/${nodeId}`
        const existing = byNode.get(key)
        if (existing) existing.outputIds.push(id)
        else byNode.set(key, { deviceId, nodeId, outputIds: [id], label })
      }

      for (const { deviceId, nodeId, outputIds, label } of byNode.values()) {
        let state: NodeState | null
        try {
          state = await this.connections.invoke(deviceId, nodeId, 'readState')
        } catch (error) {
          // A device that will not answer is a gap in the chart, which is
          // the truth. It must never be a reason the scheduler stops.
          this.logger.debug?.('telemetry read failed', {
            deviceId,
            nodeId,
            error: error instanceof Error ? error.message : String(error),
          })
          continue
        }
        if (!state) continue
        for (const outputId of outputIds) this.write(run.id, outputId, deviceId, nodeId, now, state)
        this.checkCache(run, deviceId, label, state)
      }
    }
  }

  private write(
    runId: string,
    outputId: string,
    deviceId: string,
    nodeId: string,
    at: number,
    state: NodeState,
  ): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO telemetry_sample
           (run_id, output_id, device_id, node_id, at, bitrate_bps, remaining_ms, elapsed_ms,
            cache_percent, cache_buffered_ms, input_present, streaming, recording)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        runId,
        outputId,
        deviceId,
        nodeId,
        at,
        state.streaming?.bitrateBps ?? null,
        state.recording?.remainingMs ?? null,
        state.recording?.durationMs ?? state.streaming?.durationMs ?? null,
        state.cache?.percent ?? null,
        state.cache?.bufferedMs ?? null,
        state.input === undefined ? null : state.input.present ? 1 : 0,
        state.streaming === undefined ? null : state.streaming.active ? 1 : 0,
        state.recording === undefined ? null : state.recording.active ? 1 : 0,
      )
  }

  /**
   * Shouts once when a device's cache is filling up.
   *
   * Only while it is on air: a cache draining after a stop is doing exactly
   * what it should, and saying so would teach people to ignore this.
   */
  private checkCache(
    run: { id: string; occurrence_id: string },
    deviceId: string,
    outputLabel: string,
    state: NodeState,
  ): void {
    const percent = state.cache?.percent
    if (percent === undefined || percent < this.cacheWarningPercent()) return
    if (state.streaming?.active !== true && state.recording?.active !== true) return

    const key = `${run.id}:${deviceId}`
    if (this.warned.has(key)) return
    this.warned.add(key)

    const label = (
      this.db.prepare('SELECT label FROM device WHERE id = ?').get(deviceId) as
        { label: string } | undefined
    )?.label
    this.logger.warn('a device cache is filling up', { deviceId, percent })
    this.onCacheHigh?.({
      runId: run.id,
      occurrenceId: run.occurrence_id,
      deviceLabel: label ?? deviceId,
      outputLabel,
      percent,
    })
  }

  /** Everything recorded for one run, oldest first. */
  read(runId: string): TelemetrySample[] {
    const rows = this.db
      .prepare(
        `SELECT at, output_id, device_id, node_id, bitrate_bps, remaining_ms, elapsed_ms,
                cache_percent, cache_buffered_ms, input_present, streaming, recording
           FROM telemetry_sample WHERE run_id = ? ORDER BY at`,
      )
      .all(runId) as SampleRow[]

    return rows.map((row) => ({
      at: row.at,
      outputId: row.output_id,
      deviceId: row.device_id,
      nodeId: row.node_id,
      bitrateBps: row.bitrate_bps,
      remainingMs: row.remaining_ms,
      elapsedMs: row.elapsed_ms,
      cachePercent: row.cache_percent,
      cacheBufferedMs: row.cache_buffered_ms,
      inputPresent: row.input_present === null ? null : row.input_present === 1,
      streaming: row.streaming === null ? null : row.streaming === 1,
      recording: row.recording === null ? null : row.recording === 1,
    }))
  }

  private prune(now: number): void {
    const removed = this.db
      .prepare('DELETE FROM telemetry_sample WHERE at < ?')
      .run(now - this.retentionMs)
    const count = Number(removed.changes ?? 0)
    if (count > 0) this.logger.info('pruned telemetry', { samples: count })
  }
}
