// Headless agent evaluation: run full RIGGED runs with behavioural bot
// profiles against the deterministic local RIG and report what RIG learned.
//   npm run sim -- [profile|all] [--runs N] [--verbose]
import { Director } from "../src/agent/director";
import { LocalTransport } from "../src/agent/transport";
import { PHYS } from "../src/engine/constants";
import { Game } from "../src/engine/game";
import { PlayerModel } from "../src/engine/playerModel";
import { Bot, PROFILES } from "../src/engine/bot";

export async function simulateRun(profileKey: string, seed = 11, maxSeconds = 600) {
  const profile = PROFILES[profileKey];
  const game = new Game(Director.firstChamber(seed));
  const model = new PlayerModel();
  const director = new Director({ game, model, transport: new LocalTransport(), memory: null, seed, now: () => game.clock });
  const bot = new Bot(profile);
  const steps = Math.round(maxSeconds / PHYS.dt);
  for (let i = 0; i < steps; i++) {
    game.setInput(bot.decide(game));
    game.step(PHYS.dt);
    if (game.phase === "playing") model.sample(game, PHYS.dt);
    const events = game.drainEvents();
    for (const e of events) {
      model.onEvent(e, game);
      bot.onEvent(e, game);
    }
    director.tick(events);
    if (i % 12 === 0) await new Promise((r) => setImmediate(r));
    if (game.phase === "won") break;
  }
  return { game, model, director };
}

async function main() {
  const args = process.argv.slice(2);
  const which = args.find((a) => !a.startsWith("--")) ?? "all";
  const verbose = args.includes("--verbose");
  const keys = which === "all" ? Object.keys(PROFILES) : [which];
  for (const k of keys) {
    const { game, model, director } = await simulateRun(k);
    const s = model.snapshot();
    console.log(`\n=== ${PROFILES[k].name} === phase=${game.phase} chamber=${game.chamber.index + 1} deaths=${game.totalDeaths} time=${(game.clock / 1000).toFixed(1)}s`);
    console.log(`lane L${s.laneBias.v.L} C${s.laneBias.v.C} R${s.laneBias.v.R} | wall L${s.wallPark.v.L} R${s.wallPark.v.R} (${s.wallPark.v.side}) | panic ${JSON.stringify(s.panicDirection.v)} | react ${s.reactionMs.v} | style ${s.style.v.label} | corr ${s.correctionRate.v} | adapt ${JSON.stringify(s.adaptation.v)}`);
    console.log(`chambers: ${director.stats.map((c) => `${c.template}(${c.deaths}d ${(c.timeMs / 1000).toFixed(0)}s)`).join(" → ")}`);
    console.log(`calls: ${JSON.stringify(director.calls)} | ledger: ${director.ledger.map((l) => `${l.id}[${l.field} ${l.confidence} +${l.supported}/-${l.weakened} ${l.status}] "${l.claim}"`).join(" | ")}`);
    const acts = director.log.filter((l) => l.decision).map((l) => `${l.decision!.action.ability}${l.decision!.action.side ?? ""}:${l.ruling.split(":")[0]}${l.outcome ? "→" + l.outcome.verdict : ""}`);
    console.log(`actions: ${acts.join(", ")}`);
    if (verbose) {
      for (const l of director.lines) console.log(`  [${l.kind}] ${l.text}`);
      for (const l of director.log) console.log(`  ${l.id} ${l.trigger} ${l.decision ? `"${l.decision.hypothesis.claim}" → ${l.decision.action.ability} ${l.decision.action.side} ${l.decision.action.trigger.type}` : l.ruling} | ${l.ruling} | ${l.outcome ? l.outcome.verdict + " " + l.outcome.observed : ""}`);
    }
  }
}

if (process.argv[1]?.endsWith("simulate.ts")) void main();
