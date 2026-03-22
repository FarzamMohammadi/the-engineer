import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { stringify as stringifyYaml } from "yaml";

import { type AdapterType, AdapterTypeSchema } from "../../schemas/adapters.js";

// ── Adapter Stub Templates ────────────────────────────────────────────────────

interface AdapterTemplate {
  baseClass: string;
  importPath: string;
  abstractMethods: string;
  contractSuite: string;
  contractFixtureType: string;
}

const ADAPTER_TEMPLATES: Record<AdapterType, AdapterTemplate> = {
  trigger: {
    baseClass: "TriggerAdapter",
    importPath: "../../../adapters/trigger.js",
    abstractMethods: `  protected async doPoll(): Promise<TriggerEvent[]> {
    // TODO: Implement polling logic
    return [];
  }

  protected async doInitialize(_config: Record<string, unknown>): Promise<InitResult> {
    return { success: true, message: null };
  }

  protected async doShutdown(): Promise<void> {
    // TODO: Cleanup resources
  }

  protected async doHealthCheck(): Promise<HealthStatus> {
    return { healthy: true, message: null, details: null };
  }`,
    contractSuite: "trigger-contract.js",
    contractFixtureType: "TriggerContractFixtures",
  },
  communication: {
    baseClass: "CommunicationAdapter",
    importPath: "../../../adapters/communication.js",
    abstractMethods: `  protected async doSendMessage(
    _target: Target,
    _message: FormattedMessage,
  ): Promise<SendResult> {
    // TODO: Implement send logic
    return { success: true, message_id: null, error: null };
  }

  doFormatMessage(content: string, type: MessageType): FormattedMessage {
    return { content, metadata: { task_id: null, type } };
  }

  protected async doInitialize(_config: Record<string, unknown>): Promise<InitResult> {
    return { success: true, message: null };
  }

  protected async doShutdown(): Promise<void> {
    // TODO: Cleanup resources
  }

  protected async doHealthCheck(): Promise<HealthStatus> {
    return { healthy: true, message: null, details: null };
  }`,
    contractSuite: "communication-contract.js",
    contractFixtureType: "CommunicationContractFixtures",
  },
  llm: {
    baseClass: "LLMAdapter",
    importPath: "../../../adapters/llm.js",
    abstractMethods: `  protected async doInfer(
    _request: InferenceRequest,
  ): Promise<InferenceResult> {
    // TODO: Implement LLM inference
    return {
      content: "",
      cost_usd: null,
      duration_ms: 0,
    };
  }

  getCapabilities(): LLMCapabilities {
    return {
      model_id: "custom",
    };
  }

  protected async doInitialize(_config: Record<string, unknown>): Promise<InitResult> {
    return { success: true, message: null };
  }

  protected async doShutdown(): Promise<void> {
    // TODO: Cleanup resources
  }

  protected async doHealthCheck(): Promise<HealthStatus> {
    return { healthy: true, message: null, details: null };
  }`,
    contractSuite: "llm-contract.js",
    contractFixtureType: "LLMContractFixtures",
  },
  tool: {
    baseClass: "ToolAdapter",
    importPath: "../../../adapters/tool.js",
    abstractMethods: `  describe(): ToolDescription {
    return {
      name: "custom-tool",
      description: "A custom tool",
      parameters: {},
      action_classes: ["read"],
    };
  }

  protected async doExecute(
    _action: string,
    _params: Record<string, unknown>,
    _context: ToolExecutionContext,
  ): Promise<ToolResult> {
    // TODO: Implement tool execution
    return { success: true, output: "", side_effects: [], error: null };
  }

  protected async doInitialize(_config: Record<string, unknown>): Promise<InitResult> {
    return { success: true, message: null };
  }

  protected async doShutdown(): Promise<void> {
    // TODO: Cleanup resources
  }

  protected async doHealthCheck(): Promise<HealthStatus> {
    return { healthy: true, message: null, details: null };
  }`,
    contractSuite: "tool-contract.js",
    contractFixtureType: "ToolContractFixtures",
  },
  git_hosting: {
    baseClass: "GitHostingAdapter",
    importPath: "../../../adapters/git-hosting.js",
    abstractMethods: `  protected async doCreatePR(_options: PROptions): Promise<PRResult> {
    throw new Error("Not implemented");
  }

  protected async doUpdatePR(
    _repo: string,
    _prNumber: number,
    _updates: PRUpdates,
  ): Promise<void> {
    throw new Error("Not implemented");
  }

  protected async doMergePR(
    _repo: string,
    _prNumber: number,
    _strategy: MergeStrategy,
  ): Promise<MergeResult> {
    throw new Error("Not implemented");
  }

  protected async doClosePR(_repo: string, _prNumber: number): Promise<void> {
    throw new Error("Not implemented");
  }

  protected async doGetPRStatus(_repo: string, _prNumber: number): Promise<PRStatus> {
    throw new Error("Not implemented");
  }

  protected async doGetReviewStatus(_repo: string, _prNumber: number): Promise<ReviewStatus> {
    throw new Error("Not implemented");
  }

  protected async doGetPRComments(_repo: string, _prNumber: number): Promise<PRComment[]> {
    throw new Error("Not implemented");
  }

  protected async doCommentOnPR(
    _repo: string,
    _prNumber: number,
    _body: string,
  ): Promise<CommentResult> {
    throw new Error("Not implemented");
  }

  protected async doGetBranchProtection(
    _repo: string,
    _branch: string,
  ): Promise<BranchProtection> {
    throw new Error("Not implemented");
  }

  async getDefaultBranch(_repo: string): Promise<string> {
    return "main";
  }

  protected async doInitialize(_config: Record<string, unknown>): Promise<InitResult> {
    return { success: true, message: null };
  }

  protected async doShutdown(): Promise<void> {
    // TODO: Cleanup resources
  }

  protected async doHealthCheck(): Promise<HealthStatus> {
    return { healthy: true, message: null, details: null };
  }`,
    contractSuite: "git-hosting-contract.js",
    contractFixtureType: "GitHostingContractFixtures",
  },
};

// ── Type Imports for Generated Code ────────────────────────────────────────

const TYPE_IMPORTS: Record<AdapterType, string> = {
  trigger: `import type { TriggerEvent } from "../../../schemas/adapters.js";`,
  communication: `import type { FormattedMessage, MessageType, SendResult, Target } from "../../../schemas/adapters.js";`,
  llm: `import type { InferenceRequest, InferenceResult, LLMCapabilities } from "../../../schemas/adapters.js";`,
  tool: `import type { ToolDescription, ToolExecutionContext, ToolResult } from "../../../schemas/adapters.js";`,
  git_hosting: `import type { BranchProtection, CommentResult, MergeResult, MergeStrategy, PRComment, PROptions, PRResult, PRStatus, PRUpdates, ReviewStatus } from "../../../schemas/adapters.js";`,
};

// ── Scaffolding ───────────────────────────────────────────────────────────────

function toPascalCase(name: string): string {
  return name
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

export interface ScaffoldOptions {
  name: string;
  type: AdapterType;
  outputDir: string;
}

/**
 * Scaffold a new plugin directory with all required files.
 */
export function scaffoldPlugin(options: ScaffoldOptions): string[] {
  const { name, type, outputDir } = options;
  const template = ADAPTER_TEMPLATES[type];
  const className = `${toPascalCase(name)}Plugin`;
  const pluginDir = join(outputDir, name);

  if (existsSync(pluginDir)) {
    throw new Error(`Directory already exists: ${pluginDir}`);
  }

  mkdirSync(pluginDir, { recursive: true });

  const createdFiles: string[] = [];

  // 1. engineer.plugin.yaml
  const manifest = {
    id: name,
    type,
    version: "0.1.0",
    name: toPascalCase(name),
    description: `A custom ${type} plugin`,
    critical: false,
    enabled: true,
    entry: "index.ts",
    adapter_meta: {},
    contributes: {},
  };
  const manifestPath = join(pluginDir, "engineer.plugin.yaml");
  writeFileSync(manifestPath, stringifyYaml(manifest), "utf-8");
  createdFiles.push(manifestPath);

  // 2. index.ts
  const indexContent = `import type { ${template.baseClass} } from "${template.importPath}";
import { ${className} } from "./${name}.js";

export function createPlugin(): ${template.baseClass} {
  return new ${className}();
}
`;
  const indexPath = join(pluginDir, "index.ts");
  writeFileSync(indexPath, indexContent, "utf-8");
  createdFiles.push(indexPath);

  // 3. {name}.ts — plugin class
  const typeImport = TYPE_IMPORTS[type];
  const pluginContent = `import type { HealthStatus, InitResult } from "../../../schemas/adapters.js";
${typeImport}
import { ${template.baseClass} } from "${template.importPath}";

import type { ${toPascalCase(name)}Config } from "./config.js";
import { ${toPascalCase(name)}ConfigSchema } from "./config.js";

export class ${className} extends ${template.baseClass} {
  private config: ${toPascalCase(name)}Config | null = null;

${template.abstractMethods}
}
`;
  const pluginPath = join(pluginDir, `${name}.ts`);
  writeFileSync(pluginPath, pluginContent, "utf-8");
  createdFiles.push(pluginPath);

  // 4. config.ts
  const configContent = `import { z } from "zod";

export const ${toPascalCase(name)}ConfigSchema = z.object({
  // Define your config fields here. Conventions:
  //   - Use _ms suffix for durations (enables "30s", "5m", "2h" string parsing)
  //   - Use z.default() on optional fields
  //   - Use z.string().min(1) for required strings
  //   - Reference secrets via \${ENV_VAR} in YAML, not here
  // See docs/plugin-development.md for full guidance.
});

export type ${toPascalCase(name)}Config = z.infer<typeof ${toPascalCase(name)}ConfigSchema>;
`;
  const configPath = join(pluginDir, "config.ts");
  writeFileSync(configPath, configContent, "utf-8");
  createdFiles.push(configPath);

  // 5. {name}.test.ts
  const testContent = `import { describe, it, expect } from "vitest";
import { run${toPascalCase(type.replace("_", "-"))}ContractSuite } from "../../../../test/helpers/contract-suites/${template.contractSuite}";
import { createPlugin } from "./index.js";

// Run the contract compliance suite
run${toPascalCase(type.replace("_", "-"))}ContractSuite(
  createPlugin,
  {
    validConfig: {},
    invalidConfig: { _force_fail: true },
    manifest: {
      id: "${name}",
      type: "${type}",
      version: "0.1.0",
      name: "${toPascalCase(name)}",
      description: "Test plugin",
      config_schema: {},
      critical: false,
      enabled: true,
      entry: "index.ts",
      adapter_meta: {},
      contributes: { events: [], commands: [], config_keys: [], hooks: [] },
    },
  },
);

describe("${className}", () => {
  it("creates a plugin instance", () => {
    const plugin = createPlugin();
    expect(plugin).toBeDefined();
  });
});
`;
  const testPath = join(pluginDir, `${name}.test.ts`);
  writeFileSync(testPath, testContent, "utf-8");
  createdFiles.push(testPath);

  return createdFiles;
}

/**
 * CLI command handler for `engineer create-plugin`.
 */
export function runCreatePlugin(name: string, type: string, outputDir: string): number {
  // Validate adapter type
  const typeResult = AdapterTypeSchema.safeParse(type);
  if (!typeResult.success) {
    const validTypes = AdapterTypeSchema.options.join(", ");
    console.error(`Invalid adapter type "${type}". Valid types: ${validTypes}`);
    return 1;
  }

  try {
    const files = scaffoldPlugin({ name, type: typeResult.data, outputDir });
    console.log(`Created plugin "${name}" (${type}):`);
    for (const file of files) {
      console.log(`  ${file}`);
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to create plugin: ${message}`);
    return 1;
  }
}
