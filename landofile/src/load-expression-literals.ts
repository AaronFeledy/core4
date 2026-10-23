import { isPlainRecord } from "@lando/sdk/landofile";

export const escapeLoadProducedText = (value: unknown): unknown => {
  if (typeof value === "string")
    return value.includes("{{") ? value.replaceAll("{{", "{{{{").replaceAll("${", () => "$${") : value;
  if (Array.isArray(value)) return value.map(escapeLoadProducedText);
  if (isPlainRecord(value)) {
    if (value._tag === "FileRef" || value._tag === "ImportRef") return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, escapeLoadProducedText(entry)]),
    );
  }
  return value;
};
