import { yamlMappingKeyText, yamlScalarText } from "./scalar.ts";

export class YamlEmitError extends Error {
  override readonly name = "YamlEmitError";
}

type EmittedValue = { readonly text: string; readonly block: boolean };

export const emitYamlDocument = (value: unknown): string => {
  const ancestors = new Set<object>();

  const emit = (input: unknown): EmittedValue => {
    switch (typeof input) {
      case "string":
        return { text: yamlScalarText(input), block: false };
      case "boolean":
        return { text: String(input), block: false };
      case "number":
        if (!Number.isFinite(input)) throw new YamlEmitError("YAML requires finite numbers.");
        return { text: String(input), block: false };
      case "object": {
        if (input === null) return { text: "null", block: false };
        if (ancestors.has(input)) throw new YamlEmitError("YAML cannot emit cyclic structures.");
        const array = Array.isArray(input);
        const prototype: unknown = Object.getPrototypeOf(input);
        if (!array && prototype !== Object.prototype && prototype !== null) {
          throw new YamlEmitError("YAML requires plain objects or arrays.");
        }
        ancestors.add(input);
        const lines: string[] = [];
        if (Array.isArray(input)) {
          for (const item of input) {
            const child = emit(item);
            lines.push(`- ${child.text.replace(/\n/gu, "\n  ")}`);
          }
        } else {
          const entries: ReadonlyArray<readonly [string, unknown]> = Object.entries(input);
          for (const [key, item] of entries) {
            const child = emit(item);
            const prefix = child.block ? "\n  " : " ";
            lines.push(`${yamlMappingKeyText(key)}:${prefix}${child.text.replace(/\n/gu, "\n  ")}`);
          }
        }
        ancestors.delete(input);
        return lines.length === 0
          ? { text: array ? "[]" : "{}", block: false }
          : { text: lines.join("\n"), block: true };
      }
      default:
        throw new YamlEmitError("YAML requires JSON-compatible values.");
    }
  };

  return `${emit(value).text}\n`;
};
