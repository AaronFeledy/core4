import { isUsableExactRedactionValue } from "@lando/sdk/secrets";

/** Both output layers match the same usable raw values and UTF-8 encodings. */
export const expandRedactionValues = (values: Iterable<string>): string[] => {
  const expanded = new Set<string>();
  for (const value of values) {
    const base64 = Buffer.from(value, "utf8").toString("base64");
    const base64url = base64.replaceAll("+", "-").replaceAll("/", "_");
    const variants = [
      value,
      // URI encoding rejects lone surrogates; the raw and JSON forms remain matchable.
      ...(value.isWellFormed() ? [encodeURIComponent(value)] : []),
      JSON.stringify(value).slice(1, -1),
      base64,
      base64.replace(/=+$/u, ""),
      base64url,
      base64url.replace(/=+$/u, ""),
    ];
    for (const variant of variants) {
      if (isUsableExactRedactionValue(variant)) expanded.add(variant);
    }
  }
  return [...expanded];
};
