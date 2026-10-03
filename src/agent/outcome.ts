// Deterministic grading of RIG's falsifiable predictions. RIG commits to a
// prediction before acting; this module decides afterwards whether the player
// did what RIG said. The verdict is fed back into RIG's next decision.
import type { Side, TacticalDecision, Verdict } from "../shared/rig";

export interface WatchSample {
  t: number; // ms since anchor
  x: number;
  lane: Side;
  vx: number;
  input: boolean;
}

export interface PredictionWatch {
  decisionId: string;
  prediction: NonNullable<TacticalDecision["prediction"]>;
  anchorAt: number | null; // run clock ms when the window opened (null = waiting for telegraph)
  x0: number;
  lane0: Side;
  samples: WatchSample[];
  firstInputMs: number | null;
  diedAtMs: number | null;
  effectId: number | null;
  fizzled: string | null;
  /** Baseline probability from the player's own history (set by the director). */
  empiricalBaseline?: number;
}

export const FLEE_DX = 22;

export function describePrediction(p: NonNullable<TacticalDecision["prediction"]>): string {
  const side = (s: Side | null) => (s === "L" ? "LEFT" : s === "R" ? "RIGHT" : s === "C" ? "CENTRE" : "?");
  switch (p.event) {
    case "flee":
      return p.side === "C" ? "YOU HOLD STILL" : `YOU FLEE ${side(p.side)}`;
    case "enter_lane":
      return `YOU END UP ${p.side === "C" ? "CENTRE" : side(p.side)}`;
    case "avoid_lane":
      return `YOU AVOID THE ${side(p.side)}`;
    case "react_within":
      return `YOU REACT INSIDE ${p.ms ?? "?"}MS`;
    case "outcome":
      return p.result === "dies" ? "YOU DROP THE BALL" : "YOU SURVIVE IT";
    case "stall":
      return "YOU FREEZE";
  }
}

export interface Evaluation {
  verdict: Verdict;
  observed: string;
}

/** Evaluate a closed watch window. */
export function evaluate(w: PredictionWatch): Evaluation {
  const p = w.prediction;
  if (w.fizzled) return { verdict: "INCONCLUSIVE", observed: `action never fired (${w.fizzled})` };
  if (w.anchorAt === null) return { verdict: "INCONCLUSIVE", observed: "window never opened" };
  const inWindow = w.samples.filter((s) => s.t <= p.windowMs);
  const died = w.diedAtMs !== null && w.diedAtMs <= p.windowMs + 1500;
  const last = inWindow[inWindow.length - 1];
  const dx = last ? last.x - w.x0 : 0;
  const moved: Side = dx < -FLEE_DX ? "L" : dx > FLEE_DX ? "R" : "C";
  const movedTxt = moved === "C" ? "held position" : `went ${moved === "L" ? "left" : "right"} (${Math.round(Math.abs(dx))}u)`;

  let verdict: Verdict;
  let observed: string;
  switch (p.event) {
    case "flee": {
      if (!last) return { verdict: "INCONCLUSIVE", observed: "no data" };
      verdict = moved === p.side ? "SUPPORTED" : "WEAKENED";
      observed = movedTxt + (died ? ", then died" : "");
      break;
    }
    case "enter_lane": {
      // "ends up in lane S": where the ball is when the window closes
      if (!last) return { verdict: "INCONCLUSIVE", observed: "no data" };
      if (died && last.lane !== p.side) return { verdict: "INCONCLUSIVE", observed: "died before committing" };
      const ended = last.lane === p.side;
      verdict = ended ? "SUPPORTED" : "WEAKENED";
      observed = ended ? `ended in ${p.side} lane` : `ended in ${last.lane} lane`;
      break;
    }
    case "avoid_lane": {
      const entered = inWindow.some((s) => s.lane === p.side);
      verdict = entered ? "WEAKENED" : "SUPPORTED";
      observed = entered ? `went into ${p.side} lane` : `kept out of ${p.side} lane`;
      break;
    }
    case "react_within": {
      const limit = p.ms ?? 600;
      if (w.firstInputMs === null) {
        verdict = "WEAKENED";
        observed = "no reaction";
      } else {
        verdict = w.firstInputMs <= limit ? "SUPPORTED" : "WEAKENED";
        observed = `reacted in ${Math.round(w.firstInputMs)}ms`;
      }
      break;
    }
    case "outcome": {
      verdict = (p.result === "dies") === died ? "SUPPORTED" : "WEAKENED";
      observed = died ? "ball lost" : "survived";
      break;
    }
    case "stall": {
      if (!inWindow.length) return { verdict: "INCONCLUSIVE", observed: "no data" };
      const still = inWindow.filter((s) => Math.abs(s.vx) < 10 && !s.input).length / inWindow.length;
      verdict = still >= 0.4 ? "SUPPORTED" : "WEAKENED";
      observed = `still ${Math.round(still * 100)}% of window`;
      break;
    }
  }
  if (verdict === "SUPPORTED" && p.pBaseline > 0.8) verdict = "TRIVIAL";
  if (died && p.event !== "outcome" && verdict === "WEAKENED" && p.event !== "flee") {
    return { verdict: "INCONCLUSIVE", observed: observed + ", died mid-window" };
  }
  return { verdict, observed };
}

/** Is the watch window finished? */
export function windowClosed(w: PredictionWatch, now: number): boolean {
  if (w.fizzled) return true;
  if (w.anchorAt === null) return false;
  if (w.diedAtMs !== null) return true;
  return now - w.anchorAt >= w.prediction.windowMs;
}
