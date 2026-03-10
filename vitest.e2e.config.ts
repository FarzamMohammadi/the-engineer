import { defineConfig } from "vitest/config";
import { getConfig } from "./vitest.shared.js";

export default defineConfig(
  getConfig({
    test: {
      include: ["test/e2e/**/*.e2e.test.ts"],
      maxWorkers: 1,
      minWorkers: 1,
    },
  }),
);
