import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import ms from "ms";
import YAML from "yaml";
import type { z } from "zod";

import { extractErrorMessage } from "../utils/errors.js";

import type { Person } from "../schemas/adapters.js";
import {
  DaemonConfigSchema,
  OrchestratorConfigSchema,
  PeopleConfigSchema,
  SafetyConfigSchema,
  WorkspaceConfigSchema,
} from "../schemas/config.js";
import type { DaemonConfig, OrchestratorConfig, SafetyConfig, WorkspaceConfig } from "../schemas/config.js";

// ── Error Classes ────────────────────────────────────────────────────────────

/** Base error for config loading failures — carries the file path of the offending config. */
export class ConfigError extends Error {
  readonly filePath: string;

  constructor(message: string, filePath: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConfigError";
    this.filePath = filePath;
  }
}

/** Thrown when a config references an environment variable that isn't set in process.env. */
export class EnvVarError extends ConfigError {
  readonly varName: string;

  constructor(varName: string, filePath: string) {
    super(`"\${${varName}}" references undefined environment variable "${varName}"`, filePath);
    this.name = "EnvVarError";
    this.varName = varName;
  }
}

/** Thrown when a config fails Zod schema validation — wraps the underlying ZodError. */
export class ValidationError extends ConfigError {
  readonly zodError: z.ZodError;

  constructor(zodError: z.ZodError, filePath: string) {
    const details = zodError.issues.map((i) => formatZodIssue(i)).join("\n  ");
    super(`Config validation failed in ${filePath}:\n  ${details}`, filePath);
    this.name = "ValidationError";
    this.zodError = zodError;
  }
}

// ── Result Types ─────────────────────────────────────────────────────────────

/** Result of loading a single config file — the parsed value plus where it came from. */
export interface ConfigLoadResult<T> {
  readonly config: T;
  readonly source: "file" | "defaults";
  readonly filePath: string;
}

/** Result of a non-throwing reload: either a parsed config or a {@link ConfigError}. */
export type ConfigReloadResult<T> =
  | { readonly ok: true; readonly config: T }
  | { readonly ok: false; readonly error: ConfigError };

/** The full set of validated config sections, loaded together for daemon startup. */
export interface ConfigBundle {
  readonly daemon: DaemonConfig;
  readonly orchestrator: OrchestratorConfig;
  readonly workspace: WorkspaceConfig;
  readonly safety: SafetyConfig;
  readonly people: Person[];
}

/** Non-fatal note surfaced during config directory loading (e.g., missing optional file). */
export interface ConfigWarning {
  readonly file: string;
  readonly message: string;
}

/** Output of {@link loadConfigDir} — the validated bundle plus any non-fatal warnings. */
export interface ConfigDirResult {
  readonly bundle: ConfigBundle;
  readonly warnings: ConfigWarning[];
}

// ── Config Directory Loading ─────────────────────────────────────────────────

/**
 * Loads all core config files from a directory. Startup behavior: throws on
 * invalid config. Returns warnings for notable conditions (e.g., missing
 * safety.yaml using conservative defaults).
 */
export function loadConfigDir(configDir?: string): ConfigDirResult {
  const explicit = configDir ?? process.env["ENGINEER_CONFIG_DIR"];
  const dir = explicit ?? join(homedir(), ".engineer", "config");

  // If a config dir was explicitly specified (argument or env var) and doesn't exist, fail loudly.
  // Default path silently uses Zod defaults — that's expected on first run.
  if (explicit !== undefined && !existsSync(dir)) {
    throw new ConfigError(`Config directory does not exist: ${dir}`, dir);
  }

  const warnings: ConfigWarning[] = [];

  const daemon = loadConfig(join(dir, "daemon.yaml"), DaemonConfigSchema);
  const orchestrator = loadConfig(join(dir, "orchestrator.yaml"), OrchestratorConfigSchema);
  const workspace = loadConfig(join(dir, "workspace.yaml"), WorkspaceConfigSchema);
  const safety = loadConfig(join(dir, "safety.yaml"), SafetyConfigSchema);
  const peopleResult = loadConfig(join(dir, "people.yaml"), PeopleConfigSchema);

  // Warn on hot-reloadable configs using defaults — operators should configure these
  if (safety.source === "defaults") {
    warnings.push({
      file: "safety.yaml",
      message: "safety.yaml not found, using conservative defaults. Configure safety explicitly for production use.",
    });
  }
  if (peopleResult.source === "defaults") {
    warnings.push({
      file: "people.yaml",
      message: "people.yaml not found, no people configured.",
    });
  }

  return {
    bundle: {
      daemon: daemon.config,
      orchestrator: orchestrator.config,
      workspace: workspace.config,
      safety: safety.config,
      people: peopleResult.config.people,
    },
    warnings,
  };
}

// ── Single File Loading ──────────────────────────────────────────────────────

/**
 * Loads a YAML config file, resolves env vars, parses durations, validates
 * with the provided Zod schema. Throws on any error (startup behavior).
 *
 * Missing file → returns Zod defaults with `source: "defaults"`.
 */
export function loadConfig<S extends z.ZodTypeAny>(filePath: string, schema: S): ConfigLoadResult<z.output<S>> {
  type T = z.output<S>;

  // Missing file → use Zod defaults
  if (!existsSync(filePath)) {
    const config = schema.parse({}) as T;
    return { config, source: "defaults", filePath };
  }

  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch (error) {
    throw new ConfigError(`Failed to read config file: ${filePath}`, filePath, {
      cause: error,
    });
  }

  // Empty file → use Zod defaults
  const trimmed = content.trim();
  if (trimmed === "") {
    const config = schema.parse({}) as T;
    return { config, source: "file", filePath };
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(content) as unknown;
  } catch (error) {
    throw new ConfigError(`Failed to parse YAML in ${filePath}: ${extractErrorMessage(error)}`, filePath, {
      cause: error,
    });
  }

  // null from YAML.parse means the document was empty/null
  if (parsed === null || parsed === undefined) {
    const config = schema.parse({}) as T;
    return { config, source: "file", filePath };
  }

  const resolved = resolveEnvVars(parsed, filePath);
  const withDurations = parseDurations(resolved, schema);

  const result = schema.safeParse(withDurations);
  if (!result.success) {
    throw new ValidationError(result.error, filePath);
  }

  return { config: result.data as T, source: "file", filePath };
}

/**
 * Non-throwing variant of `loadConfig` for hot-reload use.
 * Returns `{ ok: true, config }` on success, `{ ok: false, error }` on failure.
 */
export function loadConfigSafe<S extends z.ZodTypeAny>(filePath: string, schema: S): ConfigReloadResult<z.output<S>> {
  try {
    const result = loadConfig(filePath, schema);
    return { ok: true, config: result.config };
  } catch (error) {
    if (error instanceof ConfigError) {
      return { ok: false, error };
    }
    return {
      ok: false,
      error: new ConfigError(`Unexpected error loading ${filePath}: ${extractErrorMessage(error)}`, filePath, {
        cause: error,
      }),
    };
  }
}

// ── Env Var Resolution ───────────────────────────────────────────────────────

const ENV_VAR_TEST = /\$\{[^}]+\}/;
const ENV_VAR_PATTERN = /\$\{([^}]+)\}/g;

/**
 * Recursively resolves `${ENV_VAR_NAME}` references in string values.
 * Throws `EnvVarError` if a referenced env var is undefined.
 *
 * Limitation: there is no escape syntax for literal `${...}` strings.
 * Any `${...}` pattern is always treated as an env var reference.
 */
export function resolveEnvVars(obj: unknown, filePath: string): unknown {
  if (typeof obj === "string") {
    if (!ENV_VAR_TEST.test(obj)) {
      return obj;
    }

    return obj.replace(ENV_VAR_PATTERN, (_match, varName: string) => {
      const value = process.env[varName];
      if (value === undefined) {
        throw new EnvVarError(varName, filePath);
      }
      return value;
    });
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => resolveEnvVars(item, filePath));
  }

  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = resolveEnvVars(value, filePath);
    }
    return result;
  }

  // Numbers, booleans, null — pass through
  return obj;
}

// ── Duration Parsing (Schema Introspection) ──────────────────────────────────

/**
 * Walks the data object and converts string values to milliseconds (via `ms`)
 * at paths where the Zod schema expects numbers.
 */
export function parseDurations(obj: unknown, schema: z.ZodTypeAny): unknown {
  const pathTree = walkSchema(schema);
  if (!pathTree) {
    return obj;
  }
  return applyDurations(obj, pathTree);
}

/**
 * A node in the schema path tree. Either a leaf number field or an intermediate
 * object/record node with children.
 */
type PathNode =
  | { readonly type: "number" }
  | { readonly type: "object"; readonly children: Record<string, PathNode> }
  | { readonly type: "record"; readonly valueNode: PathNode };

/**
 * Walks a Zod schema to build a tree of paths where number fields exist.
 * Used to know which YAML string values should be parsed as durations.
 */
function walkSchema(schema: z.ZodTypeAny): PathNode | null {
  const def = schema._def as Record<string, unknown>;
  const typeName = def["typeName"] as string | undefined;

  switch (typeName) {
    case "ZodObject": {
      const shape = (schema as z.ZodObject<z.ZodRawShape>).shape;
      const children: Record<string, PathNode> = {};
      let hasChildren = false;

      for (const [key, childSchema] of Object.entries(shape)) {
        const childNode = walkSchema(childSchema as z.ZodTypeAny);
        if (childNode) {
          children[key] = childNode;
          hasChildren = true;
        }
      }

      return hasChildren ? { type: "object", children } : null;
    }

    case "ZodRecord": {
      const valueSchema = def["valueType"] as z.ZodTypeAny;
      const valueNode = walkSchema(valueSchema);
      return valueNode ? { type: "record", valueNode } : null;
    }

    case "ZodDefault": {
      const innerType = def["innerType"] as z.ZodTypeAny;
      return walkSchema(innerType);
    }

    case "ZodOptional": {
      const innerType = def["innerType"] as z.ZodTypeAny;
      return walkSchema(innerType);
    }

    case "ZodNullable": {
      const innerType = def["innerType"] as z.ZodTypeAny;
      return walkSchema(innerType);
    }

    case "ZodNumber":
      return { type: "number" };

    // String, boolean, enum, array, literal, etc. — not number fields
    default:
      return null;
  }
}

function applyDurations(data: unknown, node: PathNode): unknown {
  switch (node.type) {
    case "number":
      return applyNumberDuration(data);
    case "record":
      return applyRecordDurations(data, node.valueNode);
    case "object":
      return applyObjectDurations(data, node.children);
    default:
      return data;
  }
}

function applyNumberDuration(data: unknown): unknown {
  if (typeof data === "string") {
    const parsed = ms(data as ms.StringValue);
    // ms() returns undefined for unrecognized strings at runtime,
    // despite the type signature. Let Zod catch invalid values.
    return typeof parsed === "number" ? parsed : data;
  }
  return data;
}

function applyRecordDurations(data: unknown, valueNode: PathNode): unknown {
  if (data !== null && typeof data === "object" && !Array.isArray(data)) {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      result[key] = applyDurations(value, valueNode);
    }
    return result;
  }
  return data;
}

function applyObjectDurations(data: unknown, children: Record<string, PathNode>): unknown {
  if (data !== null && typeof data === "object" && !Array.isArray(data)) {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      const childNode = children[key];
      result[key] = childNode ? applyDurations(value, childNode) : value;
    }
    return result;
  }
  return data;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Format a single Zod issue with contextual hints. */
function formatZodIssue(issue: z.ZodIssue): string {
  const path = issue.path.join(".");
  let formatted = `${path}: ${issue.message}`;

  // For enum errors, show the valid options
  if (issue.code === "invalid_enum_value") {
    const enumIssue = issue as z.ZodIssue & { options?: unknown[] };
    if (enumIssue.options) {
      formatted += ` (valid values: ${enumIssue.options.map((o) => String(o)).join(", ")})`;
    }
  }

  // For type errors on _ms fields, hint about duration strings
  if (issue.code === "invalid_type" && path.endsWith("_ms")) {
    formatted += ' (accepts duration strings like "30s", "5m", "8h", "1d")';
  }

  // For deeply nested paths, hint at the top-level section to check
  if (issue.path.length > 2) {
    formatted += ` (in the "${String(issue.path[0])}" section)`;
  }

  return formatted;
}
