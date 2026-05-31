"use client";

import React, { useState, useEffect, useMemo } from "react";
import { BarChart, Bar, XAxis, ResponsiveContainer, Tooltip, Cell } from "recharts";
import { supabase } from "../lib/supabase";

/* ============================================================================
   GRC — OPERATIONS DASHBOARD · SCREEN 1
   ----------------------------------------------------------------------------
   Каркас первого экрана. Все 9 виджетов из spec'а. Данные приходят из Supabase
   через dash_*-RPC (SECURITY DEFINER, см. 0006_dashboard_rpc.sql). Сырые таблицы
   под RLS закрыты — фронт читает только агрегаты. Дизайн/вёрстка не менялись.
   ============================================================================ */

/* ---- THEME ---------------------------------------------------------------- */
const c = {
  bg: "#0a0c10",
  panel: "#11151b",
  panelHi: "#161b22",
  border: "#222a35",
  borderHi: "#2d3744",
  text: "#e6e9ee",
  muted: "#8a93a0",
  faint: "#5b6470",
  green: "#3fb950",
  amber: "#d29922",
  red: "#f85149",
  accent: "#e8b14b",
};
type Level = "ok" | "warn" | "crit";
const STATUS: Record<Level, string> = { ok: c.green, warn: c.amber, crit: c.red };
// Geist подключается пакетом `geist` через next/font в app/layout.tsx; здесь
// используем сгенерированные CSS-переменные, без внешнего <link>.
const mono = "var(--font-geist-mono), ui-monospace, monospace";
const sans = "var(--font-geist-sans), ui-sans-serif, system-ui, sans-serif";

/* ---- TYPES ---------------------------------------------------------------- */
interface HealthRow { service: string; ok: boolean; latency_ms: number | null; stale: boolean }
interface ReconRow { kind: string; open_count: number }
interface DeadRow { type: string; dead_count: number }
interface FunnelRow { status: string; cnt: number }
interface Ttft { median_minutes: number; touched_today: number }
interface QueueRow { type: string; pending: number; retrying: number; in_flight: number }
interface ErrorRateRow { service: string; runs: number; error_pct: number }
interface HourRow { hour: string; leads: number }
interface ErrorFeedRow { t: string; service: string; type: string; lead: string; attempts: number; error: string }

interface DashboardData {
  health: HealthRow[];
  recon: ReconRow[];
  dead: DeadRow[];
  funnel: FunnelRow[];
  ttft: Ttft;
  queue: QueueRow[];
  errorRate: ErrorRateRow[];
  leadsByHour: HourRow[];
  errorsFeed: ErrorFeedRow[];
}

const EMPTY: DashboardData = {
  health: [],
  recon: [],
  dead: [],
  funnel: [],
  ttft: { median_minutes: 0, touched_today: 0 },
  queue: [],
  errorRate: [],
  leadsByHour: [],
  errorsFeed: [],
};

/* ---- DATA LAYER ===========================================================
   Каждый виджет = одна dash_*-функция, дёргаем через supabase.rpc(). Шейпы
   ответов ровно те, что возвращает SQL из grc-dashboard-screen-1.md. Рендер
   прогрессивный: каждая RPC, отрезолвившись, наполняет свой срез состояния.
   ========================================================================== */
type Row = Record<string, unknown>;
const num = (v: unknown): number => Number(v ?? 0);

function formatHour(iso: unknown): string {
  const d = new Date(String(iso));
  if (Number.isNaN(d.getTime())) return "--:00";
  return `${String(d.getHours()).padStart(2, "0")}:00`;
}

function relTime(iso: unknown): string {
  const t = new Date(String(iso)).getTime();
  if (Number.isNaN(t)) return "—";
  const min = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (min < 60) return `−${min}m`;
  return `−${Math.round(min / 60)}h`;
}

function mapHealth(rows: Row[]): HealthRow[] {
  return rows.map((r) => ({
    service: String(r.service),
    ok: Boolean(r.ok),
    latency_ms: r.latency_ms == null ? null : num(r.latency_ms),
    stale: Boolean(r.stale),
  }));
}
function mapRecon(rows: Row[]): ReconRow[] {
  return rows.map((r) => ({ kind: String(r.kind), open_count: num(r.open_count) }));
}
function mapDead(rows: Row[]): DeadRow[] {
  return rows.map((r) => ({ type: String(r.type), dead_count: num(r.dead_count) }));
}
function mapFunnel(rows: Row[]): FunnelRow[] {
  return rows.map((r) => ({ status: String(r.status), cnt: num(r.cnt) }));
}
function mapTtft(rows: Row[]): Ttft {
  const r = rows[0];
  return {
    median_minutes: num(r?.median_minutes),
    touched_today: num(r?.touched_today),
  };
}
function mapQueue(rows: Row[]): QueueRow[] {
  return rows.map((r) => ({
    type: String(r.type),
    pending: num(r.pending),
    retrying: num(r.retrying),
    in_flight: num(r.in_flight),
  }));
}
function mapErrorRate(rows: Row[]): ErrorRateRow[] {
  return rows.map((r) => ({
    service: String(r.service),
    runs: num(r.runs),
    error_pct: num(r.error_pct),
  }));
}
function mapHourly(rows: Row[]): HourRow[] {
  return rows.map((r) => ({ hour: formatHour(r.hour), leads: num(r.leads) }));
}
function mapErrorsFeed(rows: Row[]): ErrorFeedRow[] {
  return rows.map((r) => ({
    t: relTime(r.started_at),
    service: r.service ? String(r.service) : "—",
    type: String(r.type),
    lead: r.lead_id ? String(r.lead_id).slice(0, 4) : "—",
    attempts: num(r.attempts),
    error: r.error ? String(r.error) : "",
  }));
}

/* ---- THRESHOLD LOGIC (из spec'а) ------------------------------------------ */
const lvl = {
  health: (rows: HealthRow[]): Level => (rows.some((r) => !r.ok || r.stale) ? "crit" : "ok"),
  recon: (rows: ReconRow[]): Level => {
    const sum = rows.reduce((a, r) => a + r.open_count, 0);
    if (rows.some((r) => r.kind === "orphaned_deal" && r.open_count > 0) || sum > 10) return "crit";
    return sum > 0 ? "warn" : "ok";
  },
  dead: (rows: DeadRow[]): Level => (rows.reduce((a, r) => a + r.dead_count, 0) > 0 ? "warn" : "ok"),
  funnel: (rows: FunnelRow[]): Level => {
    const bad = rows.filter((r) => r.status === "orphaned" || r.status === "dead").reduce((a, r) => a + r.cnt, 0);
    return bad > 0 ? "crit" : "ok";
  },
  ttft: (m: number): Level => (m > 30 ? "crit" : m > 15 ? "warn" : "ok"),
  queue: (p: number): Level => (p > 50 ? "warn" : "ok"),
  errPct: (p: number): Level => (p > 10 ? "crit" : p > 5 ? "warn" : "ok"),
};

/* ---- PRIMITIVES ----------------------------------------------------------- */
function Dot({ level, pulse }: { level: Level; pulse?: boolean }) {
  return (
    <span style={{ position: "relative", display: "inline-block", width: 9, height: 9 }}>
      {pulse && (
        <span style={{ position: "absolute", inset: -3, borderRadius: "50%", background: STATUS[level],
          opacity: 0.35, animation: "grcpulse 1.8s ease-out infinite" }} />
      )}
      <span style={{ position: "absolute", inset: 0, borderRadius: "50%", background: STATUS[level],
        boxShadow: `0 0 8px ${STATUS[level]}` }} />
    </span>
  );
}

function Panel({ title, level, children, span = 1, note }: {
  title: string; level: Level | null; children: React.ReactNode; span?: number; note?: string;
}) {
  return (
    <section style={{
      gridColumn: `span ${span}`, background: c.panel, border: `1px solid ${level === "crit" ? c.red : level === "warn" ? "#3a3320" : c.border}`,
      borderRadius: 10, padding: "14px 16px", display: "flex", flexDirection: "column", gap: 12,
      boxShadow: level === "crit" ? `inset 0 0 0 1px ${c.red}22` : "none",
    }}>
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {level && <Dot level={level} />}
          <h3 style={{ font: `500 11px/1 ${sans}`, letterSpacing: "0.12em", textTransform: "uppercase", color: c.muted, margin: 0 }}>{title}</h3>
        </div>
        {note && <span style={{ font: `400 10px/1 ${mono}`, color: c.faint }}>{note}</span>}
      </header>
      {children}
    </section>
  );
}

const cellLabel: React.CSSProperties = { font: `400 12px/1.4 ${sans}`, color: c.muted };
const cellNum: React.CSSProperties = { font: `500 13px/1 ${mono}`, color: c.text };

/* ---- WIDGETS -------------------------------------------------------------- */
function W1Health({ rows }: { rows: HealthRow[] }) {
  return (
    <Panel title="Здоровье сервисов" level={lvl.health(rows)} note="last ping">
      <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
        {rows.map((r) => {
          const level: Level = !r.ok || r.stale ? "crit" : (r.latency_ms ?? 0) > 700 ? "warn" : "ok";
          return (
            <div key={r.service} style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Dot level={level} />
                <span style={{ ...cellLabel, color: c.text }}>{r.service}</span>
              </span>
              <span style={{ ...cellNum, color: !r.ok || r.stale ? c.red : c.muted }}>
                {!r.ok ? "DOWN" : r.stale ? "STALE" : `${r.latency_ms}ms`}
              </span>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

function W2Recon({ rows }: { rows: ReconRow[] }) {
  const sum = rows.reduce((a, r) => a + r.open_count, 0);
  return (
    <Panel title="Реконсиляция · открыто" level={lvl.recon(rows)}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
        <span style={{ font: `600 38px/1 ${mono}`, color: sum > 0 ? c.amber : c.green }}>{sum}</span>
        <span style={cellLabel}>незакрытых</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {rows.map((r) => (
          <div key={r.kind} style={{ display: "flex", justifyContent: "space-between" }}>
            <span style={cellLabel}>{r.kind}</span>
            <span style={cellNum}>{r.open_count}</span>
          </div>
        ))}
      </div>
    </Panel>
  );
}

function W3Dead({ rows }: { rows: DeadRow[] }) {
  const sum = rows.reduce((a, r) => a + r.dead_count, 0);
  return (
    <Panel title="Dead jobs" level={lvl.dead(rows)}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
        <span style={{ font: `600 38px/1 ${mono}`, color: sum > 0 ? c.amber : c.green }}>{sum}</span>
        <span style={cellLabel}>в dead-letter</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {rows.length ? rows.map((r) => (
          <div key={r.type} style={{ display: "flex", justifyContent: "space-between" }}>
            <span style={cellLabel}>{r.type}</span>
            <span style={cellNum}>{r.dead_count}</span>
          </div>
        )) : <span style={{ ...cellLabel, color: c.faint }}>чисто</span>}
      </div>
    </Panel>
  );
}

const FUNNEL_ORDER = ["new", "enriched", "synced", "contacted", "orphaned", "dead"];
function W4Funnel({ rows }: { rows: FunnelRow[] }) {
  const map = Object.fromEntries(rows.map((r) => [r.status, r.cnt]));
  const max = Math.max(...rows.map((r) => r.cnt), 1);
  const colorFor = (s: string) => (s === "orphaned" || s === "dead" ? c.red : s === "contacted" ? c.green : c.accent);
  return (
    <Panel title="Воронка лидов · сегодня" level={lvl.funnel(rows)} span={2}>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {FUNNEL_ORDER.map((s) => {
          const v = map[s] ?? 0;
          return (
            <div key={s} style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <span style={{ ...cellLabel, width: 88, textAlign: "right", color: s === "contacted" ? c.green : c.muted }}>{s}</span>
              <div style={{ flex: 1, height: 18, background: "#0d1117", borderRadius: 4, overflow: "hidden" }}>
                <div style={{ width: `${(v / max) * 100}%`, height: "100%", background: colorFor(s),
                  opacity: v === 0 ? 0.15 : 0.85, borderRadius: 4, transition: "width .5s ease" }} />
              </div>
              <span style={{ ...cellNum, width: 34, textAlign: "right" }}>{v}</span>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

function W5Ttft({ data }: { data: Ttft }) {
  const level = lvl.ttft(data.median_minutes);
  return (
    <Panel title="Time-to-first-touch · медиана" level={level} note="SLA < 15м">
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span style={{ font: `600 46px/1 ${mono}`, color: STATUS[level] }}>{data.median_minutes}</span>
        <span style={cellLabel}>мин</span>
      </div>
      <span style={{ ...cellLabel, color: c.faint }}>{data.touched_today} лидов с касанием сегодня</span>
    </Panel>
  );
}

function W6Queue({ rows }: { rows: QueueRow[] }) {
  const worst = Math.max(...rows.map((r) => r.pending), 0);
  return (
    <Panel title="Глубина очереди" level={lvl.queue(worst)} span={1}>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            {["type", "pend", "retry", "fly"].map((h, i) => (
              <th key={h} style={{ font: `400 10px/1 ${mono}`, color: c.faint, textAlign: i ? "right" : "left",
                textTransform: "uppercase", letterSpacing: "0.08em", paddingBottom: 8 }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.type}>
              <td style={{ ...cellLabel, padding: "5px 0" }}>{r.type}</td>
              <td style={{ ...cellNum, textAlign: "right", color: r.pending > 50 ? c.amber : c.text }}>{r.pending}</td>
              <td style={{ ...cellNum, textAlign: "right", color: c.muted }}>{r.retrying}</td>
              <td style={{ ...cellNum, textAlign: "right", color: c.faint }}>{r.in_flight}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}

function W7ErrorRate({ rows }: { rows: ErrorRateRow[] }) {
  const worst = Math.max(...rows.map((r) => r.error_pct), 0);
  return (
    <Panel title="Error rate · за час" level={lvl.errPct(worst)} span={1}>
      <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
        {rows.map((r) => {
          const level = lvl.errPct(r.error_pct);
          return (
            <div key={r.service} style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ ...cellLabel, width: 78 }}>{r.service}</span>
              <div style={{ flex: 1, height: 6, background: "#0d1117", borderRadius: 3, overflow: "hidden" }}>
                <div style={{ width: `${Math.min(r.error_pct * 5, 100)}%`, height: "100%", background: STATUS[level], borderRadius: 3 }} />
              </div>
              <span style={{ ...cellNum, width: 44, textAlign: "right", color: STATUS[level] }}>{r.error_pct}%</span>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

function W8Hourly({ rows }: { rows: HourRow[] }) {
  return (
    <Panel title="Лиды по часам · 24ч" level={null} span={2}>
      <div style={{ height: 140, marginLeft: -8 }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} barCategoryGap={2}>
            <XAxis dataKey="hour" tick={{ fontFamily: mono, fontSize: 9, fill: c.faint }}
              interval={3} axisLine={{ stroke: c.border }} tickLine={false} />
            <Tooltip cursor={{ fill: "#ffffff08" }}
              contentStyle={{ background: c.panelHi, border: `1px solid ${c.borderHi}`, borderRadius: 6, fontFamily: mono, fontSize: 11 }}
              labelStyle={{ color: c.muted }} itemStyle={{ color: c.text }} />
            <Bar dataKey="leads" radius={[2, 2, 0, 0]}>
              {rows.map((r, i) => <Cell key={i} fill={r.leads === 0 ? c.red : c.accent} fillOpacity={r.leads === 0 ? 0.5 : 0.75} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </Panel>
  );
}

function W9Errors({ rows }: { rows: ErrorFeedRow[] }) {
  return (
    <Panel title="Последние ошибки" level={null} span={4} note="клик → drill-down по job">
      <div style={{ display: "flex", flexDirection: "column" }}>
        {rows.map((r, i) => (
          <div key={i} style={{ display: "grid", gridTemplateColumns: "52px 110px 150px 70px 50px 1fr",
            alignItems: "center", gap: 10, padding: "7px 0", borderTop: i ? `1px solid ${c.border}` : "none", cursor: "pointer" }}>
            <span style={{ font: `400 11px/1 ${mono}`, color: c.faint }}>{r.t}</span>
            <span style={{ display: "flex", alignItems: "center", gap: 7 }}>
              <Dot level="crit" /><span style={{ ...cellLabel, color: c.text }}>{r.service}</span>
            </span>
            <span style={{ font: `400 11px/1 ${mono}`, color: c.muted }}>{r.type}</span>
            <span style={{ font: `400 11px/1 ${mono}`, color: c.faint }}>lead {r.lead}</span>
            <span style={{ font: `400 11px/1 ${mono}`, color: r.attempts >= 4 ? c.red : c.amber }}>×{r.attempts}</span>
            <span style={{ font: `400 11px/1 ${mono}`, color: c.red, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.error}</span>
          </div>
        ))}
      </div>
    </Panel>
  );
}

/* ---- SHELL ---------------------------------------------------------------- */
export default function GRCDashboard() {
  const [data, setData] = useState<DashboardData>(EMPTY);
  const [updated, setUpdated] = useState(new Date());
  const [clock, setClock] = useState(new Date());

  useEffect(() => {
    let active = true;
    const set = (patch: Partial<DashboardData>) => {
      if (active) setData((prev) => ({ ...prev, ...patch }));
    };

    // Прогрессивный рендер: каждая RPC наполняет свой срез по мере готовности.
    const load = async () => {
      const calls: PromiseLike<unknown>[] = [
        supabase.rpc("dash_health").then(({ data: d }) => set({ health: mapHealth((d ?? []) as Row[]) })),
        supabase.rpc("dash_recon").then(({ data: d }) => set({ recon: mapRecon((d ?? []) as Row[]) })),
        supabase.rpc("dash_dead").then(({ data: d }) => set({ dead: mapDead((d ?? []) as Row[]) })),
        supabase.rpc("dash_funnel").then(({ data: d }) => set({ funnel: mapFunnel((d ?? []) as Row[]) })),
        supabase.rpc("dash_ttft").then(({ data: d }) => set({ ttft: mapTtft((d ?? []) as Row[]) })),
        supabase.rpc("dash_queue").then(({ data: d }) => set({ queue: mapQueue((d ?? []) as Row[]) })),
        supabase.rpc("dash_error_rate").then(({ data: d }) => set({ errorRate: mapErrorRate((d ?? []) as Row[]) })),
        supabase.rpc("dash_leads_hourly").then(({ data: d }) => set({ leadsByHour: mapHourly((d ?? []) as Row[]) })),
        supabase.rpc("dash_errors_feed").then(({ data: d }) => set({ errorsFeed: mapErrorsFeed((d ?? []) as Row[]) })),
      ];
      await Promise.allSettled(calls);
      if (active) setUpdated(new Date());
    };

    load();
    const tick = setInterval(() => setClock(new Date()), 1000);
    const refresh = setInterval(load, 30000);
    return () => { active = false; clearInterval(tick); clearInterval(refresh); };
  }, []);

  const systemLevel = useMemo<Level>(() => {
    const levels: Level[] = [
      lvl.health(data.health), lvl.recon(data.recon), lvl.funnel(data.funnel),
      lvl.ttft(data.ttft.median_minutes), lvl.errPct(Math.max(...data.errorRate.map((r) => r.error_pct), 0)),
    ];
    if (levels.includes("crit")) return "crit";
    if (levels.includes("warn")) return "warn";
    return "ok";
  }, [data]);

  const fmt = (d: Date) => d.toLocaleTimeString("ru-RU", { hour12: false });

  return (
    <div style={{ minHeight: "100vh", background: c.bg, color: c.text, fontFamily: sans,
      backgroundImage: `radial-gradient(${c.border}55 1px, transparent 1px)`, backgroundSize: "32px 32px", padding: 22 }}>
      <style>{`@keyframes grcpulse{0%{transform:scale(1);opacity:.4}100%{transform:scale(2.4);opacity:0}}
        *{box-sizing:border-box} table{font-variant-numeric:tabular-nums}`}</style>

      {/* top bar */}
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20,
        paddingBottom: 16, borderBottom: `1px solid ${c.border}` }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ width: 30, height: 30, borderRadius: 7, background: c.accent, display: "grid", placeItems: "center",
            font: `700 14px/1 ${mono}`, color: "#1a1407" }}>G</div>
          <div>
            <div style={{ font: `600 15px/1 ${sans}`, letterSpacing: "0.04em" }}>GRC · OPERATIONS</div>
            <div style={{ font: `400 11px/1.4 ${mono}`, color: c.faint, marginTop: 3 }}>reliability layer · screen 1</div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 22 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "7px 13px", borderRadius: 7,
            background: c.panel, border: `1px solid ${systemLevel === "crit" ? c.red : systemLevel === "warn" ? "#3a3320" : c.border}` }}>
            <Dot level={systemLevel} pulse />
            <span style={{ font: `500 11px/1 ${sans}`, letterSpacing: "0.1em", textTransform: "uppercase",
              color: STATUS[systemLevel] }}>{systemLevel === "ok" ? "operational" : systemLevel === "warn" ? "degraded" : "incident"}</span>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ font: `500 17px/1 ${mono}` }}>{fmt(clock)}</div>
            <div style={{ font: `400 10px/1.4 ${mono}`, color: c.faint, marginTop: 3 }}>обновлено {fmt(updated)} · авто 30с</div>
          </div>
        </div>
      </header>

      {/* grid */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 14 }}>
        <W1Health rows={data.health} />
        <W2Recon rows={data.recon} />
        <W3Dead rows={data.dead} />
        <div style={{ gridColumn: "span 1" }} />
        <W4Funnel rows={data.funnel} />
        <W5Ttft data={data.ttft} />
        <div style={{ gridColumn: "span 1" }} />
        <W6Queue rows={data.queue} />
        <W7ErrorRate rows={data.errorRate} />
        <W8Hourly rows={data.leadsByHour} />
        <W9Errors rows={data.errorsFeed} />
      </div>

      <footer style={{ marginTop: 18, font: `400 10px/1.5 ${mono}`, color: c.faint, textAlign: "center" }}>
        данные из Supabase · dash_*-RPC (RLS-safe) · автообновление 30с. Красное на экране = алерт в Telegram.
      </footer>
    </div>
  );
}
