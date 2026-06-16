import { defineConfig } from "vitest/config";
import { getConfig } from "./vitest.shared.js";

export default defineConfig(
  getConfig({
    test: {
      include: ["tests/unit/**/*.test.ts", "tests/architecture/**/*.test.ts", "tests/helpers/**/*.test.ts"],
      exclude: ["**/*.integration.test.ts", "**/*.e2e.test.ts"],
    },
  }),
);
