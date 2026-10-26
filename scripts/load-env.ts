// Loads .env.local and .env for the command-line scripts.
// Next.js reads those files on its own. These scripts run under tsx, so they
// read the same files here. Variables already set in the environment win.
// Values are never printed.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

function readEnvFile(filename: string): Record<string, string> {
  const path = resolve(process.cwd(), filename);
  if (!existsSync(path)) return {};
  const values: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const body = trimmed.startsWith("export ") ? trimmed.slice("export ".length) : trimmed;
    const separator = body.indexOf("=");
    if (separator === -1) continue;
    const key = body.slice(0, separator).trim();
    let value = body.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) values[key] = value;
  }
  return values;
}

export function loadEnvFiles(): void {
  const values = {
    ...readEnvFile(".env"),
    ...readEnvFile(".env.local"),
  };
  for (const [key, value] of Object.entries(values)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
