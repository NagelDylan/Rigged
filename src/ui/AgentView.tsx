import type { DecisionLog } from "../agent/director";
import type { PlayerModelSnapshot } from "../shared/rig";
import type { Runtime } from "./runtime";

const FIELD_WORD: Record<string, string> = {
  laneBias: "lane",
  wallPark: "wall parking",
  panicDirection: "escape direction",
  motorShare: "motor habit",
};
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
      panicN ? `${m.panicDirection.v.side === "C" ? "FREEZES" : m.panicDirection.v.side ? sideWord(m.panicDirection.v.side) : "MIXED"} ${Math.max(m.panicDirection.v.L, m.panicDirection.v.R, m.panicDirection.v.hold)}/${panicN}` : "—",
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
          <span className="v adapt">
            called out on {FIELD_WORD[m.adaptation.v.calledOut] ?? m.adaptation.v.calledOut}: {m.adaptation.v.before} → {m.adaptation.v.after}{" "}
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
      <span className="c" title="how sure the model is (sample size)">
        {c < 0.34 ? "weak" : c < 0.67 ? "some" : "sure"}
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
        {l.latencyMs}ms{l.fallbackReason && !["local_mode", "no_key"].includes(l.fallbackReason) ? ` · live failed → local (${l.fallbackReason})` : ""}
      </div>
      {d ? (
        <>
          <div className="chain">
            <span className="lbl">SAW</span>
            <span>{d.observation}</span>
          </div>
          <div className="chain">
            <span className="lbl">THINKS</span>
            <span>
              {d.hypothesis.claim} <span className="arrow">({d.hypothesis.status} · {d.hypothesis.field} · {pct(d.hypothesis.confidence)})</span>
            </span>
          </div>
          <div className="chain">
            <span className="lbl">DOES</span>
            <span>
              {d.action.ability === "WAIT" ? "WAIT (watch)" : (l.order ?? `${d.action.ability} ${d.action.side}`)} <span className="arrow">· {d.intent}</span>
            </span>
          </div>
          {l.sealed ? (
            <div className="chain">
              <span className="lbl">PREDICTS</span>
              <span>
                {l.sealed.toLowerCase()} <span className="arrow">(p {pct(d.prediction?.pRig ?? 0)} vs naive {pct(d.prediction?.pBaseline ?? 0)})</span>
              </span>
            </div>
          ) : null}
          {l.outcome ? (
            <div className="chain">
              <span className="lbl">RESULT</span>
              <span>
                <span className={`vtag ${l.outcome.verdict}`}>{l.outcome.verdict}</span> {l.outcome.observed}
              </span>
            </div>
          ) : null}
        </>
      ) : (
        <div className="chain">
          <span className="lbl">NOTE</span>
          <span>{l.digest}</span>
        </div>
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
  const acting = !!d?.game.effects.some((e) => e.phase === "telegraph" || e.phase === "active");
  const step = d?.inFlight ? 1 : acting ? 2 : d?.currentWatch ? 3 : 0;
  const loop: [string, string][] = [
    ["OBSERVE", "your inputs → player model"],
    ["HYPOTHESIZE", "RIG names a habit"],
    ["ACT", "rigs the machine to test it"],
    ["EVALUATE", "sealed prediction vs. reality"],
  ];
  return (
    <aside className="agentview" aria-label="Agent view">
      <div className="av-head">
        <span className="ttl">Agent View</span>
        <span className="mode">
          <b className={mode === "local" ? "local" : ""}>{mode === "live" ? (rt.session?.model ?? "LIVE").replace("claude-", "") : "LOCAL RIG (no API key)"}</b>
          {d ? ` · ${d.calls.live} live / ${d.calls.local} local` : ""}
        </span>
      </div>
      <p className="av-intro">
        RIG watches how you play, forms a claim about your habits, rigs the machine to exploit it, and seals a prediction
        before it can see the result.
      </p>
      <ol className="av-loop">
        {loop.map(([k, cap], i) => (
          <li key={k} className={i === step ? "on" : ""}>
            <span className="k">
              <span className="n">{i + 1}</span>
              {k}
            </span>
            <span className="cap">{cap}</span>
          </li>
        ))}
      </ol>
      <div className="av-sec">
        <h3>
          <span className={`sn ${step === 0 ? "on" : ""}`}>1</span>Player model <small>measured from your inputs · last column = evidence</small>
        </h3>
        {m ? <ModelRows m={m} /> : <div>—</div>}
      </div>
      <div className="av-sec">
        <h3>
          <span className={`sn ${step === 1 ? "on" : ""}`}>2</span>RIG now{" "}
          <small>{d?.inFlight ? `thinking… (${d.inFlight.trigger.replace("_", " ")})` : "latest decision · no chain-of-thought"}</small>
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
          <span className="sn">2</span>Hypothesis ledger <small>+ supported / − weakened</small>
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
          <span className={`sn ${step >= 2 ? "on" : ""}`}>3·4</span>Decision log <small>newest first · saw → thinks → does → result</small>
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
