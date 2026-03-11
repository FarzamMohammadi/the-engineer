import { defineConfig } from "vitest/config";
import { getConfig } from "./vitest.shared.js";

export default defineConfig(
  getConfig({
    test: {
      include: ["src/**/*.test.ts", "test/boundary/**/*.test.ts", "test/helpers/**/*.test.ts"],
      exclude: ["**/*.integration.test.ts", "**/*.e2e.test.ts"],
    },
  }),
);
