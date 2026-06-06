import { describe, expect, it } from "vitest";
import { parse as yamlParse } from "yaml";

import { EXAMPLE_SAFETY, SAFETY_TEMPLATE } from "../../../../src/cli/bundled/templates.js";
import { CostLimitsSchema } from "../../../../src/schemas/config.js";

// ── Safety Templates: Cost Limits ────────────────────────────────────────────
// These templates ship as ~/.engineer/config/safety.yaml. The loader parses them
// through SafetyConfigSchema with no strict/remap, so any key the schema does not
// recognize is silently stripped. A cost_limits block nested under a wrapper key
// the schema lacks (e.g. `api:` / `cli:`) would parse clean and leave every limit
// null — zero cost enforcement for a user on the shipped defaults. These tests pin
// the cost_limits structure to CostLimitsSchema, the exact schema the loader uses
// for that subtree: the USD limits must survive the parse as the intended numbers.

describe("safety template cost limits", () => {
  for (const [label, template] of [
    ["bundled SAFETY_TEMPLATE", SAFETY_TEMPLATE],
    ["EXAMPLE_SAFETY reference", EXAMPLE_SAFETY],
  ] as const) {
    describe(label, () => {
      const raw = yamlParse(template) as { cost_limits: Record<string, unknown> };
      const costLimits = CostLimitsSchema.parse(raw.cost_limits);

      it("keeps the USD limits the template shows instead of stripping them to null", () => {
        expect(costLimits.per_task.cost_usd).toBe(5.0);
        expect(costLimits.daily.cost_usd).toBe(25.0);
        expect(costLimits.monthly.cost_usd).toBe(250.0);
      });

      it("uses the flat providers map for per-provider request caps", () => {
        expect(costLimits.providers).toEqual({});
      });

      it("nests cost_limits under no wrapper key the schema does not know", () => {
        expect(raw.cost_limits).not.toHaveProperty("api");
        expect(raw.cost_limits).not.toHaveProperty("cli");
        expect(Object.keys(raw.cost_limits).sort()).toEqual(["daily", "monthly", "per_task", "providers"]);
      });
    });
  }
});
