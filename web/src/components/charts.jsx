import { CircleAlert, TriangleAlert } from 'lucide-react';
import { motion } from 'motion/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { formatBytes } from '../format.js';

// Identity colours for the three monitored figures (validated for colour-blind separation in
// light and dark), plus the reserved status colours. Values live in styles.css as --viz-*.
export const METRICS = [
  { id: 'cpu', label: 'CPU', color: 'var(--viz-cpu)', track: 'var(--viz-cpu-track)' },
  { id: 'mem', label: 'Memory', color: 'var(--viz-mem)', track: 'var(--viz-mem-track)' },
  { id: 'disk', label: 'Storage', color: 'var(--viz-disk)', track: 'var(--viz-disk-track)' },
];

const STATUS_COLOR = { warning: 'var(--viz-serious)', critical: 'var(--viz-critical)' };
export const LIMITS = { cpu: [90, 97], mem: [90, 95], disk: [85, 93] };

// Storage turns critical at the alert threshold set in Settings, so the page and the alerts agree.
export function setStorageThreshold(threshold) {
  if (!Number.isFinite(threshold)) return;
  LIMITS.disk = [Math.min(85, threshold - 1), threshold];
}

export function levelOf(metric, value) {
  if (value === null || value === undefined) return null;
  const [warn, crit] = LIMITS[metric];
  return value >= crit ? 'critical' : value >= warn ? 'warning' : null;
}

export const fmtPct = (v) => (v === null || v === undefined ? '—' : `${Math.round(v)}%`);

// Status always travels with an icon and a word, never colour alone.
export function StatusLabel({ level, children }) {
  if (!level) return null;
  const Icon = level === 'critical' ? CircleAlert : TriangleAlert;
  return (
    <span className={`status-label is-${level}`}>
      <Icon size={13} strokeWidth={2.4} />
      {children || (level === 'critical' ? 'Critical' : 'High')}
    </span>
  );
}

// Apple Watch style concentric rings: outer Storage, middle Memory, inner CPU.
// Each ring is a meter: the fill switches to the status colour past its threshold.
export function Rings({ values, size = 104, animate = true }) {
  const stroke = Math.max(7, size * 0.1);
  const gap = Math.max(2, size * 0.022);
  const order = ['disk', 'mem', 'cpu'];
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="rings" role="img" aria-label={order.map((id) => `${METRICS.find((m) => m.id === id).label} ${fmtPct(values[id])}`).join(', ')}>
      {order.map((id, i) => {
        const metric = METRICS.find((m) => m.id === id);
        const r = size / 2 - stroke / 2 - i * (stroke + gap);
        const c = 2 * Math.PI * r;
        const v = values[id];
        const fraction = v === null || v === undefined ? 0 : Math.min(1, Math.max(0, v / 100));
        const level = levelOf(id, v);
        return (
          <g key={id} transform={`rotate(-90 ${size / 2} ${size / 2})`}>
            <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={metric.track} strokeWidth={stroke} />
            {fraction > 0 && (
              <motion.circle
                cx={size / 2}
                cy={size / 2}
                r={r}
                fill="none"
                stroke={level ? STATUS_COLOR[level] : metric.color}
                strokeWidth={stroke}
                strokeLinecap="round"
                strokeDasharray={c}
                initial={animate ? { strokeDashoffset: c } : false}
                animate={{ strokeDashoffset: c * (1 - fraction) }}
                transition={{ type: 'spring', stiffness: 60, damping: 18, delay: animate ? 0.1 + i * 0.08 : 0 }}
              />
            )}
          </g>
        );
      })}
    </svg>
  );
}

// Legend for the rings; doubles as the direct labels (value + detail per figure).
export function RingLegend({ values, details = {}, large = false }) {
  return (
    <ul className={`ring-legend ${large ? 'is-large' : ''}`}>
      {['disk', 'mem', 'cpu'].map((id) => {
        const metric = METRICS.find((m) => m.id === id);
        const level = levelOf(id, values[id]);
        return (
          <li key={id}>
            <span className="legend-key" style={{ background: level ? STATUS_COLOR[level] : metric.color }} />
            <span className="legend-label">{metric.label}</span>
            <span className="legend-value">{fmtPct(values[id])}</span>
            {level ? <StatusLabel level={level} /> : details[id] && <span className="legend-detail">{details[id]}</span>}
          </li>
        );
      })}
    </ul>
  );
}

// Horizontal meter for a disk: same-hue track, fill turns to the status colour past the threshold.
export function Meter({ usedBytes, totalBytes, metric = 'disk' }) {
  const value = usedBytes !== null && totalBytes ? (usedBytes / totalBytes) * 100 : null;
  const level = levelOf(metric, value);
  const m = METRICS.find((x) => x.id === metric);
  return (
    <div className="meter" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={value === null ? undefined : Math.round(value)} aria-label={`${m.label} used`}>
      <div className="meter-track" style={{ background: m.track }}>
        <motion.div
          className="meter-fill"
          style={{ background: level ? STATUS_COLOR[level] : m.color }}
          initial={{ width: 0 }}
          animate={{ width: `${Math.min(100, value || 0)}%` }}
          transition={{ type: 'spring', stiffness: 80, damping: 20 }}
        />
      </div>
      <div className="meter-text">
        <span>
          {formatBytes(usedBytes)} of {formatBytes(totalBytes)}
        </span>
        <span className="meter-pct">
          {fmtPct(value)}
          <StatusLabel level={level} />
        </span>
      </div>
    </div>
  );
}

function useWidth() {
  const ref = useRef(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

const timeFormat = (span) =>
  span > 2 * 24 * 3600e3
    ? (d) => d.toLocaleDateString('en', { weekday: 'short', day: 'numeric' })
    : (d) => d.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', hour12: false });

// One series over time, 0-100%. Gaps in reporting stay gaps. Crosshair + tooltip on hover
// and with the arrow keys; the current value is labelled at the end of the line.
export function AreaChart({ metric, points, since, until, bucketMs, height = 150 }) {
  const [wrapRef, width] = useWidth();
  const [hover, setHover] = useState(null);
  const m = METRICS.find((x) => x.id === metric);
  const pad = { top: 12, right: 48, bottom: 24, left: 36 };
  const w = Math.max(0, width - pad.left - pad.right);
  const h = height - pad.top - pad.bottom;
  const t0 = new Date(since).getTime();
  const t1 = new Date(until).getTime();
  const x = (t) => pad.left + ((t - t0) / (t1 - t0)) * w;
  const y = (v) => pad.top + h - (Math.min(100, Math.max(0, v)) / 100) * h;

  const data = useMemo(() => points.filter((p) => p[metric] !== null && p[metric] !== undefined).map((p) => ({ t: new Date(p.t).getTime(), v: p[metric] })), [points, metric]);

  // Split into runs wherever reports stopped for more than ~2.5 buckets.
  const runs = useMemo(() => {
    const out = [];
    let run = [];
    for (const p of data) {
      if (run.length && p.t - run[run.length - 1].t > bucketMs * 2.5) {
        out.push(run);
        run = [];
      }
      run.push(p);
    }
    if (run.length) out.push(run);
    return out;
  }, [data, bucketMs]);

  const fmt = timeFormat(t1 - t0);
  const ticks = Array.from({ length: 5 }, (_, i) => t0 + ((t1 - t0) * i) / 4);
  const last = data[data.length - 1];
  const level = last ? levelOf(metric, last.v) : null;
  const shown = hover !== null ? data[hover] : null;

  function nearest(clientX, rect) {
    const t = t0 + ((clientX - rect.left - pad.left) / w) * (t1 - t0);
    let best = null;
    let bestD = Infinity;
    data.forEach((p, i) => {
      const d = Math.abs(p.t - t);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  }

  return (
    <figure className="area-chart" ref={wrapRef}>
      <figcaption>
        <span className="chart-key" style={{ background: m.color }} />
        <span className="chart-title">{m.label}</span>
        <span className="chart-now">{last ? fmtPct(last.v) : '—'}</span>
        <StatusLabel level={level} />
      </figcaption>
      {width > 0 && (
        <div className="chart-plot" style={{ height }}>
          <svg
            width={width}
            height={height}
            tabIndex={data.length ? 0 : -1}
            role="img"
            aria-label={`${m.label} usage over time${last ? `, now ${fmtPct(last.v)}` : ''}. Use the arrow keys to read values.`}
            onPointerMove={(e) => data.length && setHover(nearest(e.clientX, e.currentTarget.getBoundingClientRect()))}
            onPointerLeave={() => setHover(null)}
            onBlur={() => setHover(null)}
            onKeyDown={(e) => {
              if (!data.length) return;
              if (e.key === 'ArrowLeft') setHover((i) => Math.max(0, (i ?? data.length) - 1));
              if (e.key === 'ArrowRight') setHover((i) => Math.min(data.length - 1, (i ?? -1) + 1));
            }}
          >
            {[0, 50, 100].map((v) => (
              <g key={v}>
                <line x1={pad.left} x2={pad.left + w} y1={y(v)} y2={y(v)} className="chart-grid" />
                <text x={pad.left - 8} y={y(v)} dy="0.32em" textAnchor="end" className="chart-axis">
                  {v}%
                </text>
              </g>
            ))}
            {ticks.map((t, i) => (
              <text key={t} x={x(t)} y={height - 6} textAnchor={i === 0 ? 'start' : i === ticks.length - 1 ? 'end' : 'middle'} className="chart-axis">
                {fmt(new Date(t))}
              </text>
            ))}
            {runs.map((run, i) => {
              const line = run.map((p, j) => `${j ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
              const area = run.length > 1 ? `${line}L${x(run[run.length - 1].t).toFixed(1)},${y(0)}L${x(run[0].t).toFixed(1)},${y(0)}Z` : '';
              return (
                <g key={i}>
                  {area && <path d={area} fill={m.color} opacity="0.1" />}
                  {run.length > 1 ? (
                    <path d={line} fill="none" stroke={m.color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
                  ) : (
                    <circle cx={x(run[0].t)} cy={y(run[0].v)} r="3" fill={m.color} />
                  )}
                </g>
              );
            })}
            {last && (
              <>
                <circle cx={x(last.t)} cy={y(last.v)} r="4" fill={m.color} stroke="var(--surface)" strokeWidth="2" />
                <text x={x(last.t) + 9} y={y(last.v)} dy="0.32em" className="chart-end">
                  {fmtPct(last.v)}
                </text>
              </>
            )}
            {shown && (
              <g pointerEvents="none">
                <line x1={x(shown.t)} x2={x(shown.t)} y1={pad.top} y2={pad.top + h} className="chart-crosshair" />
                <circle cx={x(shown.t)} cy={y(shown.v)} r="4.5" fill={m.color} stroke="var(--surface)" strokeWidth="2" />
              </g>
            )}
            {!data.length && (
              <text x={pad.left + w / 2} y={pad.top + h / 2} textAnchor="middle" className="chart-axis">
                No reports in this period
              </text>
            )}
          </svg>
          {shown && (
            <div className="chart-tip" style={{ left: Math.min(Math.max(x(shown.t), 70), width - 70), top: Math.max(y(shown.v) - 12, 0) }}>
              <strong>{fmtPct(shown.v)}</strong>
              <span>
                {new Date(shown.t).toLocaleString('en', { weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false })}
              </span>
            </div>
          )}
        </div>
      )}
    </figure>
  );
}
