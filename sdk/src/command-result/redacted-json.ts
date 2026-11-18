import {
  REDACTED,
  type Redactor,
  type ValueRedactionScope,
  isSecretFieldName,
  redactValueWith,
} from "@lando/sdk/secrets";

const maskedToken = JSON.stringify(REDACTED);

const redactStringToken = (token: string, redactor: Pick<Redactor, "redactString">): string => {
  try {
    const decoded: unknown = JSON.parse(token);
    if (typeof decoded !== "string") return maskedToken;
    const encoded = JSON.stringify(redactor.redactString(decoded));
    const redacted = redactor.redactString(encoded);
    if (redacted === encoded) return encoded;
    const checked: unknown = JSON.parse(redacted);
    return typeof checked === "string" ? JSON.stringify(checked) : maskedToken;
  } catch {
    return maskedToken;
  }
};

const redactTokens = (json: string, redactor: Pick<Redactor, "redactString">): string => {
  const parts: string[] = [];
  let cursor = 0;
  let remaining = 0;
  while (cursor < json.length) {
    if (json[cursor] !== '"') {
      cursor += 1;
      continue;
    }
    const start = cursor;
    cursor += 1;
    while (cursor < json.length) {
      if (json[cursor] === "\\") cursor += 2;
      else if (json[cursor] === '"') break;
      else cursor += 1;
    }
    if (cursor >= json.length) throw new Error("Expected a complete JSON string token.");
    cursor += 1;
    parts.push(json.slice(remaining, start), redactStringToken(json.slice(start, cursor), redactor));
    remaining = cursor;
  }
  parts.push(json.slice(remaining));
  return parts.join("");
};

// Serialize first to retain JSON's toJSON, omission, and array semantics. Only
// string tokens enter redaction; primitive values and JSON punctuation stay intact.
// The policy path also walks the model, so schema-fixed literals, declared keys,
// and the one secret-named-field rule survive. The no-policy path only sizes
// already-redacted strings (tooling diagnostics), carries no structure, and
// stays token-only.
export const encodeRedactedJson = (
  value: unknown,
  redactor: Pick<Redactor, "redactString">,
  policy?: ValueRedactionScope,
): string => {
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error("Expected a JSON document.");
  if (policy === undefined) return redactTokens(json, redactor);
  if (!json.includes('"')) return json;
  // Walk the serialized representation so a schema-fixed literal keeps its
  // serialized spelling and a secret-named field applies the shared rule.
  // Keep the token path's decoded + JSON-escaped double redaction.
  const redact = (text: string): string =>
    JSON.parse(redactStringToken(JSON.stringify(text), redactor)) as string;
  return JSON.stringify(redactValueWith(redact, isSecretFieldName, JSON.parse(json), policy));
};
