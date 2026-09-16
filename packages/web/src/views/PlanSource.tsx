import { useState } from 'react'
import type { ReactNode } from 'react'
import {
  api,
  useResource,
  type PlanGroup,
  type PlanSourceSummary,
  type PlannedService,
} from '../api.ts'
import { Card, ConfirmButton, Empty, ErrorBanner, Field, StatusPill } from '../components.tsx'
import { dateTimeIn } from '../format.ts'
import { byFolder } from '../plan-groups.ts'

/**
 * Where the schedule comes from.
 *
 * Not a destination, despite looking like one: a destination is where a
 * stream goes, and this is what decides there is a stream at all. Paired to
 * a service type, Planning Center says how many services there are that
 * week and when — which a recurrence rule cannot, because a normal Sunday
 * has two and Christmas Eve has one.
 *
 * Connecting is deliberately two fields. Planning Center issues a Personal
 * Access Token for reading your own account, so there is no app to register
 * and no consent screen to publish — the seven-step dance YouTube needs is
 * not needed here, and pretending otherwise would be ceremony.
 */
export function PlanSourceCard({ timezone }: { timezone: string }): ReactNode {
  const { data, error, reload } = useResource(() => api.planSources(), [])
  const sources = data?.sources ?? []

  return (
    <Card>
      <h2 style={{ marginTop: 0 }}>Where the schedule comes from</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        Connect Planning Center and an event can follow its service times instead of a repeating
        rule — including the weeks that are not normal, when there is one service instead of two, or
        three instead of one.
      </p>

      <ErrorBanner error={error} />

      {sources.length === 0 ? (
        <Empty>No schedule sources in this build.</Empty>
      ) : (
        <div className="stack">
          {sources.map((source) => (
            <SourceRow key={source.id} source={source} timezone={timezone} onChanged={reload} />
          ))}
        </div>
      )}
    </Card>
  )
}

function SourceRow({
  source,
  timezone,
  onChanged,
}: {
  source: PlanSourceSummary
  timezone: string
  onChanged: () => void
}): ReactNode {
  const [editing, setEditing] = useState(false)
  const [applicationId, setApplicationId] = useState('')
  const [secret, setSecret] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string>()
  const [showSteps, setShowSteps] = useState(false)
  const [preview, setPreview] = useState(false)

  const connected = source.status.state !== 'not_configured'

  const save = async (): Promise<void> => {
    setBusy(true)
    setProblem(undefined)
    try {
      await api.savePlanCredentials(source.id, { applicationId, secret })
      setEditing(false)
      setApplicationId('')
      setSecret('')
      setPreview(false)
      onChanged()
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span>
          <strong>{source.displayName}</strong> <StatusPill status={pillFor(source.status.state)} />
        </span>
        <span className="row">
          <button onClick={() => setShowSteps((open) => !open)}>
            {showSteps ? 'Hide setup steps' : 'Setup steps'}
          </button>
          {connected ? (
            <>
              <button onClick={() => setPreview((open) => !open)}>
                {preview ? 'Hide what it sees' : 'What it sees'}
              </button>
              <ConfirmButton
                label="Disconnect"
                disabled={busy}
                onConfirm={() =>
                  void api
                    .clearPlanCredentials(source.id)
                    .then(onChanged)
                    .catch((err: unknown) =>
                      setProblem(err instanceof Error ? err.message : String(err)),
                    )
                }
              />
            </>
          ) : null}
          <button onClick={() => setEditing((open) => !open)}>
            {editing ? 'Cancel' : connected ? 'Replace token' : 'Add a token'}
          </button>
        </span>
      </div>

      {/* The message is the useful part of a status: "2 service types
          visible" is how you tell a working token from one belonging to
          somebody who cannot see the service you care about. */}
      {source.status.message ? (
        <p className="muted" style={{ margin: '4px 0 0' }}>
          {source.status.message}
        </p>
      ) : null}

      <ErrorBanner error={problem} />
      {showSteps ? <Steps sourceId={source.id} /> : null}

      {editing ? (
        <div className="stack" style={{ maxWidth: 560, marginTop: 8 }}>
          <Field label="Application ID">
            <input
              value={applicationId}
              onChange={(event) => setApplicationId(event.target.value)}
            />
          </Field>
          <Field
            label="Secret"
            hint="Stored encrypted. There is no screen that shows it again — here or in Planning Center."
          >
            <input
              type="password"
              autoComplete="new-password"
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
            />
          </Field>
          <div className="row">
            <button
              className="solid"
              disabled={busy || !applicationId.trim() || !secret.trim()}
              onClick={() => void save()}
            >
              {busy ? 'Checking…' : 'Save and check'}
            </button>
          </div>
        </div>
      ) : null}

      {preview ? <Preview sourceId={source.id} timezone={timezone} /> : null}
    </div>
  )
}

function Steps({ sourceId }: { sourceId: string }): ReactNode {
  const { data } = useResource(() => api.planSourceInstructions(sourceId), [sourceId])
  if (!data) return null
  return (
    <div className="stack" style={{ margin: '8px 0' }}>
      <ol className="steps">
        {data.steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      {data.warnings.map((warning) => (
        <div key={warning} className="banner error">
          {warning}
        </div>
      ))}
    </div>
  )
}

/**
 * What the token can actually see, before anything is paired to it.
 *
 * The difference between trusting this and hoping. A token that works but
 * belongs to somebody who cannot see the Sunday service type looks
 * identical to a good one until a service does not go out.
 */
function Preview({ sourceId, timezone }: { sourceId: string; timezone: string }): ReactNode {
  const groups = useResource(() => api.planGroups(sourceId), [sourceId])
  const [groupId, setGroupId] = useState<string>()
  const chosen = groupId ?? groups.data?.groups[0]?.id

  const services = useResource(
    () => (chosen ? api.plannedServices(sourceId, chosen) : Promise.resolve({ services: [] })),
    [sourceId, chosen],
  )

  return (
    <div style={{ marginTop: 12 }}>
      <ErrorBanner error={groups.error ?? services.error} />
      {(groups.data?.groups.length ?? 0) > 1 ? (
        <select value={chosen ?? ''} onChange={(event) => setGroupId(event.target.value)}>
          <GroupOptions groups={groups.data?.groups ?? []} />
        </select>
      ) : null}

      {services.data === undefined ? null : services.data.services.length === 0 ? (
        <Empty>Nothing is planned in this service type yet.</Empty>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Service</th>
                <th>Plan</th>
              </tr>
            </thead>
            <tbody>
              {services.data.services.map((service: PlannedService) => (
                <tr key={service.externalId}>
                  <td>{dateTimeIn(service.startsAt, timezone)}</td>
                  <td className="muted">{service.detail?.timeName ?? '—'}</td>
                  <td className="muted">
                    {service.detail?.planTitle ?? service.detail?.seriesTitle ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

/** The status vocabulary the pills already use elsewhere. */
function pillFor(state: PlanSourceSummary['status']['state']): string {
  if (state === 'ok') return 'ok'
  if (state === 'not_configured') return 'unknown'
  if (state === 'credentials_rejected') return 'reauth_required'
  return 'error'
}

/** The options of a service-type picker, foldered where the source says so. */
export function GroupOptions({ groups }: { groups: PlanGroup[] }): ReactNode {
  return (
    <>
      {byFolder(groups).map((bucket) =>
        // A service type at the top level is not put under a heading called
        // nothing; it sits loose, which is where it is.
        bucket.label === '' ? (
          bucket.groups.map((group) => (
            <option key={group.id} value={group.id}>
              {group.name}
            </option>
          ))
        ) : (
          <optgroup key={bucket.label} label={bucket.label}>
            {bucket.groups.map((group) => (
              <option key={group.id} value={group.id}>
                {group.name}
              </option>
            ))}
          </optgroup>
        ),
      )}
    </>
  )
}
