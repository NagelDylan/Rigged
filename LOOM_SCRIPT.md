# RIGGED — Loom script (target 2:45, hard cap 3:00)

## Setup (before recording)

* Run `npm run dev` with `ANTHROPIC_API_KEY` set. The top strip should read **RIG LIVE**.
* Use a **fresh browser profile** (or clear localStorage), so RIG meets you as a new subject. Recording the memory beat needs one finished run first; see 2:25.
* Open `http://localhost:5173/?seed=7`. The seed fixes the chamber layouts; RIG's decisions stay live.
* Use a desktop window of 1440×900 or larger. Turn sound on.
* Practise twice. The reliable demo behaviour is to **park on the right wall in calibration**: tap `W` (left end up) until the ball rolls right, then level the bar and leave it resting against the right wall. RIG reliably names it ("Right wall…") within about 15 s and usually spends its calibration probe testing it.

## Shot list and talking points

| Time | On screen | Say (roughly) |
|---|---|---|
| **0:00–0:15** | Title screen with the eye tracking. Press Space; the calibration chamber opens on the EXIT, then pans down to the bar. | "This is RIGGED. It's a physics arcade game where I control the bar, with two motors, one per side. The AI, RIG, controls the rest of the machine." |
| **0:15–0:35** | Tap W/S and ↑/↓. The ball rolls and the motors visibly work. Steer around the first holes, then park the ball on the **right wall** and sit there. Point at the **WATCHING YOU** meters filling up. | "The ball rolls toward the low end. The goal is the exit; every other hole kills you. RIG is quiet in this first chamber; it's calibrating. Those meters are what it's measuring: which wall I lean on, which lane, how I react." |
| **0:35–0:55** | RIG's first read: "Right wall. …%" → **PREDICTION SEALED #…** → the right wall turns green and presses in (CRUSH) → **SEALED 4.0s AGO: … — CORRECT** stamp. | "And there it is. It noticed I park on the right, and that's true. It seals a prediction *before* acting, attacks the habit, and the game grades it. That's a real claim about me, not a canned line." |
| **0:55–1:20** | Press **D** for Agent View. Point at the player model (lane bias, wall parking, with evidence), *RIG now* (hypothesis, strategy, action, prediction), the ledger, and one decision-log entry (SAW / THINKS / DOES / PREDICTS / RESULT / DIRECTOR). | "Agent View shows the loop. Deterministic telemetry goes in; Claude returns a structured decision: a hypothesis, an action with a trigger, and a falsifiable prediction. A fairness director can veto or clamp it. Then an evaluator grades the prediction and feeds the result back in." |
| **1:20–1:50** | Back to the game (D). In chamber 2, deliberately **switch**: play on the left for 15–20 s. Wait for a WRONG stamp or a line like "Fine. Not just right." In Agent View, show the hypothesis revised or ABANDONED. | "Now I change my behaviour. Watch the ledger. Its prediction failed, it's annoyed, and it revised the belief instead of repeating the same attack. Predicting a habit I already show more than 80% of the time doesn't even count; it gets graded 'OBVIOUS'." |
| **1:50–2:10** | A visually different chamber (SPLITTER, EYE or HOURGLASS). Show one more ability telegraph, such as SHIFT (a hole turns green and slides) or PULSE (chevrons on the rails). Optionally die once to show how quick the reset is. | "RIG chose this chamber to test what it's least sure about, and the reason is in the log. Every attack is telegraphed, and green always means RIG is touching it. Deaths cost about one second; checkpoints are per chamber." |
| **2:10–2:25** | Chamber 5: the **MODEL** banner, "BUILT FROM m:ss OF YOU", holes punching in one by one, the reveal line. | "The last chamber is built from its model of me. Those holes are where my ball habitually stopped, and the comfortable lane is the trap." |
| **2:25–2:40** | Cut to the post-run summary: RIG LEARNED, WHERE YOU STOP, HYPOTHESES, MEMORY WRITTEN. Optionally show a second run opening with "I remember you." | "At the end it writes memory notes against its real scorecard. Next run it starts from them, as a prior, not a certainty." |
| **2:40–2:55** | Architecture: the README diagram, or Agent View again. | "Architecture: a deterministic 120 Hz engine handles physics. Telemetry becomes a compact player model. Claude plays RIG at the strategic level through validated structured actions. A fairness layer keeps it beatable, and SQLite gives it continuity. With no API key, a deterministic local RIG plays the same loop." |
| **2:55–3:00** | Summary screen with PLAY AGAIN. | "It's called RIGGED. It learns how you play." |

## Fallbacks during recording

* **If RIG's first read is slow** (live latency is about 3–4 s), keep parking. The callout normally lands between 12 and 20 s.
* **If the probe doesn't happen in calibration**, the first attack comes at the start of chamber 2. Narrate the sealed prediction there instead.
* **If you want a fully reproducible take**, run without a key (`RIG_MODE=local npm run dev`). The local RIG plays the same loop deterministically; mention that it is the fallback.
* **Don't scroll code.** The README carries the architecture.
