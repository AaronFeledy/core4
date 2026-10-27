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

/**
 * A no-op (`changed: false`) ends with `(no change)` whether or not it was a dry run, since nothing would
 * be written either way, and never claims validity: a repair-tolerant write can leave pre-existing issues
 * elsewhere in the file.
 */
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
  const dryRun = input.dryRun === true;
  switch (input.subcommand) {
    case "set": {
      const redactor = createStandaloneRedactor("secrets", { redactionTokens: configRedactionTokens(input) });
      const value = displayValue(redactor.redactValue(input.value));
      if (input.changed === false) return `${file}: ${key} is already set to ${value} (no change).`;
      return dryRun ? `${file}: would set ${key} = ${value} (dry run).` : `${file}: set ${key} = ${value}.`;
    }
    case "unset":
      if (input.changed !== true) return `${file}: ${key} was not present (no change).`;
      return dryRun ? `${file}: would unset ${key} (dry run).` : `${file}: unset ${key}.`;
    case "edit":
      if (input.changed === false) return `${file}: no edits made to ${input.editSavedLabel} (no change).`;
      return dryRun
        ? `${file}: would save edited ${input.editSavedLabel} (dry run).`
        : `${file}: saved edited ${input.editSavedLabel}.`;
    case "validate":
      return `${file}: valid.`;
    default:
      return undefined;
  }
};
