# RIGGED — internal design (v0, pre-build)

Tagline: You control the bar. RIG controls everything else.

## Pillars
1. The two-motor bar feels physical and learnable within 10 seconds.
2. RIG visibly *watches*, says something specific and true, then uses it.
3. Every RIG action is telegraphed, deterministic, fair, and explainable from its model of you.

## Stack
- Vite + React (DOM only for HUD / RIG terminal / overlays) + one `<canvas>` for the machine.
- Pure-TS headless engine (`src/engine/*`) — no DOM — fixed timestep 120 Hz. Used by browser, unit tests and simulation bots.
- Single Node server (`server/*`): node:http + Vite middleware in dev, static `dist/` in prod. `POST /api/rig/decide`, `/api/run/*`, `/api/profile`.
- SQLite via better-sqlite3 behind a `Store` interface (in-memory fallback if the DB cannot open).
- Anthropic TS SDK, structured JSON output, server-side only. Mock (deterministic) RIG when no key.

## Physics (src/engine/physics.ts)
- Bar spans full machine width W. Two endpoints with heights yL, yR (world units, y up). Motors move endpoints at MOTOR_SPEED with a short accel ramp; |yR−yL| ≤ MAX_DIFF (motor strains at the limit).
- Ball is 1-D along the bar: x, vx. a = G·slope − FRICTION·vx + external forces (RIG). Ball world y = barY(x) + R.
- Chamber geometry yields allowed horizontal intervals at height y (outer profile minus islands). Ball is clamped to its interval with restitution bounce; intervals that shrink push the ball.
- Holes are circles on the backboard. Ball center within (holeR − capture margin) → falls. Exit is a hole with a distinct, animated, chevron-marked frame.
- Bar heights clamped to [chamber.bottom, chamber.top].

## Chambers (src/engine/chambers.ts)
Authored templates with parameters (never free geometry). Profile = piecewise-linear half-width + center offset over height, plus optional islands (dividers). Hole layouts are authored slot lists in normalized coords; parameters toggle optional slots / bias them to a side; validator enforces min passable gap.
- 01 CALIBRATION (rectangle, generous) — RIG only watches + one gentle probe.
- Middle 3 chosen by RIG from: FUNNEL, SPLITTER (two lanes around a divider), EYE (round), HOURGLASS, TOWER.
- 05 MODEL — assembled by RIG from validated components targeting the player's strongest tendencies.

## RIG abilities (deterministic executors, src/engine/abilities.ts)
Each: telegraph (≥ min ms, green corruption on the touched object + unique sound) → active → end, cooldown, logged outcome.
- SHIFT — possess a hole, slide it toward a region (never under the ball, keeps min gap).
- PULSE — directional shove across the chamber (arrows on rails during telegraph).
- CRUSH — one side wall presses inward temporarily.
- MAGNET — a hole pulls the ball laterally while active (particles spiral in).
- JAM — one motor runs at reduced speed / sticks briefly (motor housing sparks).
- BAIT (maybe) — shuttered holes: RIG makes a lane look clean, then opens a telegraphed lid ahead of the ball.
Trigger: `now` | `ball_enters:<left|center|right>` | `progress:<0..1>` — lets RIG arm a punishment for a predicted escape.

## Player model (src/engine/playerModel.ts) — only fields that change strategy
laneBias (L/C/R share, normalized to available width), panicDirection (net motion in 1.2 s after telegraph), reactionMs (telegraph → first input change), style (aggressive/cautious from climb rate, speed, stationary %), correctionRate (tilt reversals / s), motorShare (L vs R), wallHug %, exitApproach side, per-ability record (used / killed / evaded), death causes, adaptation (bias before vs after a callout). Each with confidence from sample size.

## Agent loop
Client Director (deterministic) decides WHEN to ask RIG: chamber start, model confidence threshold crossed, action resolved, death, contradiction, 12 s idle, ~55 % progress (plan next chamber), final chamber. Cap ~25 calls/run, one in flight, timeouts 8 s.
Observation (compact JSON) → server → Claude (or mock) → structured decision:
```
{ observation, hypothesis:{claim, basis, confidence}, strategy, action:{ability|WAIT, target, intensity, telegraphMs, trigger}, prediction:{playerWill}, taunt, nextChamber? }
```
Server: schema validation + clamps. Client Fairness Director: cooldowns, min telegraph, pressure budget, no hazard under ball, spawn protection after reset, death-streak relief, staleness (epoch = chamber+life) rejection.
Outcome evaluator (deterministic): did the prediction happen? → SUPPORTED / WEAKENED / INCONCLUSIVE, fed into the next call.

## Persistence
players, runs, chambers, events (significant only), decisions, player_memory (aggregated JSON + RIG's own terse memory notes written at run end). Next run starts with prior as evidence.

## Presentation
Industrial 80s cabinet gone self-aware. Near-black, dirty metal, off-white mechanics, amber warnings, restrained red, RIG = monochrome terminal green. Green corruption = RIG is touching this. Infection grows per chamber. Custom bitmap font on canvas; terminal font in DOM. Light CRT. Agent View on `D`.
