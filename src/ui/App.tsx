import { useEffect, useRef, useSyncExternalStore } from "react";
import { sfx } from "../audio/sfx";
import { AgentView } from "./AgentView";
import { openSession } from "./api";
import { RigPanel } from "./RigPanel";
import { runtime as rt } from "./runtime";
import { Summary } from "./Summary";

const fmt = (ms: number) => {
  const s = ms / 1000;
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${(s % 60).toFixed(1).padStart(4, "0")}`;
};

export function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useSyncExternalStore(
    (cb) => rt.subscribe(cb),
    () => rt.version,
  );

  useEffect(() => {
    rt.attach(canvasRef.current!);
    void openSession().then((s) => rt.setSession(s));
    const ro = new ResizeObserver(() => rt.resize());
    ro.observe(canvasRef.current!);
    return () => {
      ro.disconnect();
      rt.detach();
    };
  }, []);

  const g = rt.game;
  const d = rt.director;
  const chamber = g?.chamber;
  const infected = (g?.chamber.index ?? 0) >= 3;
  const mode = rt.session?.rigMode;
  const modelRoom = chamber?.template === "MODEL";

  return (
    <div className={`cabinet ${infected ? "infected" : ""}`}>
      <header className="strip">
        <span className="logo">
          RIG<b>GED</b>
        </span>
        <span className="sep" />
        {chamber && rt.screen !== "title" ? (
          <>
            <span>
              {modelRoom ? "MY CHAMBER" : "CHAMBER"}{" "}
              <span className="v">
                {String(chamber.index + 1).padStart(2, "0")}/{String(g!.totalChambers).padStart(2, "0")}
              </span>{" "}
              // <span className="v">{chamber.name}</span>
            </span>
            <span>
              TIME <span className="v">{fmt(g!.clock)}</span>
            </span>
            <span>
              DEATHS <span className="v">{g!.totalDeaths}</span>
            </span>
          </>
        ) : (
          <span>YOU CONTROL THE BAR. RIG CONTROLS EVERYTHING ELSE.</span>
        )}
        <span className="spacer" />
        <span>
          <i className={`lamp ${mode === "live" ? "rig" : "on"}`} />
          RIG {mode === "live" ? "LIVE" : mode === "local" ? "LOCAL" : "…"}
        </span>
        <span>
          <i className={`lamp ${sfx.muted ? "" : "on"}`} />
          SOUND <span className="key">M</span>
        </span>
        <span>
          <i className={`lamp ${rt.agentView ? "rig" : ""}`} />
          AGENT VIEW <span className="key">D</span>
        </span>
      </header>

      <main className={`main ${rt.agentView ? "agent" : ""}`}>
        <section className="bay">
          <span className="rivet" style={{ left: 3, top: 3 }} />
          <span className="rivet" style={{ right: 3, top: 3 }} />
          <span className="rivet" style={{ left: 3, bottom: 3 }} />
          <span className="rivet" style={{ right: 3, bottom: 3 }} />
          <canvas ref={canvasRef} className="machine" aria-label="RIGGED machine" />
          {rt.screen === "game" && rt.paused ? (
            <div className="overlay">
              <div className="plate">
                <h2>{rt.focused ? "PAUSED" : "MACHINE IDLE"}</h2>
                <p>{rt.focused ? "ESC TO RESUME" : "CLICK HERE, THEN ESC TO RESUME"}</p>
                <p>
                  <span className="key">W</span>
                  <span className="key">S</span> LEFT MOTOR · <span className="key">↑</span>
                  <span className="key">↓</span> RIGHT MOTOR
                </p>
                <p>
                  <span className="key">R</span> RESTART RUN · <span className="key">M</span> SOUND · <span className="key">D</span> AGENT VIEW
                </p>
                <button className="btn" onClick={() => rt.setPaused(false)}>
                  Resume
                </button>
              </div>
            </div>
          ) : null}
        </section>
        {rt.agentView ? <AgentView rt={rt} /> : <RigPanel rt={rt} />}
      </main>

      <footer className="strip bottom">
        <span>
          LEFT MOTOR <span className="key">W</span>
          <span className="key">S</span>
        </span>
        <span>
          RIGHT MOTOR <span className="key">↑</span>
          <span className="key">↓</span>
        </span>
        <span className="sep" />
        <span>
          {rt.screen === "title"
            ? "PRESS SPACE TO INSERT PLAYER"
            : d?.inFlight
              ? "RIG IS THINKING. THE MACHINE IS NOT WAITING."
              : "GET THE BALL INTO THE EXIT. AVOID EVERY OTHER HOLE."}
        </span>
        <span className="spacer" />
        <span>
          <span className="key">ESC</span> PAUSE
        </span>
      </footer>
      {rt.screen === "summary" ? <Summary rt={rt} /> : null}
    </div>
  );
}
