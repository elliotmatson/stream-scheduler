import { useId, useState } from 'react'
import type { ReactNode } from 'react'
import { clockTimeIn } from './format.ts'

/**
 * A small line chart, drawn straight into SVG.
 *
 * No charting library: this app draws one shape — a value against time,
 * across a few hundred points — and a library that does axes, legends,
 * zooming and animation would be more code than the app to be told not to
 * do most of it. The router and the calendar are hand-rolled here for the
 * same reason.
 *
 * What it does do: scale to the data, mark gaps where the device stopped
 * answering, label both axes, and say what a point is when you hover it.
 * What it does not: zoom, pan, or animate. Narrowing the window is the
 * range picker's job, on the server, where the readings are.
 *
 * The plot is an SVG stretched to whatever width it is given, so no text
 * goes inside it — a label in a stretched viewBox is a squashed label.
 * The gridlines are SVG (a horizontal line survives being stretched); the
 * numbers beside them and the times underneath are HTML, positioned to
 * match.
 */

export interface Point {
  at: number
  /** Null is a gap — the device said nothing — and is drawn as one. */
  value: number | null
}

/** How many gridlines, counting both ends. Four is a scale; eight is a net. */
const TICKS = 4

export function Chart({
  points,
  label,
  format,
  /** The event's zone, so the times under the axis are the event's times. */
  timezone,
  /** Forces the top of the scale, for a reading with a natural ceiling. */
  max,
  /** Below this the line is drawn as trouble. */
  floor,
  height = 96,
  tone = 'accent',
}: {
  points: Point[]
  label: string
  format: (value: number) => string
  timezone: string
  max?: number
  floor?: number
  height?: number
  tone?: 'accent' | 'warn' | 'bad'
}): ReactNode {
  const gradientId = useId()
  const [hover, setHover] = useState<{ x: number; point: Point } | null>(null)

  const real = points.filter(
    (point): point is { at: number; value: number } => point.value !== null,
  )
  if (real.length === 0) {
    return (
      <figure className="chart">
        <figcaption>{label}</figcaption>
        <div className="chart-empty">Nothing was reported.</div>
      </figure>
    )
  }

  const width = 600
  const from = points[0]!.at
  const to = points[points.length - 1]!.at
  const span = Math.max(to - from, 1)

  const lowest = Math.min(...real.map((point) => point.value))
  const highest = Math.max(...real.map((point) => point.value))

  /**
   * The band the line is drawn in.
   *
   * Not from zero unless the reading means something at zero. A bitrate
   * wandering between 6.2 and 6.8 Mb/s drawn from zero is a straight line
   * across the top of the box, which is exactly the shape somebody opened
   * the chart to see the absence of. Where a ceiling is given — a
   * percentage — that is used instead, because 92% of a hundred is the
   * reading, not 92% of the busiest minute so far.
   */
  const pad = Math.max((highest - lowest) * 0.25, highest * 0.02, 1)
  const bottom = max === undefined ? Math.max(lowest - pad, 0) : 0
  const ceiling = max ?? highest + pad
  const range = Math.max(ceiling - bottom, 1)

  // Evenly spaced, top to bottom, so the labels can be a flex column with
  // space-between rather than each one positioned by hand.
  const ticks = Array.from(
    { length: TICKS },
    (_, i) => ceiling - (i * (ceiling - bottom)) / (TICKS - 1),
  )

  const x = (at: number): number => ((at - from) / span) * width
  const y = (value: number): number =>
    height - ((Math.min(Math.max(value, bottom), ceiling) - bottom) / range) * height

  // Broken into runs so a gap is a gap rather than a straight line drawn
  // across the minutes a device was not answering.
  const runs: { at: number; value: number }[][] = []
  let current: { at: number; value: number }[] = []
  for (const point of points) {
    if (point.value === null) {
      if (current.length > 0) runs.push(current)
      current = []
    } else {
      current.push({ at: point.at, value: point.value })
    }
  }
  if (current.length > 0) runs.push(current)

  const path = (run: { at: number; value: number }[]): string =>
    run
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.at).toFixed(1)},${y(p.value).toFixed(1)}`)
      .join(' ')

  const latest = real[real.length - 1]!

  return (
    <figure className={`chart tone-${tone}`}>
      <figcaption>
        {label}
        <span className="chart-now">{format(hover?.point.value ?? latest.value)}</span>
      </figcaption>

      <div className="chart-plot">
        <div className="chart-yaxis" aria-hidden>
          {ticks.map((value) => (
            <span key={value}>{format(value)}</span>
          ))}
        </div>

        <svg
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={`${label}: between ${format(lowest)} and ${format(highest)}`}
          onMouseLeave={() => setHover(null)}
          onMouseMove={(event) => {
            const box = event.currentTarget.getBoundingClientRect()
            const at = from + ((event.clientX - box.left) / box.width) * span
            const nearest = points.reduce((best, point) =>
              Math.abs(point.at - at) < Math.abs(best.at - at) ? point : best,
            )
            setHover({ x: x(nearest.at), point: nearest })
          }}
        >
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="currentColor" stopOpacity="0.22" />
              <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
            </linearGradient>
          </defs>

          {/* The scale, behind the line. */}
          {ticks.map((value) => (
            <line
              key={value}
              className="chart-grid"
              x1="0"
              x2={width}
              y1={y(value)}
              y2={y(value)}
              vectorEffect="non-scaling-stroke"
            />
          ))}

          {floor !== undefined && floor > bottom && floor < ceiling ? (
            <line
              className="chart-floor"
              x1="0"
              x2={width}
              y1={y(floor)}
              y2={y(floor)}
              vectorEffect="non-scaling-stroke"
            />
          ) : null}

          {runs.map((run) => (
            <g key={run[0]!.at}>
              {run.length > 1 ? (
                <path
                  className="chart-fill"
                  fill={`url(#${gradientId})`}
                  d={`${path(run)} L${x(run[run.length - 1]!.at).toFixed(1)},${height} L${x(run[0]!.at).toFixed(1)},${height} Z`}
                />
              ) : null}
              <path className="chart-line" d={path(run)} vectorEffect="non-scaling-stroke" />
              {/* A single reading has no line to draw, so it gets a dot. */}
              {run.length === 1 ? (
                <circle className="chart-dot" cx={x(run[0]!.at)} cy={y(run[0]!.value)} r="2.5" />
              ) : null}
            </g>
          ))}

          {hover && hover.point.value !== null ? (
            <>
              <line
                className="chart-cursor"
                x1={hover.x}
                x2={hover.x}
                y1="0"
                y2={height}
                vectorEffect="non-scaling-stroke"
              />
              <circle className="chart-dot" cx={hover.x} cy={y(hover.point.value)} r="3" />
            </>
          ) : null}
        </svg>
      </div>

      {/* When, in the event's zone. Three is as many as fits at the widths
          this is drawn at, and the ends are the two that matter. */}
      <div className="chart-xaxis" aria-hidden>
        <span>{clockTimeIn(from, timezone)}</span>
        <span>{span > 60_000 ? clockTimeIn(from + span / 2, timezone) : ''}</span>
        <span>{clockTimeIn(to, timezone)}</span>
      </div>
    </figure>
  )
}
