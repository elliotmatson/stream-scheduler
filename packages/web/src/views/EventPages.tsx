import type { ReactNode } from 'react'
import { api, useResource } from '../api.ts'
import { Card, ConfirmButton, ErrorBanner, PageHead } from '../components.tsx'
import { TagEditor } from '../tags.tsx'
import { EventForm } from './EventForm.tsx'

/** Adding an event: the form on a page of its own, back to the schedule after. */
export function NewEvent({ navigate }: { navigate: (path: string) => void }): ReactNode {
  return (
    <>
      <PageHead
        title="Add an event"
        back={{ to: '/schedule', label: 'Back to the schedule', onNavigate: navigate }}
      />
      <EventForm onDone={() => navigate('/schedule')} />
    </>
  )
}

/**
 * A whole series, for the ones the schedule cannot show.
 *
 * Every event is normally reached through one of its dates. One that has
 * none coming — finished, or following a Planning Center service type with
 * nothing published yet — would otherwise have no way in at all.
 */
export function SeriesPage({
  seriesId,
  navigate,
}: {
  seriesId: string
  navigate: (path: string) => void
}): ReactNode {
  const { data, error, reload } = useResource(() => api.series(), [])
  const series = data?.find((entry) => entry.id === seriesId)

  return (
    <>
      <PageHead
        title={series?.label ?? 'Event'}
        subtitle={series?.describes}
        back={{ to: '/schedule', label: 'Back to the schedule', onNavigate: navigate }}
      />
      <ErrorBanner
        error={error ?? (data && !series ? 'This event no longer exists.' : undefined)}
      />
      {series ? (
        <div className="stack">
          <EventForm key={`${series.id}-${series.version}`} series={series} onDone={reload} />
          <Card>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <TagEditor kind="series" id={series.id} tags={series.tags ?? []} onChanged={reload} />
              <ConfirmButton
                label="Delete this event"
                confirmLabel="Delete it and every date?"
                onConfirm={() => void api.deleteSeries(series.id).then(() => navigate('/schedule'))}
              />
            </div>
          </Card>
        </div>
      ) : null}
    </>
  )
}
