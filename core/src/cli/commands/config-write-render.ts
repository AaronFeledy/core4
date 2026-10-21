import { createStandaloneRedactor } from "@lando/redaction/service";
import { configRedactionTokens } from "./config-redaction";

const displayValue = (value: unknown): string => {
  const kind =
    value === null
      ? "null"
      : Array.isArray(value)
        ? "list"
        : typeof value === "object"
          ? "map"
          : typeof value === "string"
            ? "text"
            : typeof value;
  const text = JSON.stringify(value) ?? String(value);
  const escaped = Array.from(text, (char) => {
    const code = char.charCodeAt(0);
    return code <= 31 || (code >= 127 && code <= 159) || code === 0x2028 || code === 0x2029
      ? `\\u${code.toString(16).padStart(4, "0")}`
      : char;
  }).join("");
  return `${escaped.length > 160 ? `${escaped.slice(0, 157)}...` : escaped} (${kind})`;
};

export const renderConfigWriteResult = (input: {
  readonly file: string;
  readonly subcommand?: string | undefined;
  readonly key?: string | undefined;
  readonly value?: unknown;
  readonly changed?: boolean | undefined;
  readonly dryRun?: boolean | undefined;
  readonly editSavedLabel: string;
}): string | undefined => {
  const { file, key } = input;
  switch (input.subcommand) {
    case "set": {
      const redactor = createStandaloneRedactor("secrets", { redactionTokens: configRedactionTokens(input) });
      const value = displayValue(redactor.redactValue(input.value));
      return `${file}: ${input.dryRun === true ? "would set" : "set"} ${key} = ${value}${input.dryRun === true ? " (dry run)" : ""}.`;
    }
    case "unset":
      if (input.changed !== true) return `${file}: ${key} was not present (no change).`;
      return input.dryRun === true ? `${file}: would unset ${key} (dry run).` : `${file}: unset ${key}.`;
    case "edit":
      return input.dryRun === true
        ? `${file}: would save edited ${input.editSavedLabel} (dry run).`
        : `${file}: saved edited ${input.editSavedLabel}.`;
    case "validate":
      return `${file}: valid.`;
    default:
      return undefined;
  }
};
