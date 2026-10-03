// Human-like playtest: full RIGGED runs (Game + PlayerModel + Director with the
// deterministic local RIG) driven by HumanBot at novice/average/good skill.
//   npx tsx scripts/human-sim.ts [novice|average|good|all] [--seeds N] [--max S] [--json]
import { Director } from "../src/agent/director";
import { inRelief } from "../src/agent/fairness";
import { LocalTransport } from "../src/agent/transport";
import { PHYS, TIMING } from "../src/engine/constants";
import { Game, type Effect } from "../src/engine/game";
import { PlayerModel } from "../src/engine/playerModel";
import { HumanBot, HUMAN, type HumanSkill } from "../src/engine/humanBot";

export interface DeathInfo {
  chamber: number;
  template: string;
  at: number; // chamber clock ms
  hole: string;
  cause: string | null; // ability or null (plain hole)
  causePhase: string | null; // telegraph / active / after
  sinceTelegraph: number | null;
  sinceActive: number | null;
  sinceRespawn: number;
  tooFast: boolean; // telegraph start -> death shorter than the human's reaction + maneuver budget
}

export interface ChamberStat {
  index: number;
  template: string;
  density: number;
  timeMs: number;
  cleared: boolean;
  deaths: DeathInfo[];
  attacks: number; // telegraphs started
  kills: number; // attacks credited with a kill
  attackByAbility: Record<string, { n: number; kills: number }>;
  longestStuckMs: number;
  maxDeathsHere: number;
  reliefSeen: boolean;
  attacksDuringStreak: number; // telegraphs while deathsHere >= 5 (should be ~0 in relief)
}

export interface RunResult {
  skill: HumanSkill;
  seed: number;
  won: boolean;
  timeMs: number;
  deaths: number;
  chambers: ChamberStat[];
  firstReadAt: number | null; // calibration chamber clock when first_read was queued/answered
  calibrationMs: number | null;
}

export async function humanRun(skill: HumanSkill, seed: number, maxSeconds = 900): Promise<RunResult> {
  const game = new Game(Director.firstChamber(seed));
  const model = new PlayerModel();
  const director = new Director({ game, model, transport: new LocalTransport(), memory: null, seed, now: () => game.clock });
  const human = new HumanBot(skill, seed);
  const budget = HUMAN[skill].delayMs + 300 + 450; // see + decide + start correcting

  const chambers: ChamberStat[] = [];
  const newStat = (): ChamberStat => ({
    index: game.chamber.index,
    template: game.chamber.template,
    density: game.chamber.params.density,
    timeMs: 0,
    cleared: false,
    deaths: [],
    attacks: 0,
    kills: 0,
    attackByAbility: {},
    longestStuckMs: 0,
    maxDeathsHere: 0,
    reliefSeen: false,
    attacksDuringStreak: 0,
  });
  let cur = newStat();
  chambers.push(cur);
  let respawnAt = 0;
  let lifeBest = 0;
  let lifeBestAt = 0;
  let lastDeathClock: number | null = null;
  let firstReadAt: number | null = null;
  let calibrationMs: number | null = null;
  const effectsSeen = new Map<number, Effect>();

  const steps = Math.round(maxSeconds / PHYS.dt);
  for (let i = 0; i < steps; i++) {
    game.setInput(human.decide(game));
    game.step(PHYS.dt);
    if (game.phase === "playing") {
      model.sample(game, PHYS.dt);
      const p = game.progress;
      if (p > lifeBest + 0.03) {
        lifeBest = p;
        lifeBestAt = game.chamberClock;
      }
      cur.longestStuckMs = Math.max(cur.longestStuckMs, game.chamberClock - lifeBestAt);
    }
    const events = game.drainEvents();
    for (const e of events) {
      model.onEvent(e, game);
      human.onEvent(e, game);
      switch (e.type) {
        case "telegraph": {
          effectsSeen.set(e.effect.id, e.effect);
          cur.attacks++;
          const a = (cur.attackByAbility[e.effect.order.ability] ??= { n: 0, kills: 0 });
          a.n++;
          if (game.deathsHere >= 5) cur.attacksDuringStreak++;
          break;
        }
        case "death": {
          const eff = e.cause !== null ? (effectsSeen.get(e.cause) ?? game.effects.find((q) => q.id === e.cause)) : undefined;
          let causePhase: string | null = null;
          let sinceTelegraph: number | null = null;
          let sinceActive: number | null = null;
          if (eff && eff.startedAt !== null) {
            sinceTelegraph = game.clock - eff.startedAt;
            sinceActive = sinceTelegraph - eff.order.telegraphMs;
            causePhase = sinceActive < 0 ? "telegraph" : sinceActive < eff.activeMs ? "active" : "after";
            cur.kills++;
            cur.attackByAbility[eff.order.ability].kills++;
          }
          cur.deaths.push({
            chamber: game.chamber.index,
            template: game.chamber.template,
            at: Math.round(game.chamberClock),
            hole: e.holeId,
            cause: eff?.order.ability ?? null,
            causePhase,
            sinceTelegraph,
            sinceActive,
            sinceRespawn: Math.round(game.clock - respawnAt),
            tooFast: sinceTelegraph !== null && sinceTelegraph < budget,
          });
          lastDeathClock = game.clock;
          cur.maxDeathsHere = Math.max(cur.maxDeathsHere, game.deathsHere);
          if (inRelief({ chamber: game.chamber.index, isFinal: game.chamber.template === "MODEL", clock: game.clock, deathsHere: game.deathsHere, lastDeathAt: lastDeathClock, cleanChambers: 0, progress: 0, reactionMs: null, protectedUntil: 0 }))
            cur.reliefSeen = true;
          break;
        }
        case "respawn":
          respawnAt = game.clock;
          lifeBest = 0;
          lifeBestAt = game.chamberClock;
          break;
        case "checkpoint":
          cur.timeMs = Math.round(game.chamberClock);
          cur.cleared = true;
          if (game.chamber.index === 0) calibrationMs = cur.timeMs;
          break;
        case "chamber_start":
          if (e.chamber > 0) {
            cur = newStat();
            chambers.push(cur);
            respawnAt = game.clock;
            lifeBest = 0;
            lifeBestAt = 0;
          }
          break;
      }
    }
    director.tick(events);
    if (firstReadAt === null && game.chamber.index === 0) {
      const fr = director.log.find((l) => l.trigger === "first_read");
      if (fr) firstReadAt = Math.round(game.chamberClock);
    }
    if (i % 24 === 0) await new Promise((r) => setImmediate(r));
    if (game.phase === "won") break;
  }
  if (!cur.cleared) cur.timeMs = Math.round(game.chamberClock);
  void TIMING;
  return { skill, seed, won: game.phase === "won", timeMs: Math.round(game.clock), deaths: game.totalDeaths, chambers, firstReadAt, calibrationMs };
}

// ------------------------------------------------------------------ report
const med = (xs: number[]) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const f1 = (n: number) => (Number.isFinite(n) ? n.toFixed(1) : "-");

function report(results: RunResult[]) {
  const skill = results[0].skill;
  const won = results.filter((r) => r.won).length;
  console.log(`\n=== ${skill.toUpperCase()} (${results.length} runs) — cleared ${won}/${results.length}, median run ${f1(med(results.map((r) => r.timeMs / 1000)))}s, median deaths ${med(results.map((r) => r.deaths))}`);
  console.log(`  calibration: median ${f1(med(results.map((r) => (r.calibrationMs ?? NaN) / 1000)))}s; first_read fired in ${results.filter((r) => r.firstReadAt !== null).length}/${results.length} runs at ${results.map((r) => (r.firstReadAt === null ? "-" : (r.firstReadAt / 1000).toFixed(1))).join(",")}s`);
  console.log("  pos  template     reached  time(med s)  deaths(mean/run)  rig-deaths  attacks  kill%  <2.5s-respawn  tooFast  stuck(max s)  relief  streak-atk");
  for (let pos = 0; pos < 5; pos++) {
    const cs = results.map((r) => r.chambers[pos]).filter(Boolean);
    if (!cs.length) continue;
    const deaths = cs.flatMap((c) => c.deaths);
    const rig = deaths.filter((d) => d.cause);
    const attacks = cs.reduce((a, c) => a + c.attacks, 0);
    const kills = cs.reduce((a, c) => a + c.kills, 0);
    const temps = [...new Set(cs.map((c) => c.template))].join("/");
    console.log(
      `  ${pos + 1}    ${temps.padEnd(12).slice(0, 26)} ${String(cs.length).padStart(4)}   ${f1(med(cs.filter((c) => c.cleared).map((c) => c.timeMs / 1000))).padStart(9)}   ${(deaths.length / cs.length).toFixed(1).padStart(10)}       ${String(rig.length).padStart(6)} (${deaths.length ? Math.round((100 * rig.length) / deaths.length) : 0}%)  ${String(attacks).padStart(5)}   ${attacks ? Math.round((100 * kills) / attacks) : 0}%`.padEnd(100) +
        `${String(deaths.filter((d) => d.sinceRespawn < 2500).length).padStart(6)}   ${String(rig.filter((d) => d.tooFast).length).padStart(6)}   ${f1(Math.max(...cs.map((c) => c.longestStuckMs)) / 1000).padStart(9)}   ${cs.filter((c) => c.reliefSeen).length}   ${cs.reduce((a, c) => a + c.attacksDuringStreak, 0)}`,
    );
  }
  // per-ability lethality
  const ab: Record<string, { n: number; kills: number }> = {};
  for (const r of results) for (const c of r.chambers) for (const [k, v] of Object.entries(c.attackByAbility)) {
    ab[k] ??= { n: 0, kills: 0 };
    ab[k].n += v.n;
    ab[k].kills += v.kills;
  }
  console.log(`  ability kill rate: ${Object.entries(ab).map(([k, v]) => `${k} ${v.kills}/${v.n}`).join("  ")}`);
  const rigDeaths = results.flatMap((r) => r.chambers.flatMap((c) => c.deaths.filter((d) => d.cause)));
  const byPhase: Record<string, number> = {};
  for (const d of rigDeaths) byPhase[`${d.cause}:${d.causePhase}`] = (byPhase[`${d.cause}:${d.causePhase}`] ?? 0) + 1;
  console.log(`  rig deaths by phase: ${JSON.stringify(byPhase)}`);
  console.log(`  too-fast rig deaths (telegraph→death < reaction budget): ${rigDeaths.filter((d) => d.tooFast).map((d) => `${d.template}/${d.cause}@${d.sinceTelegraph}ms`).join(", ") || "none"}`);
  const holeCounts: Record<string, number> = {};
  for (const r of results) for (const c of r.chambers) for (const d of c.deaths) holeCounts[`${d.template}:${d.hole}`] = (holeCounts[`${d.template}:${d.hole}`] ?? 0) + 1;
  console.log(`  deadliest holes: ${Object.entries(holeCounts).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k}×${v}`).join(" ")}`);
  console.log(`  per run: ${results.map((r) => `s${r.seed}:${r.won ? "W" : "x"}${(r.timeMs / 1000).toFixed(0)}s/${r.deaths}d[${r.chambers.map((c) => `${c.template.slice(0, 3)}${c.deaths.length}`).join(" ")}]`).join("  ")}`);
}

async function main() {
  const args = process.argv.slice(2);
  const which = args.find((a) => !a.startsWith("--")) ?? "all";
  const nSeeds = Number(args[args.indexOf("--seeds") + 1]) || 8;
  const maxS = Number(args[args.indexOf("--max") + 1]) || 900;
  const skills: HumanSkill[] = which === "all" ? ["novice", "average", "good"] : [which as HumanSkill];
  for (const s of skills) {
    const results: RunResult[] = [];
    for (let k = 0; k < nSeeds; k++) results.push(await humanRun(s, 11 + k * 17, maxS));
    report(results);
    if (args.includes("--json")) console.log(JSON.stringify(results));
  }
}

if (process.argv[1]?.endsWith("human-sim.ts")) void main();
