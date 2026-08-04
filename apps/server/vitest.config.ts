import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

process.env.NOVEL_STUDIO_DATA_DIR = mkdtempSync(resolve(tmpdir(), "novel-studio-tests-"));

export default defineConfig({
  test: {
    fileParallelism: false,
  },
});
