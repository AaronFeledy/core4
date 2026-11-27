import { type CompatibilityFinding, type JsonValue, jsonValueKey } from "./model.ts";

/**
 * Identifies a reviewed change by its kind and the normalized schema values it
 * judged, never by its location. Inputs are normalized before classification,
 * so annotations (descriptions, titles, defaults) and definition names do not
 * contribute; any constraint change in the judged values yields a new digest.
 */
export const changeFingerprint = (
  changeKind: string,
  before: JsonValue | undefined,
  after: JsonValue | undefined,
): string => {
  const subject: Record<string, JsonValue> = { changeKind };
  if (before !== undefined) subject.before = before;
  if (after !== undefined) subject.after = after;
  return `sha256:${new Bun.CryptoHasher("sha256").update(jsonValueKey(subject)).digest("hex")}`;
};

export const FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{64}$/;

export const finding = (
  verdict: CompatibilityFinding["verdict"],
  changeKind: string,
  path: string,
  message: string,
  change: { readonly before?: JsonValue | undefined; readonly after?: JsonValue | undefined },
): CompatibilityFinding => ({
  verdict,
  changeKind,
  path,
  message,
  fingerprint: changeFingerprint(changeKind, change.before, change.after),
  accepted: false,
});
