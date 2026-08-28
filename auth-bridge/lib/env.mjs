import { readFile } from "node:fs/promises";

function decodeDoubleQuoted(value, lineNumber) {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`Invalid double-quoted value in .env at line ${lineNumber}`);
  }
}

export function parseDotEnv(source) {
  const values = {};
  for (const [index, rawLine] of String(source).replace(/^\uFEFF/, "").split(/\r?\n/).entries()) {
    const lineNumber = index + 1;
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) throw new Error(`Invalid .env assignment at line ${lineNumber}`);

    const [, key, rawValue] = match;
    let value;
    if (rawValue.startsWith('"')) {
      if (!rawValue.endsWith('"')) {
        throw new Error(`Unterminated double-quoted value in .env at line ${lineNumber}`);
      }
      value = decodeDoubleQuoted(rawValue, lineNumber);
    } else if (rawValue.startsWith("'")) {
      if (!rawValue.endsWith("'")) {
        throw new Error(`Unterminated single-quoted value in .env at line ${lineNumber}`);
      }
      value = rawValue.slice(1, -1);
    } else {
      value = rawValue.replace(/\s+#.*$/, "").trim();
    }
    values[key] = value;
  }
  return values;
}

export async function loadDotEnv(filePath, env = process.env) {
  let source;
  try {
    source = await readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return env;
    throw error;
  }

  for (const [key, value] of Object.entries(parseDotEnv(source))) {
    if (env[key] === undefined) env[key] = value;
  }
  return env;
}
