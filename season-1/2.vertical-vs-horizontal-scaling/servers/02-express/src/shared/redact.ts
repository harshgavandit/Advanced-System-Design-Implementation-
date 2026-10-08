const sensitive = /password|token|secret|authorization|cookie|session|mongoUri|redisUrl/i;
export function redact(value: unknown, secrets: string[] = []): unknown {
  if (typeof value === "string") {
    let safe = value.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[TOKEN]")
      .replace(/(?:mongodb(?:\+srv)?|redis):\/\/[^\s"']+/gi, "[CONNECTION]");
    for (const secret of secrets) if (secret.length >= 8) safe = safe.replaceAll(secret, "[REDACTED]");
    return safe;
  }
  if (Array.isArray(value)) return value.map(v => redact(v, secrets));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k,v]) => [k,sensitive.test(k) ? "[REDACTED]" : redact(v,secrets)]));
  return value;
}
