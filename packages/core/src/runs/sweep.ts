import { randomUUID } from 'node:crypto'
import type { Clock, MediaItem, NodeState } from '@scheduler/plugin-sdk'
import type { Db } from '../db/index.js'
import type { RecordingLedger } from './artifacts.js'
import { assess, isConfigured, recordingOutputs, type RetentionCandidate } from './retention.js'

/**
 * Actually removing recordings, in two steps.
 *
 * Phase one of retention answered what would go. This does it, and the
 * shape is the whole safety argument: a sweep is *prepared* — producing an
 * exact, named list and a token — and then *confirmed*, and the confirm
 * removes precisely the files in that list and nothing else. It is the
 * same handshake a HyperDeck itself uses for formatting a card, for the
 * same reason.
 *
 * That matters more than it looks. A sweep that re-derives "what is old"
 * at the moment it deletes can remove something the operator never saw,
 * because a recording finished in the seconds between looking and
 * pressing. Deleting exactly what was on the screen is the only version of
 * this that somebody can be responsible for.
 */

/** How long a prepared sweep stays good. Long enough to read the list. */
export const PLAN_TTL_MS = 5 * 60_000

export interface SweepPlan {
  token: string
  outputId: string
  outputLabel: string
  seriesLabel: string
  deviceId: string
  nodeId: string
  /**
   * Exactly what the confirm will remove, and nothing else.
   *
   * `filename` is ours, for showing somebody; `deviceName` is the deck's
   * own, which is what the delete is issued against. They differ — we ask
   * for "service-5" and the deck writes "service-5.mov" — and deleting by
   * the wrong one silently removes nothing.
   */
  files: {
    artifactId: string
    filename: string
    deviceName: string
    slot: number | null
  }[]
  preparedAt: number
}

export interface SweepOutcome {
  removed: { artifactId: string; filename: string }[]
  failed: { artifactId: string; filename: string; reason: string }[]
}

export class SweepRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SweepRefused'
  }
}

export interface SweeperDeps {
  db: Db
  ledger: RecordingLedger
  clock: Clock
  listMedia: (deviceId: string, nodeId: string) => Promise<MediaItem[] | undefined>
  deleteMedia: (
    deviceId: string,
    nodeId: string,
    args: { name: string; slot?: number },
  ) => Promise<void>
  /** What the device is doing, so a sweep can refuse to touch a card mid-record. */
  stateOf: (deviceId: string) => NodeState[]
  /** The event mid-run on this device, if any. */
  runOn: (deviceId: string) => string | undefined
  /** Whether the node says it can delete at all. */
  canDelete: (deviceId: string, nodeId: string) => boolean
  /** Recording time left on the node's media, for the free-space floor. */
  freeMs?: (deviceId: string, nodeId: string) => number | undefined
}

/** What one output's scheduled sweep did, for the log and the alert. */
export interface SweptOutput {
  outputId: string
  outputLabel: string
  seriesLabel: string
  deviceId: string
  removed: { artifactId: string; filename: string }[]
  failed: { artifactId: string; filename: string; reason: string }[]
}

export class Sweeper {
  private readonly plans = new Map<string, SweepPlan>()
  /** Why the last scheduled pass skipped what it skipped. */
  private readonly refusals: { outputId: string; outputLabel: string; reason: string }[] = []

  constructor(private readonly deps: SweeperDeps) {}

  /**
   * What a sweep of this output would remove, and a token to do it with.
   *
   * Refuses rather than returning an empty plan when the device cannot
   * delete or is busy: "nothing to do" and "not allowed" are different
   * answers and a screen that shows them the same way teaches people to
   * ignore both.
   */
  async prepare(outputId: string): Promise<SweepPlan> {
    const output = recordingOutputs(this.deps.db).find((entry) => entry.outputId === outputId)
    if (!output) throw new SweepRefused(`No recording output with id "${outputId}".`)

    this.refuseIfBusy(output.deviceId, output.nodeId)

    const media = await this.deps.listMedia(output.deviceId, output.nodeId)
    const free = this.deps.freeMs?.(output.deviceId, output.nodeId)
    const report = assess({
      ...output,
      artifacts: this.deps.ledger.forOutput(outputId),
      ...(media === undefined ? {} : { media }),
      ...(free === undefined ? {} : { freeMs: free }),
      now: this.deps.clock.now(),
    })

    const plan: SweepPlan = {
      token: randomUUID(),
      outputId,
      outputLabel: output.outputLabel,
      seriesLabel: output.seriesLabel,
      deviceId: output.deviceId,
      nodeId: output.nodeId,
      files: report.wouldDelete.map((candidate: RetentionCandidate) => ({
        artifactId: candidate.artifact.id,
        filename: candidate.artifact.filename,
        // Falls back to ours only when the device could not list at all.
        // Then it is the best name anybody has, and a delete that misses
        // fails loudly rather than reporting a file gone that is not.
        deviceName: candidate.deviceName ?? candidate.artifact.filename,
        slot: candidate.artifact.slot,
      })),
      preparedAt: this.deps.clock.now(),
    }
    this.plans.set(plan.token, plan)
    return plan
  }

  /**
   * Removes exactly what the plan named.
   *
   * Every rail is checked again here, against the device rather than
   * against the plan: the plan is a record of what somebody agreed to, not
   * a warrant that skips the checks. A deck that started recording in the
   * meantime refuses the whole sweep; a single file that has since been
   * deleted by hand, or whose row has been closed differently, is skipped
   * rather than failing the rest.
   */
  async confirm(token: string): Promise<SweepOutcome> {
    const plan = this.plans.get(token)
    if (!plan) {
      throw new SweepRefused('That sweep has expired or was already run. Prepare it again.')
    }
    if (this.deps.clock.now() - plan.preparedAt > PLAN_TTL_MS) {
      this.plans.delete(token)
      throw new SweepRefused('That sweep is more than five minutes old. Prepare it again.')
    }
    // One use. A token that could be replayed is a sweep that could run
    // twice against a card somebody has since put new footage on.
    this.plans.delete(token)

    this.refuseIfBusy(plan.deviceId, plan.nodeId)

    const outcome: SweepOutcome = { removed: [], failed: [] }
    for (const file of plan.files) {
      const artifact = this.deps.ledger.get(file.artifactId)
      // Skipped rather than failed: somebody removing a file by hand
      // between preparing and confirming is not an error, it is the same
      // outcome arriving by another route.
      if (!artifact || artifact.deletedAt !== null) continue
      if (artifact.endedAt === null) continue

      try {
        await this.deps.deleteMedia(plan.deviceId, plan.nodeId, {
          name: file.deviceName,
          ...(file.slot === null ? {} : { slot: file.slot }),
        })
        this.deps.ledger.deleted(file.artifactId, this.deps.clock.now())
        outcome.removed.push({ artifactId: file.artifactId, filename: file.filename })
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        this.deps.ledger.failed(file.artifactId, reason)
        outcome.failed.push({ artifactId: file.artifactId, filename: file.filename, reason })
      }
    }
    return outcome
  }

  /**
   * The scheduled pass: every output whose policy asks to be enforced.
   *
   * Runs on the hour, and does the same prepare-then-confirm as the button
   * — same rails, same code, checked twice against the device rather than
   * once against a policy. What it does not do is re-derive the list at
   * the moment it deletes, which matters more here than it does for a
   * person: this runs unattended, and a sweep that decides and acts in the
   * same breath has nothing anybody could have looked at.
   *
   * Refusals are not failures. A deck mid-record, an event under way, a
   * device that is off — all of them mean "not now", which on an hourly
   * job is simply the next hour. They are logged and skipped; only a
   * delete that was attempted and did not take is reported as a failure.
   *
   * Returns only the outputs where something actually happened, so a
   * caller can tell a quiet hour from a busy one without filtering.
   */
  async sweepDue(): Promise<SweptOutput[]> {
    const swept: SweptOutput[] = []

    for (const output of recordingOutputs(this.deps.db)) {
      // No limit set means no consent to delete. This is the line that
      // keeps an output nobody configured out of an automatic job.
      if (!isConfigured(output.policy)) continue

      try {
        const plan = await this.prepare(output.outputId)
        if (plan.files.length === 0) continue
        const outcome = await this.confirm(plan.token)
        if (outcome.removed.length === 0 && outcome.failed.length === 0) continue
        swept.push({
          outputId: output.outputId,
          outputLabel: output.outputLabel,
          seriesLabel: output.seriesLabel,
          deviceId: output.deviceId,
          ...outcome,
        })
      } catch (error) {
        // Including SweepRefused: see above. One output being unavailable
        // must not stop the others being tidied.
        this.refusals.push({
          outputId: output.outputId,
          outputLabel: output.outputLabel,
          reason: error instanceof Error ? error.message : String(error),
        })
      }
    }

    return swept
  }

  /** Why outputs were skipped on the last scheduled pass, for the log. */
  takeRefusals(): { outputId: string; outputLabel: string; reason: string }[] {
    return this.refusals.splice(0, this.refusals.length)
  }

  /**
   * The two reasons a card is off limits, whatever the policy says.
   *
   * A deck cannot be swept while it is recording — not because the
   * hardware refuses (it may not), but because a card being written to is
   * not one to be tidying up, and finding out afterwards is not a thing
   * anybody should have to do. The run check catches an event that has
   * started but whose deck has not begun rolling yet; the state check
   * catches a deck recording for a reason this scheduler did not start.
   */
  private refuseIfBusy(deviceId: string, nodeId: string): void {
    if (!this.deps.canDelete(deviceId, nodeId)) {
      throw new SweepRefused('This device cannot remove files, so it cannot be swept.')
    }
    const run = this.deps.runOn(deviceId)
    if (run) {
      throw new SweepRefused(`"${run}" is mid-run on this device. Sweeping waits until it is done.`)
    }
    if (this.deps.stateOf(deviceId).some((state) => state.recording?.active === true)) {
      throw new SweepRefused('This device is recording. Sweeping waits until it stops.')
    }
  }
}
