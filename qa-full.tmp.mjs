import { chromium } from "@playwright/test";
const [,, OUT, PORT, PROFILE, SPEED, TAG] = process.argv;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errs = [];
page.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
page.on("pageerror", (e) => errs.push("pageerror: " + e));
await page.goto(`http://localhost:${PORT}/?speed=${SPEED}`);
await page.waitForTimeout(1500);
await page.keyboard.press("Space");
await page.evaluate((p) => window.__rigged.setAutopilot(p), PROFILE);
let shot = 0, lastCh = -1, modelShot = false;
const t0 = Date.now();
while (Date.now() - t0 < 600000) {
  await page.waitForTimeout(1000);
  const s = await page.evaluate(() => ({ screen: window.__rigged.screen, ch: window.__rigged.game?.chamber.index, tpl: window.__rigged.game?.chamber.template, cc: window.__rigged.game?.chamberClock, phase: window.__rigged.game?.phase }));
  if (s.ch !== lastCh) { lastCh = s.ch; }
  if (s.tpl === "MODEL" && !modelShot && s.cc > 1200) { modelShot = true; await page.screenshot({ path: `${OUT}/${TAG}-model.png` }); }
  if (s.screen === "win" && shot === 0) { shot = 1; await page.waitForTimeout(300); await page.screenshot({ path: `${OUT}/${TAG}-offline.png` }); await page.waitForTimeout(2600); await page.screenshot({ path: `${OUT}/${TAG}-no.png` }); }
  if (s.screen === "summary") { await page.waitForTimeout(6000); await page.screenshot({ path: `${OUT}/${TAG}-summary.png` }); break; }
}
const st = await page.evaluate(() => {
  const d = window.__rigged.director;
  return {
    screen: window.__rigged.screen, deaths: window.__rigged.game?.totalDeaths, time: window.__rigged.game?.clock, calls: d.calls, stats: d.stats,
    final: d.finalPlan, runEnd: d.runEnd,
    lines: d.lines.map(l => `${l.kind}${l.source ? "(" + l.source + ")" : ""}: ${l.text}`),
    log: d.log.map(l => `${l.id} c${l.chamber+1} ${l.trigger} ${l.source} ${l.latencyMs}ms fb=${l.fallbackReason} | ${l.decision ? `THINKS ${l.decision.hypothesis.claim} (${l.decision.hypothesis.status} ${l.decision.hypothesis.field} ${l.decision.hypothesis.confidence}) | ${l.decision.intent} ${l.decision.action.ability} ${l.decision.action.side} ${l.decision.action.trigger.type} | PRED ${l.sealed} | "${l.decision.taunt}"` : l.digest} | ${l.ruling} | ${l.outcome ? l.outcome.verdict + " " + l.outcome.observed : ""}`),
  };
});
console.log(JSON.stringify(st, null, 1));
console.log("ERRORS", errs);
await browser.close();
