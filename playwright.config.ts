import { defineConfig, devices } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "novel-studio-e2e-"));
const port = 8891;

process.once("exit", () => rmSync(dataDir, { recursive: true, force: true }));

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  expect: { timeout: 7_000 },
  fullyParallel: false,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "npm run build && npm start",
    url: `http://127.0.0.1:${port}/api/health`,
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      NOVEL_STUDIO_DATA_DIR: dataDir,
      PORT: String(port),
    },
  },
  projects: [{ name: "desktop-chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } }],
});
