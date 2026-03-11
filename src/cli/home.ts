import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Resolves the ENGINEER_HOME directory.
 * Precedence: --home flag > ENGINEER_HOME env > ~/.engineer
 */
export function resolveEngineerHome(flagValue?: string): string {
  if (flagValue) {
    return flagValue;
  }
  const envValue = process.env["ENGINEER_HOME"];
  if (envValue) {
    return envValue;
  }
  return join(homedir(), ".engineer");
}

/** Standard subdirectory paths under ENGINEER_HOME. */
export interface EngineerDirs {
  config: string;
  plugins: string;
  data: string;
  logs: string;
  run: string;
  workspaces: string;
}

/** Returns all standard subdirectory paths under ENGINEER_HOME. */
export function resolveSubdirs(engineerHome: string): EngineerDirs {
  return {
    config: join(engineerHome, "config"),
    plugins: join(engineerHome, "config", "plugins"),
    data: join(engineerHome, "data"),
    logs: join(engineerHome, "logs"),
    run: join(engineerHome, "run"),
    workspaces: join(engineerHome, "workspaces"),
  };
}
