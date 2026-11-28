'use client';

/**
 * Charts follow the dataviz method: one axis, thin marks (2px lines, r≥4 markers with a 2px surface ring),
 * hairline solid grid, text in text tokens (never series colors), legend for ≥2 series, tooltip on every chart,
 * colors from validated palette slots (--series-1/2 in globals.css). Every chart sits above a table with the same
 * values (relief for the sub-3:1 light-mode orange).
 *
 * Recharts 3 keeps chart config in an internal store: object/array props must be referentially stable, or every
 * render looks like a config change and re-renders forever. All literals live at module level.
 */
import { useCallback, useMemo } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  LabelList,
  Line,
  LineChart,
  PolarAngleAxis,
  PolarGrid,
  PolarRadiusAxis,
  Radar,
  RadarChart,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from 'recharts';

const AXIS_TICK = { fill: 'var(--muted)', fontSize: 11 };
const TOOLTIP_CONTENT = { background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 6, fontSize: 12, color: 'var(--fg)' };
const TOOLTIP_LABEL = { color: 'var(--muted)' };
const TOOLTIP_ITEM = { color: 'var(--fg)' };
const CURSOR = { stroke: 'var(--axis)', strokeWidth: 1 };
const SCORE_DOMAIN: [number, number] = [0, 10];
const SCORE_TICKS_FULL = [0, 2, 4, 6, 8, 10];
const SCORE_TICKS_SMALL = [0, 5, 10];
const SCATTER_MARGIN = { top: 16, right: 24, bottom: 28, left: 0 };
const LINE_MARGIN = { top: 8, right: 12, bottom: 0, left: 0 };
const DOT_SIZE: [number, number] = [90, 90];
const LABEL_STYLE = { fill: 'var(--fg)', fontSize: 11 };
const DOT_1 = { r: 4, fill: 'var(--series-1)', stroke: 'var(--panel)', strokeWidth: 2 };
const DOT_2 = { r: 4, fill: 'var(--series-2)', stroke: 'var(--panel)', strokeWidth: 2 };
const ACTIVE_DOT = { r: 6, stroke: 'var(--panel)', strokeWidth: 2 };

const fmtValue = (v: unknown, n: unknown): [string, string] => [typeof v === 'number' ? v.toFixed(1) : '–', String(n)];
/** ~10% headroom, rounded up to a clean axis end (e.g. 2,187 → 2,500) */
function niceMax(max: number) {
  const v = max * 1.1;
  const step = 10 ** Math.floor(Math.log10(v || 1)) / 2;
  return Math.ceil(v / step) * step;
}
const X_DOMAIN: [number, (max: number) => number] = [0, niceMax];

/** Scatter tooltip: the model name as title (identity never color-alone), then its two values. */
function ScatterTip({
  active,
  payload,
  xLabel,
  yLabel,
}: {
  active?: boolean;
  payload?: readonly { payload?: unknown }[];
  xLabel: string;
  yLabel: string;
}) {
  const p = payload?.[0]?.payload as SpeedPoint | undefined;
  if (!active || !p) return null;
  return (
    <div style={TOOLTIP_CONTENT} className="px-2.5 py-1.5">
      <div className="font-medium">{p.model}</div>
      <div className="text-muted">
        {yLabel} <span className="text-fg tabular">{p.score.toFixed(1)}</span> · {xLabel}{' '}
        <span className="text-fg tabular">{p.x.toLocaleString()}</span>
      </div>
      {p.detail && <div className="text-muted">{p.detail}</div>}
    </div>
  );
}

export interface SpeedPoint {
  model: string;
  /** x value: tokens/s, or latency (ms) when the test has no token throughput */
  x: number;
  /** 0–10: judge average, or the automatic score for tests without judges */
  score: number;
  /** extra tooltip line, e.g. which capabilities an overall score covers */
  detail?: string;
}

/** Speed vs quality: one dot per model (single series → no legend; names as direct labels). */
export function SpeedQualityScatter({ points, xLabel, yLabel }: { points: SpeedPoint[]; xLabel: string; yLabel: string }) {
  // labels sit beside their dot (not above: close dots made stacked-above labels collide); the right-most dots put
  // theirs on the left so they stay inside the plot. Two Scatter elements, same color: still one series.
  const [leftSide, rightSide] = useMemo(() => {
    const max = Math.max(...points.map((p) => p.x), 1);
    return [points.filter((p) => p.x <= max * 0.7), points.filter((p) => p.x > max * 0.7)];
  }, [points]);
  const tip = useCallback(
    (props: { active?: boolean; payload?: readonly { payload?: unknown }[] }) => <ScatterTip {...props} xLabel={xLabel} yLabel={yLabel} />,
    [xLabel, yLabel],
  );
  if (points.length < 2) return <p className="text-xs text-muted">Needs at least two models with scores.</p>;
  return (
    <div className="h-72 w-full">
      <ResponsiveContainer>
        <ScatterChart margin={SCATTER_MARGIN}>
          <CartesianGrid stroke="var(--grid)" strokeWidth={1} />
          <XAxis
            type="number"
            dataKey="x"
            name={xLabel}
            domain={X_DOMAIN}
            tickCount={6}
            allowDecimals={false}
            tick={AXIS_TICK}
            stroke="var(--axis)"
            tickLine={false}
          />
          <YAxis
            type="number"
            dataKey="score"
            name={yLabel}
            domain={SCORE_DOMAIN}
            ticks={SCORE_TICKS_FULL}
            tick={AXIS_TICK}
            stroke="var(--axis)"
            tickLine={false}
            width={36}
          />
          <ZAxis range={DOT_SIZE} />
          <Tooltip cursor={CURSOR} content={tip} />
          <Scatter data={leftSide} fill="var(--series-1)" stroke="var(--panel)" strokeWidth={2} isAnimationActive={false}>
            <LabelList dataKey="model" position="right" offset={10} style={LABEL_STYLE} />
          </Scatter>
          <Scatter data={rightSide} fill="var(--series-1)" stroke="var(--panel)" strokeWidth={2} isAnimationActive={false}>
            <LabelList dataKey="model" position="left" offset={10} style={LABEL_STYLE} />
          </Scatter>
        </ScatterChart>
      </ResponsiveContainer>
      <p className="-mt-1 text-center text-[11px] text-muted">{xLabel}</p>
    </div>
  );
}

export interface HistoryPoint {
  label: string; // "#3 · 26 Nov" (x category)
  date: string;
  judgeAvg: number | null;
  auto: number | null;
  digest: string;
}

/** One small multiple: judge average and auto score over successive runs (same 0–10 scale, one axis). */
export function HistoryChart({ points }: { points: HistoryPoint[] }) {
  const labelFormatter = useCallback((_l: unknown, p: readonly { payload?: unknown }[]) => {
    const d = p?.[0]?.payload as HistoryPoint | undefined;
    return d ? `${d.date} · digest ${d.digest}` : '';
  }, []);
  return (
    <div className="h-44 w-full">
      <ResponsiveContainer>
        <LineChart data={points} margin={LINE_MARGIN}>
          <CartesianGrid stroke="var(--grid)" strokeWidth={1} vertical={false} />
          <XAxis dataKey="label" tick={AXIS_TICK} stroke="var(--axis)" tickLine={false} interval="preserveStartEnd" />
          <YAxis domain={SCORE_DOMAIN} ticks={SCORE_TICKS_SMALL} tick={AXIS_TICK} stroke="var(--axis)" tickLine={false} width={28} />
          <Tooltip
            contentStyle={TOOLTIP_CONTENT}
            labelStyle={TOOLTIP_LABEL}
            itemStyle={TOOLTIP_ITEM}
            cursor={CURSOR}
            formatter={fmtValue}
            labelFormatter={labelFormatter}
          />
          <Line
            type="linear"
            dataKey="judgeAvg"
            name="Judge avg"
            stroke="var(--series-1)"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            dot={DOT_1}
            activeDot={ACTIVE_DOT}
            connectNulls
            isAnimationActive={false}
          />
          <Line
            type="linear"
            dataKey="auto"
            name="Auto"
            stroke="var(--series-2)"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            dot={DOT_2}
            activeDot={ACTIVE_DOT}
            connectNulls
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Shared legend for a grid of HistoryChart multiples (text in text tokens, swatch carries identity). */
export function HistoryLegend() {
  return (
    <div className="flex items-center gap-4 text-xs text-muted">
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-0.5 w-4 rounded" style={{ background: 'var(--series-1)' }} /> Judge avg
      </span>
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-0.5 w-4 rounded" style={{ background: 'var(--series-2)' }} /> Auto (checks)
      </span>
    </div>
  );
}

// ---------- comparing two models (A = --series-1, B = --series-2) ----------

const RADAR_MARGIN = { top: 12, right: 32, bottom: 12, left: 32 };
const RADAR_DOT_A = { r: 4, fill: 'var(--series-1)', stroke: 'var(--panel)', strokeWidth: 2 };
const RADAR_DOT_B = { r: 4, fill: 'var(--series-2)', stroke: 'var(--panel)', strokeWidth: 2 };
const BAR_MARGIN = { top: 4, right: 16, bottom: 4, left: 8 };
const BAR_RADIUS: [number, number, number, number] = [0, 4, 4, 0];
const COMPARE_MARGIN = { top: 8, right: 12, bottom: 0, left: 0 };
const COMPARE_DOT: [number, number] = [50, 50];
const LINE_A = { stroke: 'var(--series-1)', strokeWidth: 2 };
const LINE_B = { stroke: 'var(--series-2)', strokeWidth: 2 };
const DAY_MS = 86_400_000;
/** Day ticks for long spans; day + time when runs are close together (else the same day repeats on every tick). */
const timeTick = (spanMs: number) => (t: number) =>
  spanMs > 3 * DAY_MS
    ? new Date(t).toLocaleDateString(undefined, { day: '2-digit', month: 'short' })
    : new Date(t).toLocaleString(undefined, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

export interface CompareAxis {
  axis: string;
  /** null = no score for that model on this axis */
  a: number | null;
  b: number | null;
}

/** Legend: the swatch carries identity, names stay in text ink. */
export function CompareLegend({ a, b }: { a: string; b: string }) {
  return (
    <div className="flex flex-wrap items-center gap-4 text-xs text-muted">
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: 'var(--series-1)' }} /> {a}
      </span>
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: 'var(--series-2)' }} /> {b}
      </span>
    </div>
  );
}

type TipProps = { active?: boolean; payload?: readonly { name?: unknown; value?: unknown; payload?: unknown }[]; label?: unknown };

function CompareTip({ active, payload, label }: TipProps) {
  if (!active || !payload?.length) return null;
  return (
    <div style={TOOLTIP_CONTENT} className="px-2.5 py-1.5">
      <div className="font-medium">{String(label ?? '')}</div>
      {payload.map((p, i) => (
        <div key={i} className="text-muted">
          {String(p.name)} <span className="text-fg tabular">{typeof p.value === 'number' ? p.value.toFixed(1) : '–'}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * Two models on the same 0–10 axes. A polar (radar) chart needs at least three axes to have a shape; with fewer,
 * the same values are drawn as grouped horizontal bars.
 */
export function CompareRadar({ axes, a, b }: { axes: CompareAxis[]; a: string; b: string }) {
  const tip = useCallback((p: TipProps) => <CompareTip {...p} />, []);
  if (!axes.length) return <p className="text-xs text-muted">No scores to compare yet.</p>;
  if (axes.length < 3)
    return (
      <div className="w-full" style={{ height: 40 + axes.length * 56 }}>
        <ResponsiveContainer>
          <BarChart data={axes} layout="vertical" margin={BAR_MARGIN} barGap={2} barCategoryGap={14}>
            <CartesianGrid stroke="var(--grid)" strokeWidth={1} horizontal={false} />
            <XAxis type="number" domain={SCORE_DOMAIN} ticks={SCORE_TICKS_FULL} tick={AXIS_TICK} stroke="var(--axis)" tickLine={false} />
            <YAxis type="category" dataKey="axis" tick={AXIS_TICK} stroke="var(--axis)" tickLine={false} width={120} />
            <Tooltip cursor={false} content={tip} />
            <Bar dataKey="a" name={a} fill="var(--series-1)" radius={BAR_RADIUS} isAnimationActive={false} />
            <Bar dataKey="b" name={b} fill="var(--series-2)" radius={BAR_RADIUS} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    );
  return (
    <div className="h-80 w-full">
      <ResponsiveContainer>
        <RadarChart data={axes} margin={RADAR_MARGIN} outerRadius="72%">
          <PolarGrid stroke="var(--grid)" />
          <PolarAngleAxis dataKey="axis" tick={AXIS_TICK} />
          {/* the 0–10 scale runs between the first two spokes, so it never covers an axis label */}
          <PolarRadiusAxis domain={SCORE_DOMAIN} tickCount={6} tick={AXIS_TICK} axisLine={false} angle={90 - 180 / axes.length} />
          <Tooltip content={tip} />
          <Radar
            dataKey="a"
            name={a}
            stroke="var(--series-1)"
            strokeWidth={2}
            fill="var(--series-1)"
            fillOpacity={0.15}
            dot={RADAR_DOT_A}
            isAnimationActive={false}
          />
          <Radar
            dataKey="b"
            name={b}
            stroke="var(--series-2)"
            strokeWidth={2}
            fill="var(--series-2)"
            fillOpacity={0.15}
            dot={RADAR_DOT_B}
            isAnimationActive={false}
          />
        </RadarChart>
      </ResponsiveContainer>
    </div>
  );
}

export interface SpeedAxis {
  axis: string;
  /** tokens/s; null = not measured for that model on this test */
  aTok: number | null;
  bTok: number | null;
  /** average execution time of one case, ms */
  aMs: number | null;
  bMs: number | null;
}

type SpeedRow = { axis: string; a: number; b: number };
const fmtTok = (v: number) => `${v.toFixed(1)} tok/s`;
/** seconds, from milliseconds to hours: 0.85 s · 12.3 s · 4m 05s */
const fmtSec = (s: number) => {
  if (s < 60) return `${s < 10 ? s.toFixed(2) : s.toFixed(1)} s`;
  const r = Math.round(s);
  return r < 3600
    ? `${Math.floor(r / 60)}m ${String(r % 60).padStart(2, '0')}s`
    : `${Math.floor(r / 3600)}h ${String(Math.floor((r % 3600) / 60)).padStart(2, '0')}m`;
};
const SPEED_X_DOMAIN: [number, (max: number) => number] = [0, niceMax];

function SpeedTip({ active, payload, label, fmt }: TipProps & { fmt: (v: number) => string }) {
  if (!active || !payload?.length) return null;
  return (
    <div style={TOOLTIP_CONTENT} className="px-2.5 py-1.5">
      <div className="font-medium">{String(label ?? '')}</div>
      {payload.map((p, i) => (
        <div key={i} className="text-muted">
          {String(p.name)} <span className="text-fg tabular">{typeof p.value === 'number' ? fmt(p.value) : '–'}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * Every other row (test) of a per-test chart, faintly shaded, so the two models' marks of one test read as a pair
 * even when they sit far apart. The grid's horizontal lines go on the row boundaries (not the row centres, where a
 * category axis puts them), and its stripes fill between them: transparent, shaded, transparent…
 */
const ROW_STRIPES = ['transparent', 'var(--fg)'];
const ROW_STRIPE_OPACITY = 0.045;
function useRowBoundaries(rows: number) {
  return useCallback(
    ({ offset }: { offset: { top?: number; height?: number } }) =>
      Array.from({ length: rows + 1 }, (_, i) => Math.round((offset.top ?? 0) + ((offset.height ?? 0) * i) / rows)),
    [rows],
  );
}

/** One measure, both models, one horizontal bar pair per test (bars start at zero: lengths compare). */
function SpeedBars({ rows, a, b, fmt }: { rows: SpeedRow[]; a: string; b: string; fmt: (v: number) => string }) {
  const tip = useCallback((p: TipProps) => <SpeedTip {...p} fmt={fmt} />, [fmt]);
  const boundaries = useRowBoundaries(rows.length);
  return (
    <div className="w-full" style={{ height: 40 + rows.length * 44 }}>
      <ResponsiveContainer>
        <BarChart data={rows} layout="vertical" margin={BAR_MARGIN} barGap={2} barCategoryGap={10}>
          <CartesianGrid
            stroke="var(--grid)"
            strokeWidth={1}
            horizontalCoordinatesGenerator={boundaries}
            horizontalFill={ROW_STRIPES}
            fillOpacity={ROW_STRIPE_OPACITY}
          />
          <XAxis type="number" domain={SPEED_X_DOMAIN} tick={AXIS_TICK} stroke="var(--axis)" tickLine={false} />
          <YAxis type="category" dataKey="axis" tick={AXIS_TICK} stroke="var(--axis)" tickLine={false} width={120} />
          <Tooltip cursor={false} content={tip} />
          <Bar dataKey="a" name={a} fill="var(--series-1)" radius={BAR_RADIUS} isAnimationActive={false} />
          <Bar dataKey="b" name={b} fill="var(--series-2)" radius={BAR_RADIUS} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Ticks the log time axis may use, in seconds (10 ms … 1 h); the ones spanning the data are shown. */
const LOG_TICKS = [0.01, 0.1, 1, 10, 60, 600, 3600];
const logTick = (s: number) => (s >= 3600 ? `${s / 3600}h` : s >= 60 ? `${s / 60}m` : `${s}s`);

type ShapeProps = { x?: number; y?: number; width?: number; height?: number };
/** A dot at the value end of a bar: on a log axis a bar's length means nothing, its end position does. */
const dotAt = (fill: string) =>
  function SpeedDot({ x = 0, y = 0, width = 0, height = 0 }: ShapeProps) {
    return <circle cx={x + width} cy={y + height / 2} r={5} fill={fill} stroke="var(--panel)" strokeWidth={2} />;
  };
const DOT_SHAPE_A = dotAt('var(--series-1)');
const DOT_SHAPE_B = dotAt('var(--series-2)');

/**
 * Seconds per test for both models as a dot plot on a log axis: case times span milliseconds (embeddings) to minutes
 * (Terminal-Bench), which a linear axis squeezes to nothing. Dots, not bars: a bar on a log axis starts at an
 * arbitrary minimum, so its length would mislead.
 */
function SpeedDots({ rows, a, b }: { rows: SpeedRow[]; a: string; b: string }) {
  const tip = useCallback((p: TipProps) => <SpeedTip {...p} fmt={fmtSec} />, []);
  const { domain, ticks } = useMemo(() => {
    const vals = rows.flatMap((r) => [r.a, r.b]);
    const [min, max] = [Math.min(...vals), Math.max(...vals)];
    const lo = [...LOG_TICKS].reverse().find((t) => t <= min) ?? min;
    const hi = LOG_TICKS.find((t) => t >= max) ?? max;
    return { domain: [lo, hi] as [number, number], ticks: LOG_TICKS.filter((t) => t >= lo && t <= hi) };
  }, [rows]);
  const boundaries = useRowBoundaries(rows.length);
  return (
    <div className="w-full" style={{ height: 40 + rows.length * 44 }}>
      <ResponsiveContainer>
        <BarChart data={rows} layout="vertical" margin={BAR_MARGIN} barGap={2} barCategoryGap={10}>
          <CartesianGrid
            stroke="var(--grid)"
            strokeWidth={1}
            horizontalCoordinatesGenerator={boundaries}
            horizontalFill={ROW_STRIPES}
            fillOpacity={ROW_STRIPE_OPACITY}
          />
          <XAxis
            type="number"
            scale="log"
            domain={domain}
            ticks={ticks}
            tickFormatter={logTick}
            allowDataOverflow
            tick={AXIS_TICK}
            stroke="var(--axis)"
            tickLine={false}
          />
          <YAxis type="category" dataKey="axis" tick={AXIS_TICK} stroke="var(--axis)" tickLine={false} width={120} />
          <Tooltip cursor={false} content={tip} />
          <Bar dataKey="a" name={a} fill="var(--series-1)" shape={DOT_SHAPE_A} isAnimationActive={false} />
          <Bar dataKey="b" name={b} fill="var(--series-2)" shape={DOT_SHAPE_B} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/**
 * Speed of two models per test, as two charts with their own axes (never one chart with two scales): generation
 * throughput (higher is faster, bars on a linear axis) and the average time of one case (lower is faster, dots on a
 * log axis). A test is drawn where both models have the measure.
 */
export function CompareSpeed({ axes, a, b }: { axes: SpeedAxis[]; a: string; b: string }) {
  const tok = useMemo(
    () => axes.filter((x) => x.aTok != null && x.bTok != null).map((x) => ({ axis: x.axis, a: x.aTok!, b: x.bTok! })),
    [axes],
  );
  const time = useMemo(
    // a log axis has no zero: a time of 0 (an estimate floored at zero) can't be placed
    () => axes.filter((x) => !!x.aMs && !!x.bMs).map((x) => ({ axis: x.axis, a: x.aMs! / 1000, b: x.bMs! / 1000 })),
    [axes],
  );
  return (
    <div className="grid gap-6 md:grid-cols-2">
      <div>
        <h3 className="mb-1 text-sm font-medium">
          Tokens/s <span className="font-normal text-muted">· higher is faster</span>
        </h3>
        {tok.length ? <SpeedBars rows={tok} a={a} b={b} fmt={fmtTok} /> : <p className="text-xs text-muted">No tokens/s to compare.</p>}
      </div>
      <div>
        <h3 className="mb-1 text-sm font-medium">
          Avg case execution time <span className="font-normal text-muted">· lower is faster · log scale</span>
        </h3>
        {time.length ? <SpeedDots rows={time} a={a} b={b} /> : <p className="text-xs text-muted">No execution times to compare.</p>}
      </div>
    </div>
  );
}

export interface ComparePointView {
  t: number;
  score: number | null;
  digest: string;
}

function HistoryTip({ active, payload }: TipProps) {
  const p = payload?.[0]?.payload as (ComparePointView & { model: string }) | undefined;
  if (!active || !p) return null;
  return (
    <div style={TOOLTIP_CONTENT} className="px-2.5 py-1.5">
      <div className="font-medium">{p.model}</div>
      <div className="text-muted">
        {new Date(p.t).toLocaleString()} · score <span className="text-fg tabular">{p.score?.toFixed(1) ?? '–'}</span> · digest {p.digest}
      </div>
    </div>
  );
}

/** Both models' scores over time on one test (score = judge average, or the automatic score when not judged). */
export function CompareHistoryChart({
  a,
  b,
  aName,
  bName,
}: {
  a: ComparePointView[];
  b: ComparePointView[];
  aName: string;
  bName: string;
}) {
  const [da, db, domain] = useMemo(() => {
    const keep = (xs: ComparePointView[], model: string) => xs.filter((x) => x.score != null).map((x) => ({ ...x, model }));
    const pa = keep(a, aName);
    const pb = keep(b, bName);
    const ts = [...pa, ...pb].map((x) => x.t);
    const lo = Math.min(...ts);
    const hi = Math.max(...ts);
    const pad = Math.max((hi - lo) * 0.05, 6 * 3600_000); // a single day still gets some width
    return [pa, pb, [lo - pad, hi + pad] as [number, number]];
  }, [a, b, aName, bName]);
  const tickFormatter = useMemo(() => timeTick(domain[1] - domain[0]), [domain]);
  const tip = useCallback((p: TipProps) => <HistoryTip {...p} />, []);
  if (!da.length && !db.length) return <p className="py-6 text-center text-xs text-muted">No scores.</p>;
  return (
    <div className="h-44 w-full">
      <ResponsiveContainer>
        <ScatterChart margin={COMPARE_MARGIN}>
          <CartesianGrid stroke="var(--grid)" strokeWidth={1} vertical={false} />
          <XAxis
            type="number"
            dataKey="t"
            domain={domain}
            tickFormatter={tickFormatter}
            tick={AXIS_TICK}
            stroke="var(--axis)"
            tickLine={false}
            tickCount={3}
          />
          <YAxis
            type="number"
            dataKey="score"
            domain={SCORE_DOMAIN}
            ticks={SCORE_TICKS_SMALL}
            tick={AXIS_TICK}
            stroke="var(--axis)"
            tickLine={false}
            width={28}
          />
          <ZAxis range={COMPARE_DOT} />
          <Tooltip cursor={CURSOR} content={tip} />
          <Scatter
            name={aName}
            data={da}
            fill="var(--series-1)"
            stroke="var(--panel)"
            strokeWidth={2}
            line={LINE_A}
            isAnimationActive={false}
          />
          <Scatter
            name={bName}
            data={db}
            fill="var(--series-2)"
            stroke="var(--panel)"
            strokeWidth={2}
            line={LINE_B}
            isAnimationActive={false}
          />
        </ScatterChart>
      </ResponsiveContainer>
    </div>
  );
}
