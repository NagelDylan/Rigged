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
        // type the oldest unfinished line first
        for (const l of ls) {
          const have = next[l.id] ?? 0;
          if (have < l.text.length) {
            const step = Math.max(1, Math.round((TYPE_CPS * 40) / 1000));
            next[l.id] = Math.min(l.text.length, have + step);
            if (l.kind === "say") sfx.rigType();
            changed = true;
            break;
          }
        }
        return changed ? next : prev;
      });
    }, 40);
    return () => clearInterval(id);
  }, []);
  return shown;
}

function Meter({ l, r }: { l: number; r: number }) {
  return (
    <div className="meter split">
      <i className="l" style={{ width: `${Math.min(50, l * 50)}%` }} />
      <i className="r" style={{ width: `${Math.min(50, r * 50)}%` }} />
    </div>
  );
}

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
  const status =
    rt.screen === "title"
      ? "DORMANT"
      : rt.screen === "win"
        ? rt.winStage === 0
          ? "OFFLINE"
          : "..."
        : d?.inFlight
          ? "THINKING"
          : d && d.currentWatch
            ? "PREDICTING"
            : "OBSERVING";

  const winLines: TermLine[] =
    rt.screen === "win" && rt.winStage >= 1 ? [{ id: -1, kind: "say", text: "...no.", at: 0 }] : [];

  return (
    <aside className="rig" aria-label="RIG terminal">
      <div className="eyebox">
        <EyeCanvas rt={rt} />
        <div className="id">
          <span className="big">RIG</span>
          {mode === "live" ? `LIVE // ${(rt.session?.model ?? "").replace("claude-", "").toUpperCase()}` : "LOCAL // DETERMINISTIC"}
        </div>
      </div>
      <div className="status">
        <span className={status === "THINKING" ? "think" : ""}>:: {status}</span>
        <span>{d ? `CH ${d.game.chamber.index + 1}/${d.game.totalChambers}` : ""}</span>
      </div>
      <div className="term" role="log" aria-live="polite">
        {rt.screen === "win" && rt.winStage === 0 ? null : (
          <>
            {(rt.screen === "win" ? winLines : lines).map((l) => {
              const n = l.id < 0 ? l.text.length : (shown[l.id] ?? 0);
              const wrong = l.kind === "verdict" && /WRONG/.test(l.text);
              return (
                <div key={l.id} className={`ln ${l.kind} ${wrong ? "wrong" : ""}`}>
                  {l.kind === "sealed" ? (
                    <>
                      {l.text.slice(0, n)} <span className="hash">{n >= l.text.length ? hashOf(l.id) : ""}</span>
                    </>
                  ) : (
                    l.text.slice(0, n)
                  )}
                </div>
              );
            })}
            {rt.screen === "title" ? <div className="ln sys">AWAITING SUBJECT</div> : null}
            <div className="ln">
              <span className="cursor" />
            </div>
          </>
        )}
      </div>
      {tally && rt.screen === "game" ? (
        <div className="watch">
          <div className="row">
            <span className="lbl">WALL L|R</span>
            <Meter l={Math.min(1, tally.wallL / 8)} r={Math.min(1, tally.wallR / 8)} />
            <span className="val">
              {tally.wallL.toFixed(1)}|{tally.wallR.toFixed(1)}
            </span>
          </div>
          <div className="row">
            <span className="lbl">LANE L|R</span>
            <Meter l={tally.laneL} r={tally.laneR} />
            <span className="val">
              {Math.round(tally.laneL * 100)}|{Math.round(tally.laneR * 100)}
            </span>
          </div>
          <div className="row">
            <span className="lbl">FLINCH</span>
            <span style={{ color: "var(--rig)" }}>
              {tally.panic.length ? tally.panic.slice(-8).map((p) => (p === "hold" ? "·" : p)).join(" ") : "—"}
            </span>
            <span className="val">{tally.reaction ? `${tally.reaction}ms` : ""}</span>
          </div>
          {active ? (
            <div className="hyp">
              <span className="tag">BELIEF {Math.round(active.confidence * 100)}% </span>
              {active.claim}
            </div>
          ) : null}
        </div>
      ) : null}
    </aside>
  );
}
