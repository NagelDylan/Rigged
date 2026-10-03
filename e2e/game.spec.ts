import { expect, test, type Page } from "@playwright/test";

const errors: string[] = [];
function watchConsole(page: Page) {
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(String(e)));
}

test.beforeEach(() => {
  errors.length = 0;
});

async function boot(page: Page, url = "/") {
  await page.goto(url);
  await page.waitForFunction(() => !!window.__rigged?.renderer && !!window.__rigged?.session);
}

test("title → play: controls move the motors, RIG speaks, arrows don't scroll", async ({ page }) => {
  watchConsole(page);
  await boot(page);
  await expect(page.locator("canvas.machine")).toBeVisible();
  await expect(page.getByText("PRESS SPACE TO INSERT PLAYER")).toBeVisible();
  await page.keyboard.press("Space");
  await expect(page.locator(".term")).toContainText(/Show me how you move|I remember you/, { timeout: 5000 });
  const y0 = await page.evaluate(() => window.__rigged!.game!.bar.yL);
  await page.keyboard.down("KeyW");
  await page.waitForTimeout(500);
  await page.keyboard.up("KeyW");
  const y1 = await page.evaluate(() => window.__rigged!.game!.bar.yL);
  expect(y1).toBeGreaterThan(y0 + 20);
  await page.keyboard.down("ArrowUp");
  await page.waitForTimeout(300);
  await page.keyboard.up("ArrowUp");
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  expect(await page.evaluate(() => window.__rigged!.game!.bar.yR)).toBeGreaterThan(y0 + 10);
  expect(errors).toEqual([]);
});

test("agent view toggles and explains RIG", async ({ page }) => {
  watchConsole(page);
  await boot(page);
  await page.keyboard.press("Space");
  await page.keyboard.press("KeyD");
  await expect(page.locator(".agentview")).toBeVisible();
  await expect(page.locator(".agentview")).toContainText("Player model");
  await expect(page.locator(".agentview")).toContainText("Hypothesis ledger");
  await page.keyboard.press("KeyD");
  await expect(page.locator(".rig")).toBeVisible();
  expect(errors).toEqual([]);
});

test("blur pauses the machine", async ({ page }) => {
  await boot(page);
  await page.keyboard.press("Space");
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expect(page.getByText("MACHINE IDLE")).toBeVisible();
  expect(await page.evaluate(() => window.__rigged!.game!.phase)).toBe("paused");
});

test("full run with autopilot reaches the summary and memory persists", async ({ page }) => {
  watchConsole(page);
  await boot(page, "/?speed=6&seed=42");
  await page.keyboard.press("Space");
  await page.evaluate(() => window.__rigged!.setAutopilot("right"));
  await expect(page.locator(".summary")).toBeVisible({ timeout: 200_000 });
  await expect(page.locator(".summary")).toContainText("YOU ESCAPED");
  await expect(page.locator(".summary")).toContainText("RIG LEARNED");
  // memory written server-side; a reload sees the previous run
  await page.waitForTimeout(1500);
  await page.reload();
  await page.waitForFunction(() => !!window.__rigged?.renderer && !!window.__rigged?.session);
  await page.keyboard.press("Space");
  await expect(page.locator(".term")).toContainText("I remember you.", { timeout: 5000 });
  expect(errors).toEqual([]);
});
