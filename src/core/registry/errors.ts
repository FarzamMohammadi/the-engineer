/** Base class for all registry errors. Tagged for discriminated matching. */
export abstract class RegistryError extends Error {
  abstract readonly tag: string;
}

/** Plugin validation failed (duplicate ID, invalid version, missing entry file). */
export class RegistryValidationError extends RegistryError {
  readonly tag = "RegistryValidation" as const;
  readonly pluginId: string | undefined;

  constructor(pluginId: string | undefined, message: string) {
    const prefix = pluginId
      ? `Registry: validation failed for "${pluginId}"`
      : "Registry: validation failed";
    super(`${prefix}: ${message}`);
    this.name = "RegistryValidationError";
    this.pluginId = pluginId;
  }
}

/** Plugin module loading failed (missing createPlugin export). */
export class RegistryLoadError extends RegistryError {
  readonly tag = "RegistryLoad" as const;
  readonly pluginId: string;

  constructor(pluginId: string, message: string) {
    super(`Registry: load failed for "${pluginId}": ${message}`);
    this.name = "RegistryLoadError";
    this.pluginId = pluginId;
  }
}
