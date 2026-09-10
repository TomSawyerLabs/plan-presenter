/**
 * <Chart> - uPlot wrapper.
 *
 *   <Chart
 *     title="Latency"
 *     data={[[0,1,2,3],[10,12,9,14],[5,6,7,8]]}     // uPlot columns: x first
 *     series={["p50", "p99"]}                          // or [{label, color, fill}]
 *     type="line" | "bars" | "points"
 *     x="number" | "time"                              // time = unix seconds
 *     xLabel="s" yLabel="ms" height={280}
 *   />
 *
 * `data` may also be a path to a JSON file in the session (`data/latency.json`)
 * containing either the column array or `{ x: [...], series: { name: [...] } }`.
 *
 * MDX re-creates inline `data` / `series` literals on every render, so both are
 * memoised by their serialised form; the plot is only rebuilt when the content
 * actually changes.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { useSessionOptional } from "../../state.tsx";
import { RenderProblem } from "../RenderProblem.tsx";
import { isDarkMode, MAX_SERIES, seriesColor } from "./palette.ts";

export interface ChartSeries {
  label: string;
  color?: string;
  width?: number;
  fill?: boolean;
  dash?: number[];
}

export type ChartColumns = number[][];
export interface ChartObjectData {
  x: number[];
  series: Record<string, number[]>;
}
type ChartData = ChartColumns | ChartObjectData;

export interface ChartProps {
  id?: string;
  title?: string;
  data: ChartData | string;
  series?: Array<string | ChartSeries>;
  type?: "line" | "bars" | "points";
  x?: "number" | "time";
  xLabel?: string;
  yLabel?: string;
  height?: number;
  /** Start the y axis at zero (default true for bars). */
  zero?: boolean;
  [attr: `data-${string}`]: string | undefined;
}

function normalise(
  data: ChartData,
  labels?: string[],
): { columns: ChartColumns; labels: string[] } {
  if (Array.isArray(data)) {
    const n = Math.max(0, data.length - 1);
    return {
      columns: data,
      labels: labels ?? Array.from({ length: n }, (_, i) => `Series ${i + 1}`),
    };
  }
  const names = Object.keys(data.series);
  return { columns: [data.x, ...names.map((k) => data.series[k] ?? [])], labels: labels ?? names };
}

export function Chart(props: ChartProps) {
  const {
    id,
    title,
    data,
    series,
    type = "line",
    x = "number",
    xLabel,
    yLabel,
    height = 280,
    zero,
  } = props;
  const session = useSessionOptional();
  const transport = session?.transport;
  const sessionId = session?.session?.id;
  const assetVersion = session?.assetVersion ?? 0;
  const plotRef = useRef<HTMLDivElement>(null);
  const [remote, setRemote] = useState<ChartData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [plotError, setPlotError] = useState<string | null>(null);
  const [dark, setDark] = useState(isDarkMode);
  const [showTable, setShowTable] = useState(false);

  const isPath = typeof data === "string";
  const dataKey = isPath ? data : JSON.stringify(data);
  const seriesKey = JSON.stringify(series ?? null);

  const inlineData = useMemo(
    () => (isPath ? null : (JSON.parse(dataKey) as ChartData)),
    [isPath, dataKey],
  );
  const seriesSpecs = useMemo(
    () => JSON.parse(seriesKey) as Array<string | ChartSeries> | null,
    [seriesKey],
  );

  // Load JSON data from the session when `data` is a path.
  useEffect(() => {
    if (!isPath || !transport || !sessionId) return;
    let cancelled = false;
    fetch(`${transport.fileUrl(sessionId, dataKey)}?v=${assetVersion}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status} loading ${dataKey}`))))
      .then((json) => {
        if (!cancelled) {
          setRemote(json as ChartData);
          setLoadError(null);
        }
      })
      .catch((e) => !cancelled && setLoadError(String((e as Error).message ?? e)));
    return () => {
      cancelled = true;
    };
  }, [isPath, dataKey, transport, sessionId, assetVersion]);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setDark(isDarkMode());
    mq.addEventListener("change", onChange);
    const obs = new MutationObserver(onChange);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => {
      mq.removeEventListener("change", onChange);
      obs.disconnect();
    };
  }, []);

  const resolved = isPath ? remote : inlineData;
  const prepared = useMemo(() => {
    if (!resolved) return null;
    const labels = seriesSpecs?.map((s) => (typeof s === "string" ? s : s.label));
    return normalise(resolved, labels);
  }, [resolved, seriesSpecs]);

  const contextError = isPath && !transport ? "Chart data paths need a session context" : null;
  const tooManyError =
    prepared && prepared.labels.length > MAX_SERIES
      ? `Too many series (${prepared.labels.length}); the palette supports ${MAX_SERIES}. Split into several charts.`
      : null;
  const canPlot = prepared !== null && tooManyError === null;

  useEffect(() => {
    const el = plotRef.current;
    if (!el || !prepared || !canPlot) return;
    const { columns, labels } = prepared;
    const ink =
      getComputedStyle(el).getPropertyValue("--pp-text-secondary").trim() ||
      (dark ? "#c3c2b7" : "#52514e");
    const grid = dark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.08)";

    const uSeries: uPlot.Series[] = [
      { label: xLabel ?? (x === "time" ? "time" : "x") },
      ...labels.map((label, i) => {
        const spec = seriesSpecs?.[i];
        const s: ChartSeries = typeof spec === "object" && spec !== null ? spec : { label };
        const color = s.color ?? seriesColor(i, dark);
        const base: uPlot.Series = {
          label,
          stroke: color,
          width: s.width ?? 2,
          dash: s.dash,
          fill: s.fill ? color + "33" : undefined,
          points: { show: type === "points", size: 8 },
        };
        if (type === "bars") {
          base.paths = uPlot.paths.bars!({ size: [0.6, 40], radius: 0.15, align: 0 });
          base.fill = color;
          base.stroke = "transparent";
          base.width = 0;
        } else if (type === "points") {
          base.paths = () => null;
        }
        return base;
      }),
    ];

    const opts: uPlot.Options = {
      title,
      width: el.clientWidth || 600,
      height,
      series: uSeries,
      cursor: { show: true, points: { size: 8 } },
      legend: { show: true, live: true },
      scales: {
        x: { time: x === "time" },
        y: {
          range:
            (zero ?? type === "bars")
              ? (_u, _min, max) => [0, max <= 0 ? 1 : max * 1.05]
              : undefined,
        },
      },
      axes: [
        {
          stroke: ink,
          grid: { stroke: grid, width: 1 },
          ticks: { stroke: grid, width: 1 },
          label: xLabel,
        },
        {
          stroke: ink,
          grid: { stroke: grid, width: 1 },
          ticks: { stroke: grid, width: 1 },
          label: yLabel,
        },
      ],
    };

    let plot: uPlot;
    try {
      plot = new uPlot(opts, columns as uPlot.AlignedData, el);
    } catch (e) {
      queueMicrotask(() => setPlotError(String((e as Error).message ?? e)));
      return;
    }
    queueMicrotask(() => setPlotError(null));
    const ro = new ResizeObserver(() => {
      if (el.clientWidth) plot.setSize({ width: el.clientWidth, height });
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      plot.destroy();
    };
  }, [prepared, canPlot, seriesSpecs, type, x, xLabel, yLabel, height, zero, title, dark]);

  const error = contextError ?? tooManyError ?? loadError ?? plotError;
  const dataAttrs = Object.fromEntries(
    Object.entries(props).filter(([k]) => k.startsWith("data-")),
  );

  return (
    <figure className="pp-chart" data-pp-target={id} {...dataAttrs}>
      {error && (
        <RenderProblem
          what="chart"
          source="chart"
          message={error}
          detail={isPath ? `data: ${dataKey}` : null}
          blockId={props["data-pp-block"] ?? null}
          targetId={id ?? null}
        />
      )}
      <div ref={plotRef} className="pp-chart-plot" />
      {prepared && (
        <div className="pp-chart-tools" data-pp-interactive="">
          <button type="button" className="pp-link-button" onClick={() => setShowTable((s) => !s)}>
            {showTable ? "Hide table" : "Show as table"}
          </button>
        </div>
      )}
      {showTable && prepared && (
        <ChartTable
          columns={prepared.columns}
          labels={prepared.labels}
          xLabel={xLabel ?? "x"}
          time={x === "time"}
        />
      )}
    </figure>
  );
}

function ChartTable({
  columns,
  labels,
  xLabel,
  time,
}: {
  columns: ChartColumns;
  labels: string[];
  xLabel: string;
  time: boolean;
}) {
  const xs = columns[0] ?? [];
  return (
    <table className="pp-chart-table">
      <thead>
        <tr>
          <th>{xLabel}</th>
          {labels.map((l) => (
            <th key={l}>{l}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {xs.map((xv, i) => (
          <tr key={i}>
            <td>{time ? new Date(xv * 1000).toLocaleString() : xv}</td>
            {labels.map((_, s) => (
              <td key={s}>{columns[s + 1]?.[i] ?? ""}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
