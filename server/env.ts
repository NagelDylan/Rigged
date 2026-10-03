// Minimal .env loader (no dependency). Never overrides variables that are
// already set and never logs values.
import fs from "node:fs";

export function loadDotEnv(file = ".env"): void {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trimStart().startsWith("#")) continue;
    const [, key, rawVal] = m;
    if (process.env[key] !== undefined) continue;
    let val = rawVal.trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    else val = val.replace(/\s+#.*$/, ""); // strip trailing comments on unquoted values
    process.env[key] = val;
  }
}

/** The Anthropic key, from ANTHROPIC_API_KEY or RIG_ANTHROPIC_API_KEY. */
export const anthropicKey = (): string | null => process.env.ANTHROPIC_API_KEY?.trim() || process.env.RIG_ANTHROPIC_API_KEY?.trim() || null;
