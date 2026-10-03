import { defineConfig } from "@playwright/test";

const PORT = 5310;
export default defineConfig({
  testDir: "e2e",
  timeout: 240_000,
  fullyParallel: false,
  workers: 1,
  use: { baseURL: `http://localhost:${PORT}`, viewport: { width: 1440, height: 900 } },
  webServer: {
    // automated tests always use the deterministic local RIG: no API credits spent
    command: `RIG_MODE=local RIGGED_DB_PATH=test-results/e2e.db PORT=${PORT} npx tsx server/index.ts`,
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
