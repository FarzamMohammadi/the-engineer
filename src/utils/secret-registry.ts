/**
 * Runtime registry of secret environment variable names for sanitization.
 *
 * Populated at startup from config YAML `${VAR}` scanning and plugin manifest
 * requirements. Replaces the former hardcoded SECRET_ENV_VARS list — Core no
 * longer needs to know which specific env vars plugins use.
 */

const secretVarNames = new Set<string>();

/** Register one or more env var names as secrets (values will be redacted by sanitizeSecrets). */
export function registerSecretEnvVars(names: Iterable<string>): void {
  for (const name of names) {
    secretVarNames.add(name);
  }
}

/** Get the current set of registered secret env var names. */
export function getSecretEnvVars(): ReadonlySet<string> {
  return secretVarNames;
}

/** Reset the registry — test use only. */
// biome-ignore lint/style/useNamingConvention: test-only helper follows project convention (_prefix)
export function _resetSecretRegistryForTest(): void {
  secretVarNames.clear();
}
