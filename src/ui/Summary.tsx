import type { Ability } from "../shared/rig";
import type { Runtime } from "./runtime";

const fmtTime = (ms: number) => {
  const m = Math.floor(ms / 60000);
  const s = (ms % 60000) / 1000;
  return `${String(m).padStart(2, "0")}:${s.toFixed(2).padStart(5, "0")}`;
};
const side = (s: string | null | undefined) => (s === "L" ? "LEFT" : s === "R" ? "RIGHT" : s === "C" ? "CENTRE" : null);
const FIELD_WORD: Record<string, string> = {
  laneBias: "lane",
  wallPark: "wall parking",
  panicDirection: "escape direction",
  motorShare: "motor habit",
};

export function Summary({ rt }: { rt: Runtime }) {
  const r = rt.result;
  const d = rt.director;
  if (!r || !d) return null;
  const m = r.summary.model;
  const laneDom = m.laneBias.v.L >= m.laneBias.v.R ? "L" : "R";
  const learned: [string, string][] = [];
  const laneShare = Math.round(Math.max(m.laneBias.v.L, m.laneBias.v.R) * 100);
  if (laneShare >= 45) learned.push([`${side(laneDom)} BIAS`, `${laneShare}%`]);
  if (m.wallPark.v.side) learned.push(["PARKS ON", `${side(m.wallPark.v.side)} WALL`]);
  if (m.panicDirection.v.side) learned.push(["PANIC RESPONSE", m.panicDirection.v.side === "C" ? "FREEZE" : side(m.panicDirection.v.side)!]);
  if (m.reactionMs.v) learned.push(["REACTION", `${m.reactionMs.v} MS`]);
  learned.push(["STYLE", m.style.v.label.toUpperCase()]);
  const kills = Object.entries(m.abilityWeakness.v) as [Ability, { used: number; kills: number; evaded: number }][];
  const best = kills.filter(([, v]) => v.kills > 0).sort((a, b) => b[1].kills / b[1].used - a[1].kills / a[1].used)[0];
  const worst = kills.filter(([, v]) => v.used >= 2).sort((a, b) => b[1].evaded / b[1].used - a[1].evaded / a[1].used)[0];
  if (best) learned.push(["MOST EFFECTIVE", `${best[0]} ${best[1].kills}/${best[1].used}`]);
  if (worst && (!best || worst[0] !== best[0])) learned.push(["YOU BEAT", `${worst[0]} ${worst[1].evaded}/${worst[1].used}`]);

  const adapt = m.adaptation.v;
  const adaptLine = adapt.calledOut
    ? adapt.changed
      ? `Changed ${FIELD_WORD[adapt.calledOut] ?? adapt.calledOut} after being called out.`
      : `Kept the same ${FIELD_WORD[adapt.calledOut] ?? adapt.calledOut} after being called out.`
    : "Never gave RIG a habit worth naming.";

  const verdicts = d.log.filter((l) => l.outcome).map((l) => l.outcome!.verdict);
  const right = verdicts.filter((v) => v === "SUPPORTED").length;
  const wrong = verdicts.filter((v) => v === "WEAKENED").length;
  const end = r.rigEnd;

  return (
    <div className="summary" role="dialog" aria-label="Run summary">
      <div className="sum-head">
        <h1>YOU ESCAPED</h1>
        <div className="time">{fmtTime(r.timeMs)}</div>
        <div className="again">
          <button className="btn" onClick={() => rt.startRun()} autoFocus>
            Play again
          </button>
          <div style={{ marginTop: 8 }}>
            <span className="key">ENTER</span> again · <span className="key">D</span> agent view
          </div>
        </div>
      </div>
      <div className="sum-cols">
        <div className="sum-plate">
          <h3>RUN</h3>
          <div className="stat">
            <span>Deaths</span>
            <span className="v">{r.summary.deaths}</span>
          </div>
          {r.summary.chambers.map((c, i) => (
            <div className="stat" key={i}>
              <span>
                {String(i + 1).padStart(2, "0")} {c.template}
              </span>
              <span className="v">
                {(c.timeMs / 1000).toFixed(1)}s · {c.deaths}✕
              </span>
            </div>
          ))}
          <div className="stat">
            <span>RIG predictions</span>
            <span className="v">
              {right} right · {wrong} wrong
            </span>
          </div>
          <div className="stat">
            <span>RIG decisions</span>
            <span className="v">
              {r.summary.calls.live} live · {r.summary.calls.local} local
            </span>
          </div>
        </div>
        <div className="sum-plate rigplate">
          <h3>RIG LEARNED</h3>
          <div className="learned">
            {learned.map(([k, v]) => (
              <div className="row" key={k}>
                <span>{k}</span>
                <span>{v}</span>
              </div>
            ))}
          </div>
          <h3 style={{ marginTop: 16 }}>WHERE YOU STOP</h3>
          <div className="heat" aria-label="resting spots, left to right">
            {r.summary.restingSpots.map((v, i) => {
              const max = Math.max(0.1, ...r.summary.restingSpots);
              return <i key={i} style={{ opacity: 0.12 + 0.88 * (v / max) }} />;
            })}
          </div>
          <div className="heat-lbl">
            <span>LEFT WALL</span>
            <span>RIGHT WALL</span>
          </div>
          <h3 style={{ marginTop: 16 }}>ADAPTATION</h3>
          <div className="learned" style={{ fontSize: 22 }}>
            {adaptLine}
          </div>
          <h3 style={{ marginTop: 16 }}>HYPOTHESES</h3>
          <div className="notes" style={{ fontSize: 19 }}>
            {d
              .topHypotheses(8)
              .filter((h, i, all) => all.findIndex((q) => q.claim === h.claim) === i)
              .slice(0, 4)
              .map((h) => (
              <div key={h.id}>
                {h.claim}{" "}
                <span style={{ color: "var(--rig-dim)" }}>
                  +{h.supported}/−{h.weakened}
                  {h.status === "abandoned" ? " ABANDONED" : ""}
                </span>
              </div>
            ))}
          </div>
        </div>
        <div className="sum-plate rigplate">
          <h3>MEMORY WRITTEN {r.rigEndSource ? `(${r.rigEndSource.toUpperCase()})` : ""}</h3>
          <div className="notes">
            {end ? end.memoryNotes.map((n, i) => <div key={i}>{n}</div>) : <div>writing…</div>}
          </div>
          {end?.verdict ? <div className="notes" style={{ marginTop: 12, color: "var(--bone-dim)" }}>{end.verdict}</div> : null}
          <div className="quote">RIG: “{end?.taunt || "Next time I'm starting there."}”</div>
        </div>
      </div>
    </div>
  );
}
