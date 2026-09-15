import { randomUUID } from 'node:crypto'
import type { Db } from '../db/index.js'

/**
 * A record of what this scheduler recorded, and where it put it.
 *
 * Retention cannot be built on a listing off the card. A deck names its
 * clips and will not say when they were made; half the files on a Sunday
 * card were put there by a person with a camera rather than by this app;
 * and "delete anything older than thirty days" run against a listing is a
 * sentence nobody should be able to type. A row written when a recording
 * starts answers both questions — this one is ours, and it was made then —
 * which is what makes deleting it later a safe thing to automate.
 *
 * Nothing deletes anything yet. This is the record that makes it possible
 * to say what would go.
 */

export interface RecordingArtifact {
  id: string
  runId: string
  outputId: string
  deviceId: string
  nodeId: string
  slot: number | null
  filename: string
  startedAt: number
  /** Null while it is still being written, or if the run never finished. */
  endedAt: number | null
  deletedAt: number | null
  lastError: string | null
}

interface ArtifactRow {
  id: string
  run_id: string
  output_id: string
  device_id: string
  node_id: string
  slot: number | null
  filename: string
  started_at: number
  ended_at: number | null
  deleted_at: number | null
  last_error: string | null
}

export class RecordingLedger {
  private readonly db: Db

  constructor(init: { db: Db }) {
    this.db = init.db
  }

  /** Written as a recording starts, so an interrupted run still leaves a
   *  record of the file it left on the card. */
  started(input: {
    runId: string
    outputId: string
    deviceId: string
    nodeId: string
    slot?: number
    filename: string
    at: number
  }): string {
    const id = randomUUID()
    this.db
      .prepare(
        `INSERT INTO recording_artifact
           (id, run_id, output_id, device_id, node_id, slot, filename, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.runId,
        input.outputId,
        input.deviceId,
        input.nodeId,
        input.slot ?? null,
        input.filename,
        input.at,
      )
    return id
  }

  /** Closed off when the recording stops cleanly. */
  finished(runId: string, outputId: string, at: number): void {
    this.db
      .prepare(
        `UPDATE recording_artifact SET ended_at = ?
          WHERE run_id = ? AND output_id = ? AND ended_at IS NULL`,
      )
      .run(at, runId, outputId)
  }

  /** Everything still on the card, for one output, newest first. */
  forOutput(outputId: string): RecordingArtifact[] {
    return this.map(
      this.db
        .prepare(
          `SELECT * FROM recording_artifact
            WHERE output_id = ? AND deleted_at IS NULL
            ORDER BY started_at DESC`,
        )
        .all(outputId) as ArtifactRow[],
    )
  }

  /** Everything still on one device's media, newest first. */
  forNode(deviceId: string, nodeId: string): RecordingArtifact[] {
    return this.map(
      this.db
        .prepare(
          `SELECT * FROM recording_artifact
            WHERE device_id = ? AND node_id = ? AND deleted_at IS NULL
            ORDER BY started_at DESC`,
        )
        .all(deviceId, nodeId) as ArtifactRow[],
    )
  }

  private map(rows: ArtifactRow[]): RecordingArtifact[] {
    return rows.map((row) => ({
      id: row.id,
      runId: row.run_id,
      outputId: row.output_id,
      deviceId: row.device_id,
      nodeId: row.node_id,
      slot: row.slot,
      filename: row.filename,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      deletedAt: row.deleted_at,
      lastError: row.last_error,
    }))
  }
}
