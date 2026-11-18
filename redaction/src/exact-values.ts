import { type RedactionMatch, encodeUriComponent, isUsableExactRedactionValue } from "@lando/sdk/secrets";

/**
 * Line endings a raw value may carry. A value registered from a Landofile or
 * env file is usually LF, while the process that prints it may emit CRLF (or
 * the other way round), so both spellings must match the same secret.
 */
const lineEndingVariants = (value: string): readonly string[] => {
  if (!value.includes("\n")) return [value];
  const lf = value.replaceAll("\r\n", "\n");
  return [...new Set([value, lf, lf.replaceAll("\n", "\r\n")])];
};

/** Both output layers match the same usable raw values and UTF-8 encodings. */
export const expandRedactionValues = (
  values: Iterable<string>,
  match: RedactionMatch = "substring",
): string[] => {
  const expanded = new Set<string>();
  for (const value of values) {
    if (match === "whole-token" && !isUsableExactRedactionValue(value)) continue;
    for (const lineEndingVariant of lineEndingVariants(value)) {
      const base64 = Buffer.from(lineEndingVariant, "utf8").toString("base64");
      const base64url = base64.replaceAll("+", "-").replaceAll("/", "_");
      const variants = [
        lineEndingVariant,
        // URI encoding rejects lone surrogates; the raw and JSON forms remain matchable.
        ...(lineEndingVariant.isWellFormed() ? [encodeURIComponent(lineEndingVariant)] : []),
        encodeUriComponent(lineEndingVariant),
        JSON.stringify(lineEndingVariant).slice(1, -1),
        base64,
        base64.replace(/=+$/u, ""),
        base64url,
        base64url.replace(/=+$/u, ""),
      ];
      for (const variant of variants) {
        if (isUsableExactRedactionValue(variant)) expanded.add(variant);
      }
    }
  }
  return [...expanded];
};
