// Lightweight SVG balance chart — no charting library.
// Total balance over time + optional cost-basis dashed line.

import { useMemo } from 'react'
import type { BalancePoint } from '../lib/history'
import { formatMoney } from '../lib/rails'

export default function BalanceChart({
  points,
  costBasis,
  height = 148,
}: {
  points: BalancePoint[]
  costBasis?: number
  height?: number
}) {
  const width = 320
  const pad = { t: 10, r: 6, b: 8, l: 6 }
  const innerW = width - pad.l - pad.r
  const innerH = height - pad.t - pad.b

  const geom = useMemo(() => {
    if (points.length < 2) return null
    const minT = Math.min(...points.map((p) => p.t))
    const maxT = Math.max(...points.map((p) => p.t))
    const vals = points.map((p) => p.total)
    if (costBasis != null && costBasis > 0) vals.push(costBasis)
    const minY = Math.min(...vals)
    const maxY = Math.max(...vals)
    const spanT = Math.max(1, maxT - minT)
    const spanY = Math.max(0.01, maxY - minY) * 1.12
    const y0 = minY - spanY * 0.06

    const toX = (t: number) => pad.l + ((t - minT) / spanT) * innerW
    const toY = (v: number) => pad.t + innerH - ((v - y0) / spanY) * innerH

    const coords = points.map((p) => ({ x: toX(p.t), y: toY(p.total) }))
    const line = coords
      .map((c, i) => `${i === 0 ? 'M' : 'L'}${c.x.toFixed(1)},${c.y.toFixed(1)}`)
      .join(' ')
    const last = coords[coords.length - 1]!
    const area =
      line +
      ` L${last.x.toFixed(1)},${(pad.t + innerH).toFixed(1)}` +
      ` L${coords[0]!.x.toFixed(1)},${(pad.t + innerH).toFixed(1)} Z`

    let basisLine: string | null = null
    if (costBasis != null && costBasis > 0) {
      const y = toY(costBasis)
      basisLine = `M${pad.l},${y.toFixed(1)} L${pad.l + innerW},${y.toFixed(1)}`
    }

    const firstTotal = points[0]!.total
    const lastTotal = points[points.length - 1]!.total
    const up = lastTotal >= firstTotal

    return {
      line,
      area,
      basisLine,
      up,
      last,
      lastTotal,
    }
  }, [points, costBasis, innerW, innerH, pad.l, pad.t])

  if (!geom) {
    return (
      <div className="chart-empty small muted">
        Chart fills as your balance is tracked over time.
      </div>
    )
  }

  const stroke = geom.up ? 'var(--up)' : 'var(--down)'

  return (
    <div className="chart-wrap">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        height={height}
        role="img"
        aria-label={`Balance over time, now ${formatMoney('USD', geom.lastTotal)}`}
      >
        <defs>
          <linearGradient id="balFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={stroke} stopOpacity="0.3" />
            <stop offset="100%" stopColor={stroke} stopOpacity="0.02" />
          </linearGradient>
        </defs>
        <path d={geom.area} fill="url(#balFill)" />
        <path
          d={geom.line}
          fill="none"
          stroke={stroke}
          strokeWidth="2.25"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {geom.basisLine && (
          <path
            d={geom.basisLine}
            fill="none"
            stroke="var(--ink-faint)"
            strokeWidth="1.25"
            strokeDasharray="4 4"
          />
        )}
        <circle cx={geom.last.x} cy={geom.last.y} r="3.5" fill={stroke} />
      </svg>
      <div className="chart-legend small muted">
        <span>
          <span className="chart-swatch" style={{ background: stroke }} />{' '}
          Balance
        </span>
        {costBasis != null && costBasis > 0 && (
          <span>
            <span className="chart-swatch dashed" /> Cost basis
          </span>
        )}
      </div>
    </div>
  )
}
