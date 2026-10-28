import { REDACTED, type Redactor } from "@lando/sdk/secrets";

const maskedToken = JSON.stringify(REDACTED);

const redactStringToken = (token: string, redactor: Redactor): string => {
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

// Serialize first to retain JSON's toJSON, omission, and array semantics. Only
// string tokens enter redaction; primitive values and JSON punctuation stay intact.
export const encodeRedactedJson = (value: unknown, redactor: Redactor): string => {
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error("Expected a JSON document.");
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
