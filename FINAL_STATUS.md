# FINAL STATUS

## What is complete

* **The game.**
  * Two-motor bar physics: deterministic, 120 Hz, and tuned against simulated human reaction times.
  * Five chambers: CALIBRATION, then three that RIG picks from FUNNEL / SPLITTER / EYE / HOURGLASS / TOWER, then MODEL, which is personalised.
  * Per-chamber checkpoints with a death and reset of about one second.
  * An exit intro pan and an off-screen exit marker.
  * Win sequence: "RIG OFFLINE" → "...no.", followed by the post-run summary.
* **RIG agent.**
  * The live path uses Claude through structured JSON output: Sonnet 5.5 for tactics, Opus 5.5 for the MODEL plan and the run-end memory.
  * The deterministic local RIG has the same loop, schema and validators.
  * Event-driven director with a hypothesis ledger.
  * Sealed predictions graded by a deterministic evaluator; "OBVIOUS" is judged against an empirical baseline.
  * A fairness director: cooldowns, telegraph floors, relief, escalation, a repetition veto and staleness rejection.
  * Five telegraphed abilities: SHIFT, PULSE, CRUSH, MAGNET and JAM.
  * Taunts are grounded and kept varied by checks in code.
  * An honesty guard on the run-end verdict.
* **Persistence.**
  * SQLite with automatic migrations: players, runs, decisions and events, plus aggregated memory and RIG's notes.
  * The next run greets you from that memory.
  * If the database fails, the server falls back to an in-memory store.
* **Presentation.**
  * Original pixel-art cabinet renderer with a custom bitmap font and a green "corruption" language for RIG.
  * Infection grows across chambers.
  * Light CRT treatment and procedural WebAudio.
  * RIG terminal with CORRECT / WRONG stamps.
  * Agent View (`D`), the summary screen, pause on blur, mute, and reduced-motion support.
* **Docs.** README.md, SUBMISSION.md, LOOM_SCRIPT.md, docs/DESIGN.md, docs/VISUAL_SPEC.md and `prompts/rig-system.md`, which can be inspected.

## How to run

```bash
cp .env.example .env     # optional: ANTHROPIC_API_KEY=...
npm install
npm run dev              # http://localhost:5173
```

You need Node ≥ 20. The database is created at `data/rigged.db` on first start.

## How to enable live RIG

Set `ANTHROPIC_API_KEY` in `.env`; the server also accepts `RIG_ANTHROPIC_API_KEY`. Then restart `npm run dev`. The top strip should show **RIG LIVE** and the startup log `RIG: LIVE claude-sonnet-5-5`. `RIG_MODE=local` forces the local RIG. `RIG_MODEL` and `RIG_PLANNER_MODEL` override the two models.

## Tests run and results (final pass)

* `npm test`: **104 passed**. Unit and integration coverage: engine and physics invariants, player model, prediction grading, fairness rules, fairness red-team invariants, director staleness, validator, local RIG profiles, the live adapter with a faked SDK, the SQLite store, and chamber solvability with bot clears.
* `npm run test:e2e`: **4 passed**. Covers title → controls (no page scroll) → RIG speaks → Agent View → pause on blur → a full autopilot run to the summary → "I remember you." after reload. Runs on the local RIG.
* `npm run build`: passes. A scan of the bundle found no SDK and no secrets.
* `npx tsx scripts/human-sim.ts all` (human-like bots, 5 seeds each, after tuning):

  | | Median run | Median deaths | Calibration | Runs cleared |
  |---|---|---|---|---|
  | Average | 215 s | 3 | 21 s | — |
  | Good | 183 s | 2 | — | — |
  | Novice | — | — | 31 s | 3/5 |

  There were 0 deaths caused faster than human reaction time, and 0 deaths within 2.5 s of a respawn.
* `npx tsx scripts/chamber-check.ts`: every bot profile clears every template and parameter combination.

## Manual and visual playtests performed

All of these were driven through Playwright with keyboard scripts and autopilot profiles, with screenshots reviewed at 1440×900, 1280×720 and 1920×1080:

* A novice-style first 45 s: hesitant taps, parking on a wall.
* Deliberately right-biased and left-biased runs; the model separates them (lane, wall, panic).
* Live Claude, an **adapter** run (right, then left): RIG noticed ("Fine. Not just right."), revised, then abandoned its lane belief.
* Live Claude, two runs in the same browser profile: run 2 opened "I remember you", and RIG noted "Memory says right; current data says left."
* Live Claude, the first 30 s: "Right wall. Every time so far." → CRUSH probe → "SEALED 4.0s AGO: YOU FLEE LEFT — CORRECT".
* Full runs to the summary, live and local, with no console errors and clean server logs.
* Independent adversarial-evaluator, red-team QA and UX reviews. Their findings were fixed: kill credit, off-screen SHIFT targets, wall-hugging holes, physics feel, hypothesis loops, dishonest verdicts, the recent-window signal, banner overlap and Agent View legibility.

## Deployment status

* **Deployed to Control Plane:** org `jakob-test-org` (test environment), GVC `rigged`, workload `rigged`, image `rigged:v2`, with a 10 GiB volume at `/app/data` for SQLite.
  * URL: https://rigged-enp8tj23m795p.t7659adkz8zq4.t.cpln.app
  * Verified: health OK, a full browser session plays with no console errors, and runs persist.
* **Location status:**
  * **aws-us-west-2** is ready and serving.
  * **aws-us-east-2** was the first location and never left "Initializing" in this test environment. The canonical URL routes around it. Removing it from the GVC is a one-line cleanup I left for you, because removing a location is a destructive change.
  * Each location keeps its own SQLite volume, so RIG's memory is per location.
* The deployed copy runs the **local RIG**, because no API key is configured there; I never handle the secret value.
* **To enable live RIG on the deployment:** create a secret in the Control Plane Console (for example `rigged-anthropic`, key `key`), then set the workload env `ANTHROPIC_API_KEY=cpln://secret/rigged-anthropic.key`. Before that, consider who can reach the public URL, because each live run costs a few cents.

## Known limitations

* Difficulty is tuned against *simulated* humans. Real players may need further tuning of `PHYS` in `src/engine/constants.ts` and of the chamber densities.
* RIG's abilities rarely kill expert or bot players. The fairness rules are deliberately conservative, and RIG says so ("Single traps never landed. Stack them.").
* Live tactical latency is about 3–4 s. Decisions that arrive after the context has changed are shown as STALE or VOID.
* Memory is per browser: the anonymous player id lives in localStorage.
* The game is built for a desktop keyboard; there are no touch controls.

## Best Loom demo path

See LOOM_SCRIPT.md:
1. Use a fresh profile, a live key, and `?seed=7`.
2. Park on the right wall in calibration, so RIG calls it out and probes.
3. Show Agent View.
4. Switch to the left in chamber 2, so RIG gets it WRONG and revises.
5. Show another ability.
6. Show the MODEL reveal ("BUILT FROM m:ss OF YOU").
7. Show the summary, and "I remember you." on run 2.
