import { defineConfig } from "vitest/config";
import { getConfig } from "./vitest.shared.js";

export default defineConfig(
  getConfig({
    test: {
      include: ["tests/integration/**/*.integration.test.ts"],
    },
  }),
);
