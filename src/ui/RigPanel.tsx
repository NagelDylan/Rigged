import { useEffect, useRef, useState } from "react";
import { sfx } from "../audio/sfx";
import { drawEye, type EyeState } from "../render/eye";
import type { TermLine } from "../agent/director";
import type { Runtime } from "./runtime";

const TYPE_CPS = 45;

export function EyeCanvas({ rt, scale = 5 }: { rt: Runtime; scale?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let raf = 0;
    const loop = (t: number) => {
      raf = requestAnimationFrame(loop);
      const c = ref.current;
      if (!c) return;
      const ctx = c.getContext("2d")!;
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, c.width, c.height);
      const g = rt.game;
      const look = g ? Math.max(-1, Math.min(1, g.ball.x / 260)) : Math.sin(t / 1400) * 0.6;
      let state: EyeState = "tracking";
      if (rt.screen === "title") state = "idle";
      else if (rt.screen === "win") state = rt.winStage === 0 ? "offline" : rt.winStage === 1 ? "closed" : "smug";
      else if (rt.screen === "summary") state = "smug";
      else if (rt.director) state = (rt.director.eye.mood === "tracking" ? "tracking" : rt.director.eye.mood) as EyeState;
      drawEye(ctx, c.width / 2, c.height / 2, scale, state, t, look);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [rt, scale]);
  return <canvas ref={ref} width={17 * scale} height={9 * scale} aria-label="RIG eye" />;
}

function hashOf(n: number) {
  let x = Math.imul(n * 2654435761, 0x45d9f3b) >>> 0;
  return `#${x.toString(16).toUpperCase().padStart(8, "0").slice(0, 4)}-${((x >>> 7) & 0xffff).toString(16).toUpperCase().padStart(4, "0")}`;
}

/**
 * Taunts ("say") are typed out; system/sealed/verdict lines print instantly.
 * Lines reveal strictly in order, so nothing below an unfinished taunt shows yet.
 * If taunts pile up (fast play / ?speed), older ones snap to complete.
 */
function useTyped(lines: TermLine[]) {
  const [shown, setShown] = useState<Record<number, number>>({});
  const linesRef = useRef(lines);
  linesRef.current = lines;
  useEffect(() => {
    const id = setInterval(() => {
      setShown((prev) => {
        const ls = linesRef.current;
        const next = { ...prev };
        let changed = false;
        for (let i = 0; i < ls.length; i++) {
          const l = ls[i];
          const have = next[l.id] ?? 0;
          if (have >= l.text.length) continue;
          const backlog = ls.slice(i + 1).filter((q) => q.kind === "say").length;
          if (l.kind !== "say" || backlog >= 2) {
            next[l.id] = l.text.length;
            changed = true;
            continue; // instant lines don't hold the queue
          }
          const step = Math.max(1, Math.round((TYPE_CPS * 40) / 1000));
          next[l.id] = Math.min(l.text.length, have + step);
          sfx.rigType();
          changed = true;
          break;
        }
        return changed ? next : prev;
      });
    }, 40);
    return () => clearInterval(id);
  }, []);
  return shown;
}

const VERDICT_RE = /^(.*?)\s+—\s+(CORRECT|WRONG|OBVIOUS|VOID)$/;

function TermLineView({ l, n }: { l: TermLine; n: number }) {
  if (l.kind === "sealed") {
    return (
      <div className="ln sealed">
        <span className="env">SEALED</span>
        <span className="lbl">PREDICTION</span>
        <span className="hash">{hashOf(l.id)}</span>
      </div>
    );
  }
  if (l.kind === "verdict") {
    const m = VERDICT_RE.exec(l.text);
    const mark = m?.[2] ?? "";
    const body = m?.[1] ?? l.text;
    const ci = body.indexOf(": ");
    const head = ci > 0 ? body.slice(0, ci + 1) : "";
    const claim = ci > 0 ? body.slice(ci + 2) : body;
    return (
      <div className={`ln verdict v-${mark.toLowerCase()}`}>
        <span className="body">
          {head ? <span className="when">{head}</span> : null}
          <span className="what">{claim}</span>
        </span>
        {mark ? <span className="stamp">{mark}</span> : null}
      </div>
    );
  }
  return <div className={`ln ${l.kind}`}>{l.text.slice(0, n)}</div>;
}

function Meter({ l, r }: { l: number; r: number }) {
  return (
    <div className="meter split">
      <i className="l" style={{ width: `${Math.min(50, l * 50)}%` }} />
      <i className="r" style={{ width: `${Math.min(50, r * 50)}%` }} />
    </div>
  );
}

const secs = (v: number) => (v >= 10 ? `${Math.round(v)}s` : `${v.toFixed(1)}s`);

export function RigPanel({ rt }: { rt: Runtime }) {
  const d = rt.director;
  const lines = (d?.lines ?? []).slice(-14);
  const shown = useTyped(lines);
  const lastSay = useRef(0);
  useEffect(() => {
    const say = lines.filter((l) => l.kind === "say").at(-1);
    if (say && say.id !== lastSay.current) {
      lastSay.current = say.id;
      sfx.rigStatic();
    }
  });

  const tally = rt.model?.tally();
  const active = d?.ledger.filter((l) => l.status === "active").at(-1);
  const mode = rt.session?.rigMode ?? "local";
  const offline = rt.screen === "win" && rt.winStage === 0;
  const status =
    rt.screen === "title"
      ? "DORMANT"
      : rt.screen === "win"
        ? rt.winStage === 0
          ? "OFFLINE"
          : "REBOOTING"
        : d?.inFlight
          ? "THINKING"
          : d && d.currentWatch
            ? "PREDICTING"
            : "OBSERVING";

  // reveal strictly in order: stop at the first line still being typed
  const visible: { l: TermLine; n: number }[] = [];
  for (const l of lines) {
    const n = shown[l.id] ?? 0;
    if (n === 0) break;
    visible.push({ l, n });
    if (n < l.text.length) break;
  }
  const lastSayId = visible.filter((v) => v.l.kind === "say").at(-1)?.l.id;
  const typing = visible.length > 0 && visible[visible.length - 1].n < visible[visible.length - 1].l.text.length;

  return (
    <aside className={`rig ${offline ? "offline" : ""}`} aria-label="RIG terminal">
      <div className="eyebox">
        <EyeCanvas rt={rt} />
        <div className="id">
          <span className="big">RIG</span>
          {mode === "live" ? `LIVE // ${(rt.session?.model ?? "").replace("claude-", "").toUpperCase()}` : "LOCAL // DETERMINISTIC"}
        </div>
      </div>
      <div className="status">
        <span className={status === "THINKING" ? "think" : ""}>
          <i className={`dot ${status.toLowerCase()}`} />
          {status}
        </span>
        <span>{d && rt.screen === "game" ? `CH ${d.game.chamber.index + 1}/${d.game.totalChambers}` : ""}</span>
      </div>
      {rt.screen === "win" ? (
        <div className="term final">{rt.winStage >= 1 ? <div className="no">...no.</div> : <div className="dead">NO CARRIER</div>}</div>
      ) : (
        <div className="term" role="log" aria-live="polite">
          {visible.map(({ l, n }) => (
            <div key={l.id} className={l.kind === "say" && l.id !== lastSayId ? "old" : ""}>
              <TermLineView l={l} n={n} />
            </div>
          ))}
          {rt.screen === "title" ? <div className="ln sys">AWAITING SUBJECT_</div> : null}
          {typing ? null : (
            <div className="ln prompt">
              <span className="cursor" />
            </div>
          )}
        </div>
      )}
      {tally && rt.screen === "game" ? (
        <div className="watch">
          <div className="watch-h">
            <span>WATCHING YOU</span>
            <span>LEFT · RIGHT</span>
          </div>
          <div className="row">
            <span className="lbl">WALL TIME</span>
            <Meter l={Math.min(1, tally.wallL / 8)} r={Math.min(1, tally.wallR / 8)} />
            <span className="val">
              {secs(tally.wallL)}
              <em>|</em>
              {secs(tally.wallR)}
            </span>
          </div>
          <div className="row">
            <span className="lbl">LANE</span>
            <Meter l={tally.laneL} r={tally.laneR} />
            <span className="val">
              {Math.round(tally.laneL * 100)}
              <em>|</em>
              {Math.round(tally.laneR * 100)}%
            </span>
          </div>
          <div className="row">
            <span className="lbl">ESCAPES</span>
            <span className="flinch">
              {tally.panic.length
                ? tally.panic.slice(-8).map((p, i) => (
                    <b key={i} className={i === Math.min(8, tally.panic.length) - 1 ? "now" : ""}>
                      {p === "hold" ? "·" : p}
                    </b>
                  ))
                : "—"}
            </span>
            <span className="val">{tally.reaction ? `${tally.reaction}ms` : ""}</span>
          </div>
          {active ? (
            <div className="hyp">
              <span className="tag">
                BELIEF <b>{Math.round(active.confidence * 100)}%</b>
              </span>
              <span className="claim">{active.claim}</span>
            </div>
          ) : null}
        </div>
      ) : null}
    </aside>
  );
}
