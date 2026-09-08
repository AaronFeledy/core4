import type { RecipeSnapshot } from "@lando/sdk/schema";

const scalarYaml = (value: unknown): string => {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      if (/["\t\r\n]/.test(value) || /\s+#/.test(value)) {
        throw new Error(
          "Recipe snapshot YAML strings cannot contain double quotes, tabs, line breaks, or whitespace followed by #.",
        );
      }
      return `"${value}"`;
    case "boolean":
      return String(value);
    case "number": {
      if (!Number.isFinite(value)) throw new Error("Recipe snapshot YAML numbers must be finite.");
      if (Object.is(value, -0)) return "-0";
      const [mantissa = "", exponent] = String(value).split("e");
      if (exponent === undefined) return mantissa;
      const unsigned = mantissa.replace("-", "");
      const digits = unsigned.replace(".", "");
      const point =
        (unsigned.indexOf(".") === -1 ? unsigned.length : unsigned.indexOf(".")) + Number(exponent);
      const decimal =
        point <= 0
          ? `0.${"0".repeat(-point)}${digits}`
          : point >= digits.length
            ? digits + "0".repeat(point - digits.length)
            : `${digits.slice(0, point)}.${digits.slice(point)}`;
      return (value < 0 ? "-" : "") + decimal;
    }
    default:
      throw new Error("Recipe snapshot YAML requires JSON-compatible values.");
  }
};

const valueLines = (value: unknown, prefix: string, indent: number): readonly string[] => {
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${prefix} []`];
    return [
      prefix,
      ...value.flatMap((item: unknown) => {
        const marker = `${" ".repeat(indent)}-`;
        if (Array.isArray(item) && item.length > 0) {
          throw new Error(
            "Recipe snapshot YAML cannot represent a nonempty array directly inside a sequence.",
          );
        }
        if (item !== null && typeof item === "object" && !Array.isArray(item)) {
          const entries = Object.entries(item);
          const first = entries[0];
          if (first === undefined || !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(first[0])) {
            throw new Error(
              "Recipe snapshot YAML sequence maps require a first key starting with a letter or underscore; empty maps are unsupported.",
            );
          }
          return entries.flatMap(([key, child], index) =>
            mapEntryLines(key, child, index === 0 ? `${marker} ` : " ".repeat(indent + 2)),
          );
        }
        return valueLines(item, marker, indent + 2);
      }),
    ];
  }
  if (value !== null && typeof value === "object") {
    return [
      prefix,
      ...Object.entries(value).flatMap(([key, child]) => mapEntryLines(key, child, " ".repeat(indent))),
    ];
  }
  return [`${prefix} ${scalarYaml(value)}`];
};

const mapEntryLines = (key: string, value: unknown, prefix: string): readonly string[] => {
  if (!/^[A-Za-z0-9_-]+$/.test(key) || key === "__proto__") {
    throw new Error(`Invalid recipe snapshot YAML key: ${key}`);
  }
  return valueLines(value, `${prefix}${key}:`, prefix.length + 2);
};

export const recipeSnapshotYaml = (snapshot: RecipeSnapshot): string =>
  valueLines(snapshot, "snapshot:", 2).join("\n");
