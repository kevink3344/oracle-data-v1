import { useEffect, useMemo, useRef, useState } from 'react';
import type { MonthPoint } from '../data/derive';
import { money0, moneyShort, monthLabel, monthLong, num } from '../data/format';

interface Pt {
  x: number;
  y: number;
}

/** Round an axis maximum up to a readable step: 1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10 × 10ⁿ. */
function niceCeil(value: number): number {
  if (!(value > 0)) return 1;
  const base = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) {
    if (value <= step * base) return step * base;
  }
  return 10 * base;
}

/**
 * Fritsch–Carlson monotone cubic interpolation.
 *
 * A plain Catmull-Rom spline overshoots between unequal neighbours, which on a
 * spend curve draws negative money and invent peak months that do not exist. This
 * variant limits the tangents so the curve can never leave the interval between
 * two consecutive points.
 */
function monotonePath(points: Pt[]): string {
  const n = points.length;
  if (n === 0) return '';
  if (n === 1) return `M${points[0].x},${points[0].y}`;
  if (n === 2) return `M${points[0].x},${points[0].y}L${points[1].x},${points[1].y}`;

  const dx: number[] = [];
  const slope: number[] = [];
  for (let i = 0; i < n - 1; i += 1) {
    dx[i] = points[i + 1].x - points[i].x;
    slope[i] = (points[i + 1].y - points[i].y) / dx[i];
  }

  const tangent: number[] = new Array(n);
  tangent[0] = slope[0];
  tangent[n - 1] = slope[n - 2];

  for (let i = 1; i < n - 1; i += 1) {
    if (slope[i - 1] * slope[i] <= 0) {
      tangent[i] = 0;
    } else {
      const w1 = 2 * dx[i] + dx[i - 1];
      const w2 = dx[i] + 2 * dx[i - 1];
      tangent[i] = (w1 + w2) / (w1 / slope[i - 1] + w2 / slope[i]);
    }
  }

  let d = `M${points[0].x},${points[0].y}`;
  for (let i = 0; i < n - 1; i += 1) {
    const h = dx[i] / 3;
    d +=
      `C${points[i].x + h},${points[i].y + tangent[i] * h}` +
      ` ${points[i + 1].x - h},${points[i + 1].y - tangent[i + 1] * h}` +
      ` ${points[i + 1].x},${points[i + 1].y}`;
  }
  return d;
}

interface Props {
  months: MonthPoint[];
  selected: string | null;
  onSelect: (ym: string | null) => void;
}

export default function TrendChart({ months, selected, onSelect }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);
  const [hover, setHover] = useState<string | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setWidth(Math.max(320, Math.round(el.clientWidth))));
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
    };
  }, []);

  const H = width < 560 ? 260 : 300;
  const pad = { t: 22, r: 16, b: 36, l: 46 };
  const innerW = Math.max(1, width - pad.l - pad.r);
  const innerH = H - pad.t - pad.b;

  const geometry = useMemo(() => {
    if (months.length === 0) return null;

    const yMax = niceCeil(Math.max(...months.map((m) => m.amount)));
    const step = months.length > 1 ? innerW / (months.length - 1) : innerW;
    const xOf = (i: number) => pad.l + (months.length > 1 ? i * step : innerW / 2);
    const yOf = (v: number) => pad.t + innerH - (v / yMax) * innerH;

    const points: Pt[] = months.map((m, i) => ({ x: xOf(i), y: yOf(m.amount) }));
    const line = monotonePath(points);
    const base = pad.t + innerH;
    const area = `${line}L${points[points.length - 1].x},${base}L${points[0].x},${base}Z`;

    // Label thinning runs from the RIGHT so the newest months always keep a label
    // when the chart is too narrow for all of them.
    const every = Math.max(1, Math.ceil(48 / Math.max(step, 1)));
    const ticks = new Set<number>();
    for (let i = months.length - 1; i >= 0; i -= every) ticks.add(i);
    const selectedIndex = selected ? months.findIndex((m) => m.ym === selected) : -1;
    if (selectedIndex >= 0) ticks.add(selectedIndex);

    const kept = [...ticks]
      .filter(
        (i) => selectedIndex < 0 || i === selectedIndex || Math.abs(xOf(i) - xOf(selectedIndex)) > 46,
      )
      .sort((a, b) => a - b);

    const grid = [0, 0.25, 0.5, 0.75, 1].map((f) => ({ v: yMax * f, y: yOf(yMax * f) }));

    const maxIndex = months.reduce((best, m, i) => (m.amount > months[best].amount ? i : best), 0);
    const labelled = new Set<number>([maxIndex, months.length - 1]);
    if (selectedIndex >= 0) labelled.add(selectedIndex);

    return { yMax, xOf, yOf, step, points, line, area, base, kept, grid, labelled };
  }, [months, innerW, innerH, pad.l, pad.t, selected]);

  if (!geometry) {
    // "in this extract" was the old wording, and it was wrong once the account scope existed: this
    // component only knows it has no months, and the scope can remove every one of them. The reason
    // belongs to the page that owns the control, which states it in the scope's name.
    return <div className="empty">No dated purchase-order lines to plot.</div>;
  }

  const active = hover ?? selected;
  const activeIndex = active ? months.findIndex((m) => m.ym === active) : -1;
  const activePoint = activeIndex >= 0 ? geometry.points[activeIndex] : null;

  const toggle = (ym: string) => onSelect(selected === ym ? null : ym);

  return (
    <div className="chart-wrap" ref={wrapRef}>
      {/* role="group", not "img": the month columns are real buttons, and an
          explicit img role would hide every one of them from the a11y tree. */}
      <svg
        viewBox={`0 0 ${width} ${H}`}
        height={H}
        role="group"
        aria-label="Committed value per month"
      >
        <defs>
          <linearGradient id="trend-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#165788" stopOpacity="0.16" />
            <stop offset="100%" stopColor="#165788" stopOpacity="0" />
          </linearGradient>
        </defs>

        {geometry.grid.map((g, i) => (
          <g key={i}>
            <line
              x1={pad.l}
              y1={g.y}
              x2={pad.l + innerW}
              y2={g.y}
              stroke="#d4d4d4"
              strokeWidth="1"
              strokeDasharray="2 4"
            />
            <text
              x={pad.l - 8}
              y={g.y + 3.5}
              textAnchor="end"
              fontSize="10"
              fill="var(--text-faint)"
            >
              {moneyShort(g.v)}
            </text>
          </g>
        ))}

        <path d={geometry.area} fill="url(#trend-fill)" />
        <path
          d={geometry.line}
          fill="none"
          stroke="var(--series-capital)"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {months.map((m, i) => {
          const p = geometry.points[i];
          const isActive = i === activeIndex;
          return (
            <g key={m.ym}>
              <circle
                cx={p.x}
                cy={p.y}
                r={isActive ? 5 : 3.5}
                fill={isActive ? 'var(--secondary-color)' : 'var(--surface)'}
                stroke="var(--series-capital)"
                strokeWidth="2"
              />
              {geometry.labelled.has(i) && !isActive ? (
                <text
                  x={p.x}
                  y={p.y - 10}
                  textAnchor="middle"
                  fontSize="10"
                  fontWeight="700"
                  fill="var(--text-muted)"
                >
                  {moneyShort(m.amount)}
                </text>
              ) : null}
            </g>
          );
        })}

        {geometry.kept.map((i) => (
          <text
            key={`t-${i}`}
            x={geometry.xOf(i)}
            y={H - 14}
            textAnchor="middle"
            fontSize="10"
            fontWeight={i === activeIndex ? '700' : '400'}
            fill={i === activeIndex ? 'var(--text-heading)' : 'var(--text-faint)'}
          >
            {monthLabel(months[i].ym)}
          </text>
        ))}

        {months.map((m, i) => (
          <rect
            key={`hit-${m.ym}`}
            className="hit"
            x={geometry.xOf(i) - geometry.step / 2}
            y={pad.t}
            width={Math.max(geometry.step, 1)}
            height={innerH}
            fill="transparent"
            tabIndex={0}
            role="button"
            aria-pressed={selected === m.ym}
            aria-label={`${monthLong(m.ym)}: ${money0(m.amount)} committed across ${num(m.lines)} lines`}
            onMouseEnter={() => setHover(m.ym)}
            onMouseLeave={() => setHover(null)}
            onFocus={() => setHover(m.ym)}
            onBlur={() => setHover(null)}
            onClick={() => toggle(m.ym)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                toggle(m.ym);
              }
            }}
          />
        ))}
      </svg>

      {activePoint && activeIndex >= 0 ? (
        <div
          className="tip"
          style={{
            left: `${activePoint.x}px`,
            top: activePoint.y < 52 ? `${activePoint.y + 14}px` : `${activePoint.y - 8}px`,
            transform: activePoint.y < 52 ? 'translate(-50%, 0)' : 'translate(-50%, -100%)',
          }}
        >
          <div>
            <b>{monthLong(months[activeIndex].ym)}</b>
          </div>
          <div>
            <b>{money0(months[activeIndex].amount)}</b> committed
          </div>
          <div>
            {num(months[activeIndex].lines)} lines · {num(months[activeIndex].orders)} orders
          </div>
          <div>{num(months[activeIndex].vendors)} vendors</div>
        </div>
      ) : null}
    </div>
  );
}
