const SENSITIVE_KEY = /(?:authorization|cookie|password|secret|token|credential|private.?key)/i;
const BEARER_VALUE = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi;
const FORM_SECRET = /((?:client_secret|password|refresh_token|access_token|id_token)=)[^&\s]+/gi;

export const REDACTED = "[REDACTED]";

export function redactText(value) {
  return String(value)
    .replace(BEARER_VALUE, `$1${REDACTED}`)
    .replace(FORM_SECRET, `$1${REDACTED}`);
}

export function redact(value, seen = new WeakSet()) {
  if (typeof value === "string") return redactText(value);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    const result = value.map((item) => redact(item, seen));
    seen.delete(value);
    return result;
  }

  const result = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = SENSITIVE_KEY.test(key) ? REDACTED : redact(item, seen);
  }
  seen.delete(value);
  return result;
}

export function safeErrorMessage(error) {
  return redactText(error instanceof Error ? error.message : error);
}

export function maskKnownSecrets(value, secrets = []) {
  let result = redactText(value);
  for (const secret of secrets) {
    if (typeof secret === "string" && secret) result = result.replaceAll(secret, REDACTED);
  }
  return result;
}
