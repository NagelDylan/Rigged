# RIGGED — submission write-up

**You control the bar. RIG controls everything else.**

## What I built

RIGGED is a desktop browser physics arcade game. You hold two motor controls, one per end of a steel bar (`W`/`S` and `↑`/`↓`), and roll a ball up through five oddly shaped chambers into an exit, avoiding every other hole. The mechanic comes from Ice Cold Beer; the original identity, art, sound and opponent are mine.

The opponent is **RIG**, the arcade cabinet itself, played by Claude. RIG never controls a character. It controls the machine:
* it slides holes into your lane;
* it shoves the ball;
* it presses walls inward;
* it magnetises holes;
* it jams your motors.

It watches how you play and calls out real habits, such as "Right wall. 78% of the time." It seals a prediction before it acts and is graded on it in front of you. When you adapt it gets annoyed and changes its mind. The last chamber, **MODEL**, is assembled from its model of you: holes are punched where your ball habitually rested, a trap lane is built on your favourite side, and the exit sits on your weak side. When you return, it remembers you.

A run takes about 3–5 minutes. Dying only resets the current chamber.

## How the agent decides

The architecture keeps the LLM out of the real-time loop:

```
input → deterministic 120 Hz engine → player model → director (when to ask)
      → Claude: structured decision → validator → fairness director → engine executes
      → outcome evaluator grades RIG's prediction → fed into the next decision
```

1. **Player model.** The engine's raw play becomes about ten features that matter:
   * lane bias, including a recent window that detects a switch;
   * which wall you park on;
   * your panic direction after a telegraph;
   * reaction time;
   * correction rate;
   * motor share;
   * style;
   * a per-ability kill and evade record.

   Every feature carries a confidence and a sample count.
2. **Event-driven calls.** RIG is consulted on events, not frames: the first read in calibration, a prediction resolving, a contradiction, a death, a chamber start, a confidence threshold, idle, next-chamber planning, the final plan and run end. That comes to roughly 15–30 calls per run, one in flight at a time. While RIG's own experiment is running, routine triggers are held.
3. **Structured decision.** Claude returns JSON:
   * an observation;
   * a hypothesis (new, reinforce, revise or abandon) about one model field;
   * an intent (probe, exploit, bait, hold or relief);
   * one legal ability or `WAIT`, with side, intensity, telegraph and a trigger (`now`, `ball_enters` a lane, or a `progress` height);
   * a **falsifiable prediction** with its own probability and a naive baseline;
   * a 2–8 word taunt grounded in a named metric;
   * optionally, the next chamber, chosen to test its least-certain strong belief.

   Triggers let RIG pre-arm a punishment for a move it expects, which also hides the roughly 3 s model latency.
4. **Validation and fairness.** A validator clamps and repairs the output:
   * illegal abilities become WAIT;
   * exploit at low confidence becomes probe;
   * a taunt that names the wrong side is replaced;
   * repeated sentence shapes are varied;
   * profanity is removed.

   A deterministic fairness director then decides what actually runs:
   * cooldowns and a one-hazard limit;
   * telegraph floors (0.95–1.2 s, longer for slow reactors);
   * spawn protection;
   * relief after repeated deaths and escalation for dominant players;
   * a repetition veto and staleness rejection;
   * per-chamber geometry that RIG cannot author, with solvability flood-filled.
5. **Evaluate and update.** After the window closes, a deterministic evaluator grades the sealed prediction as SUPPORTED, WEAKENED, TRIVIAL or VOID.
   * A prediction that merely restates a habit the player already shows more than 80% of the time is graded TRIVIAL. The baseline is computed from the player's own history, not RIG's self-report.
   * The verdict appears in the terminal ("SEALED 4.1s AGO: YOU FLEE RIGHT — CORRECT") and in the next observation.
   * RIG revises or abandons beliefs out loud, and the hypothesis ledger in Agent View (`D`) shows the history.
6. **Memory.**
   * SQLite stores anonymous players, runs, every decision and significant events, plus an aggregated memory: lane bias as an exponential moving average, panic and wall counts, reaction time, ability record, resting-spot histogram, and RIG's own notes.
   * At run end, Claude writes notes against its real scorecard; an honesty guard stops it claiming a record it didn't earn.
   * The next run starts with that memory as a prior.

The local RIG follows the same loop, schema and validators deterministically. It is the fallback when no key is set or a live call fails, and it is used in all automated tests.

## Tools

* **Client:** TypeScript, React (UI chrome only), and a custom canvas renderer with a custom 5×7 bitmap font. There is no game engine and no physics library; the physics is a hand-written one-dimensional "ball on a bar" model. Audio is procedural WebAudio. Vite builds it.
* **Server:** Node (`node:http`), SQLite via `better-sqlite3`, the Anthropic TypeScript SDK and zod.
* **Models:**
  * `claude-sonnet-5-5` makes in-play decisions, measured at about 3 s at low effort against about 5 s for Opus 5.5.
  * `claude-opus-5-5` makes the final MODEL plan and the end-of-run memory, where latency is hidden.
  * Requests use structured JSON-schema outputs, prompt caching and server-side refusal fallbacks.
* **Testing:**
  * Vitest: 104 unit and integration tests, including fairness red-team invariants and a faked SDK.
  * Playwright: end-to-end tests.
  * Headless simulations with behavioural bot profiles (right-hugger, left-hugger, cautious, aggressive, adapter) and human-like bots with reaction delay and key quantisation.
* **Build process:** I built it with Claude Code. Specialist subagents covered game design critique, rendering, audio, gameplay tuning, agent/server layer, red-team QA and adversarial product review, and I synthesised and integrated their work.

## Deliberate design choices

* **The boss is the level.** RIG has no avatar; it touches the machine you are reading, and green corruption marks everything it touches. That keeps the AI's actions physical, legible and inseparable from the game.
* **Predictions, not claims.** "The AI learns you" is cheap to say. RIG has to commit to a prediction before acting, and the game grades it. Being visibly wrong, getting irritated ("Hm. Not that time.") and revising is what makes it feel like a player.
* **LLM for strategy, code for physics and fairness.** Claude decides beliefs, experiments, abilities, timing triggers and chamber choice. Deterministic code owns physics, telegraphs, fairness and geometry. An outage downgrades RIG to the local strategist rather than breaking the game.
* **Taunts must be verifiable.** Taunts only use numbers from the telemetry, and side claims are checked. You trust "Right wall. 71%." because you know it's true.
* **Tuned against simulated humans.** Physics and layouts were tuned so an average simulated human clears a run in about 3–4 minutes with a few deaths. RIG never gets credit for a death it didn't cause, and no RIG death happens faster than human reaction time.
* **Calibration teaches by playing.** There is no tutorial: the keys are printed on the motor housings, and the first chamber is generous while RIG mostly watches and then calls you out.

## What I'd do next

* **Combo plans:** a `followUp` step so RIG can bait with one ability and punish the escape with a second.
* **A personal opening book:** start each run with whatever killed you last time.
* **A prompt eval harness:** scripted player profiles measuring prediction lift (live vs local) across prompt versions, to tune RIG quantitatively.
* **Hosted persistence:** a libSQL adapter plus a shareable "RIG's dossier on you" page.
* **Gamepad analog triggers** for the motors, and more chamber templates.
