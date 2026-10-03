import type { DecisionLog } from "../agent/director";
import type { PlayerModelSnapshot } from "../shared/rig";
import type { Runtime } from "./runtime";

const pct = (v: number) => `${Math.round(v * 100)}%`;
const sideWord = (s: string | null | undefined) => (s === "L" ? "LEFT" : s === "R" ? "RIGHT" : s === "C" ? "CENTRE" : "—");

function Bar({ v, hot }: { v: number; hot?: boolean }) {
  return (
    <div className={`meter ${hot ? "hot" : ""}`}>
      <i style={{ left: 0, width: `${Math.max(0, Math.min(1, v)) * 100}%` }} />
    </div>
  );
}

function ModelRows({ m }: { m: PlayerModelSnapshot }) {
  const laneDom = m.laneBias.v.L > m.laneBias.v.R ? "L" : "R";
  const laneVal = Math.max(m.laneBias.v.L, m.laneBias.v.R);
  const wallTot = m.wallPark.v.L + m.wallPark.v.R;
  const wallDom = m.wallPark.v.L > m.wallPark.v.R ? "L" : "R";
  const panicN = m.panicDirection.n;
  const rows: [string, string, number, number, boolean][] = [
    ["Lane bias", `${sideWord(laneDom)} ${pct(laneVal)}`, laneVal, m.laneBias.c, laneVal > 0.55],
    [
      "Wall parking",
      wallTot > 0 ? `${sideWord(wallDom)} ${Math.round((Math.max(m.wallPark.v.L, m.wallPark.v.R) / wallTot) * 100)}%` : "—",
      wallTot > 0 ? Math.max(m.wallPark.v.L, m.wallPark.v.R) / wallTot : 0,
      m.wallPark.c,
      !!m.wallPark.v.side,
    ],
    [
      "Panic dir",
      panicN ? `${sideWord(m.panicDirection.v.side)} (${m.panicDirection.v.L}L/${m.panicDirection.v.R}R/${m.panicDirection.v.hold}·)` : "—",
      panicN ? Math.max(m.panicDirection.v.L, m.panicDirection.v.R, m.panicDirection.v.hold) / panicN : 0,
      m.panicDirection.c,
      !!m.panicDirection.v.side,
    ],
    ["Reaction", m.reactionMs.v ? `${m.reactionMs.v} ms` : "—", m.reactionMs.v ? Math.min(1, m.reactionMs.v / 1000) : 0, m.reactionMs.c, false],
    ["Style", m.style.v.label.toUpperCase(), m.style.v.stationaryPct, m.style.c, m.style.v.label !== "steady"],
    ["Corrections", `${m.correctionRate.v}/10s`, Math.min(1, m.correctionRate.v / 8), m.correctionRate.c, false],
    ["Motor L|R", `${pct(m.motorShare.v.L)}|${pct(m.motorShare.v.R)}`, Math.max(m.motorShare.v.L, m.motorShare.v.R), m.motorShare.c, false],
    ["Exit approach", sideWord(m.exitApproach.v.side), m.exitApproach.c, m.exitApproach.c, false],
  ];
  return (
    <div className="av-grid">
      {rows.map(([k, v, bar, c, hot]) => (
        <FragmentRow key={k} k={k} v={v} bar={bar} c={c} hot={hot} />
      ))}
      {m.adaptation.v.calledOut ? (
        <>
          <span className="k">Adaptation</span>
          <span className="v" style={{ gridColumn: "2 / span 3", textAlign: "left" }}>
            called out {m.adaptation.v.calledOut}: {m.adaptation.v.before} → {m.adaptation.v.after}{" "}
            {m.adaptation.v.changed ? <b style={{ color: "var(--amber)" }}>CHANGED</b> : "holding"}
          </span>
        </>
      ) : null}
    </div>
  );
}

function FragmentRow({ k, v, bar, c, hot }: { k: string; v: string; bar: number; c: number; hot: boolean }) {
  return (
    <>
      <span className="k">{k}</span>
      <Bar v={bar} hot={hot} />
      <span className="v">{v}</span>
      <span className="c" title="confidence">
        c{Math.round(c * 100)}
      </span>
    </>
  );
}

function trig(l: DecisionLog) {
  return l.trigger.replace("_", " ");
}

function LogItem({ l }: { l: DecisionLog }) {
  const d = l.decision;
  const veto = /VETO|STALE|FIZZLED|DROPPED/.test(l.ruling);
  return (
    <li>
      <div className="meta">
        <b>{l.id}</b> · t{(l.at / 1000).toFixed(1)}s · trigger <b>{trig(l)}</b> ·{" "}
        <span className={l.source}>{l.source === "live" ? `LIVE ${(l.model ?? "").replace("claude-", "")}` : "LOCAL"}</span> ·{" "}
        {l.latencyMs}ms{l.fallbackReason ? ` · fallback: ${l.fallbackReason}` : ""}
      </div>
      {d ? (
        <>
          <div className="chain">
            <span className="arrow">SAW </span>
            {d.observation}
          </div>
          <div className="chain">
            <span className="arrow">THINKS </span>
            {d.hypothesis.claim} <span className="arrow">({d.hypothesis.status} · {d.hypothesis.field} · {pct(d.hypothesis.confidence)})</span>
          </div>
          <div className="chain">
            <span className="arrow">DOES </span>
            {d.action.ability === "WAIT" ? "WAIT (watch)" : (l.order ?? `${d.action.ability} ${d.action.side}`)} <span className="arrow">· {d.intent}</span>
          </div>
          {l.sealed ? (
            <div className="chain">
              <span className="arrow">PREDICTS </span>
              {l.sealed.toLowerCase()} <span className="arrow">(p {pct(d.prediction?.pRig ?? 0)} vs naive {pct(d.prediction?.pBaseline ?? 0)})</span>
            </div>
          ) : null}
          {l.outcome ? (
            <div className="chain">
              <span className="arrow">RESULT </span>
              <span className={`vtag ${l.outcome.verdict}`}>{l.outcome.verdict}</span> {l.outcome.observed}
            </div>
          ) : null}
        </>
      ) : (
        <div className="chain">{l.digest}</div>
      )}
      <div className={`ruling ${veto ? "veto" : ""}`}>
        DIRECTOR: {l.ruling || "—"}
        {l.repairs.length ? ` · repairs: ${l.repairs.slice(0, 3).join("; ")}` : ""}
      </div>
    </li>
  );
}

export function AgentView({ rt }: { rt: Runtime }) {
  const d = rt.director;
  const m = rt.model?.snapshot();
  const latest = d?.log.filter((l) => l.decision).at(-1);
  const mode = rt.session?.rigMode ?? "local";
  const stage = d?.inFlight ? 3 : d?.currentWatch ? 6 : latest?.outcome ? 7 : 5;
  const stages = ["INPUT", "ENGINE", "PLAYER MODEL", "RIG", "VALIDATE", "EXECUTE", "OUTCOME"];
  return (
    <aside className="agentview" aria-label="Agent view">
      <div className="av-head">
        Agent View
        <span className="mode">
          RIG <b className={mode === "local" ? "local" : ""}>{mode === "live" ? rt.session?.model : "LOCAL FALLBACK"}</b> · calls{" "}
          {d ? `${d.calls.live} live / ${d.calls.local} local` : "—"}
        </span>
      </div>
      <div className="av-pipe">
        {stages.map((s, i) => (
          <span key={s} style={{ display: "contents" }}>
            <span className={i + 1 === stage || (stage === 3 && i === 3) ? "on" : ""}>{s}</span>
            {i < stages.length - 1 ? <em>→</em> : null}
          </span>
        ))}
      </div>
      <div className="av-sec">
        <h3>
          Player model <small>deterministic telemetry · c = confidence</small>
        </h3>
        {m ? <ModelRows m={m} /> : <div>—</div>}
      </div>
      <div className="av-sec">
        <h3>
          RIG now <small>{d?.inFlight ? `thinking… (${d.inFlight.trigger})` : "concise model output, no chain-of-thought"}</small>
        </h3>
        {latest?.decision ? (
          <>
            <div className="av-big">{latest.decision.hypothesis.claim}</div>
            <div className="av-row">
              <span className="k">Confidence</span>
              <span className="v">{pct(latest.decision.hypothesis.confidence)}</span>
              <span className="k">Strategy</span>
              <span className="v">{latest.decision.strategy}</span>
              <span className="k">Action</span>
              <span className="v">{latest.order ?? latest.decision.action.ability}</span>
              <span className="k">Prediction</span>
              <span className="v">{latest.sealed ?? "none"}</span>
              <span className="k">Outcome</span>
              <span className="v">
                {latest.outcome ? (
                  <>
                    <span className={`vtag ${latest.outcome.verdict}`}>{latest.outcome.verdict}</span> {latest.outcome.observed}
                  </>
                ) : d?.currentWatch ? (
                  "watching…"
                ) : (
                  "—"
                )}
              </span>
            </div>
          </>
        ) : (
          <div className="av-big">Observing. No hypothesis yet.</div>
        )}
      </div>
      <div className="av-sec">
        <h3>
          Hypothesis ledger <small>+ supported / − weakened</small>
        </h3>
        <table className="ledger">
          <tbody>
            {(d?.ledger ?? []).slice(-6).map((h) => (
              <tr key={h.id} className={h.status}>
                <td className="id">{h.id}</td>
                <td className="claim">{h.claim}</td>
                <td className="num">
                  {pct(h.confidence)} <span className="s">+{h.supported}</span> <span className="w">−{h.weakened}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {d?.finalPlan ? (
          <div className="av-row" style={{ marginTop: 8 }}>
            <span className="k">MODEL plan</span>
            <span className="v">
              {d.finalPlan.plan.claim} trap {sideWord(d.finalPlan.plan.trapSide)} · exit {sideWord(d.finalPlan.plan.exitSide)} · {d.finalPlan.plan.loadout.join("+")}
              {d.finalPlan.plan.useRestingSpots ? " · holes at your resting spots" : ""}
            </span>
          </div>
        ) : null}
      </div>
      <div className="av-sec" style={{ flex: 1 }}>
        <h3>
          Decision log <small>observe → hypothesize → act → evaluate</small>
        </h3>
        <ul className="dlog">
          {(d?.log ?? [])
            .slice(-7)
            .reverse()
            .map((l) => (
              <LogItem key={l.id} l={l} />
            ))}
        </ul>
      </div>
    </aside>
  );
}
