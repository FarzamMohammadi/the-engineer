import os from "node:os";
import type { UserConfig } from "vitest/config";

const isCi = process.env["CI"] === "true";

const baseConfig: UserConfig = {
  test: {
    pool: "forks",
    globals: true,
    environment: "node",
    passWithNoTests: true,
    unstubEnvs: true,
    unstubGlobals: true,
    setupFiles: ["test/setup.ts"],

    // Worker scaling: aggressive locally, conservative in CI
    maxWorkers: isCi
      ? Math.min(2, Math.max(1, Math.floor(os.cpus().length * 0.25)))
      : Math.max(4, Math.min(16, os.cpus().length)),

    // Coverage (v8, enforced via pnpm test:coverage only)
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      all: false,
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 55,
        statements: 70,
      },
      include: ["src/**/*.ts"],
      exclude: [
        "src/index.ts",
        "src/cli/**",
        "src/core/daemon/**",
        "src/plugins/**",
        "src/config/watcher.ts",
        "src/db/migrations/**",
        "test/**",
        "src/**/*.test.ts",
      ],
    },
  },

  resolve: {
    alias: {
      "@": new URL("./src", import.meta.url).pathname,
    },
  },
};

export function getConfig(overrides?: UserConfig): UserConfig {
  return {
    ...baseConfig,
    ...overrides,
    test: {
      ...baseConfig.test,
      ...overrides?.test,
    },
    resolve: {
      ...baseConfig.resolve,
      ...overrides?.resolve,
    },
  };
}
