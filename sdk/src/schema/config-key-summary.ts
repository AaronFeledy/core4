import { type JsonSchema, Predicate } from "effect";
import { type SchemaNode, conjoin, conjuncts, forbidden, schemaNode } from "./config-key-navigation.ts";

const literal = (value: unknown): string =>
  `\`${typeof value === "string" ? value : JSON.stringify(value)}\``;
const quantity = (count: number, unit: "character" | "item" | "entry"): string =>
  `${count} ${count === 1 ? unit : { character: "characters", item: "items", entry: "entries" }[unit]}`;
const quantityQualifier = (
  minimum: unknown,
  maximum: unknown,
  unit: "character" | "item" | "entry",
): string => {
  const preposition = unit === "character" ? "of" : "with";
  if (typeof minimum === "number" && typeof maximum === "number")
    return ` ${preposition} ${minimum} to ${quantity(maximum, unit)}`;
  if (typeof minimum === "number") return ` ${preposition} at least ${quantity(minimum, unit)}`;
  if (typeof maximum === "number") return ` ${preposition} at most ${quantity(maximum, unit)}`;
  return "";
};
const BOOLEAN = "`true` or `false`";
const plural = (summary: string): string =>
  summary === BOOLEAN
    ? "booleans"
    : summary
        .replace(/^an integer\b/, "integers")
        .replace(/^a number\b/, "numbers")
        .replace(/^text\b/, "text values")
        .replace(/^a mapping\b/, "mappings")
        .replace(/^a list\b/, "lists")
        .replace(/^any value$/, "any values");
/** "a", "a or b", "a, b, or c"; a boolean among other alternatives reads as "a boolean". */
const alternatives = (summaries: readonly string[]): string => {
  const parts =
    summaries.length > 1 ? summaries.map((part) => (part === BOOLEAN ? "a boolean" : part)) : summaries;
  if (parts.length <= 2) return parts.join(" or ");
  return `${parts.slice(0, -1).join(", ")}, or ${parts.at(-1)}`;
};

/** Summaries describe the projected value, not whole-document admission. */
export const schemaSummary = (document: JsonSchema.JsonSchema, node: SchemaNode): string => {
  const active = new Set<unknown>();
  const visit = (node: SchemaNode): readonly string[] => {
    if (active.has(node)) return ["any value"];
    active.add(node);
    const summary = summarize(node);
    active.delete(node);
    return summary;
  };
  const summarize = (node: SchemaNode): readonly string[] => {
    const parts = conjuncts(document, node);
    if (parts.some(forbidden)) return ["not accepted"];
    const objects = parts.filter((part) => typeof part !== "boolean");
    const merged: JsonSchema.JsonSchema = Object.assign({}, ...objects);
    const typeSets = objects.flatMap((part) =>
      typeof part.type === "string" ? [[part.type]] : Array.isArray(part.type) ? [part.type] : [],
    );
    if (typeSets.length > 0) {
      const accepted = ["string", "integer", "number", "boolean", "null", "array", "object"].filter((type) =>
        typeSets.every((types) => types.includes(type) || (type === "integer" && types.includes("number"))),
      );
      if (accepted.length === 0) return ["not accepted"];
      const types = accepted.includes("number") ? accepted.filter((type) => type !== "integer") : accepted;
      merged.type = types.length === 1 ? types[0] : types;
    }
    for (const keyword of ["minimum", "exclusiveMinimum", "minLength", "minItems", "minProperties"]) {
      const values = objects.map((part) => part[keyword]).filter((value) => typeof value === "number");
      if (values.length > 0) merged[keyword] = Math.max(...values);
    }
    for (const keyword of ["maximum", "exclusiveMaximum", "maxLength", "maxItems", "maxProperties"]) {
      const values = objects.map((part) => part[keyword]).filter((value) => typeof value === "number");
      if (values.length > 0) merged[keyword] = Math.min(...values);
    }
    for (const keyword of ["anyOf", "oneOf"]) {
      const union = objects.find((part) => Array.isArray(part[keyword]));
      const branches = union?.[keyword];
      if (!Array.isArray(branches)) continue;
      if (active.has(branches)) return ["any value"];
      active.add(branches);
      const siblings = objects.map((part) => {
        if (part !== union) return part;
        const { [keyword]: _branches, ...rest } = part;
        return rest;
      });
      const summaries = branches.flatMap((branch) => {
        const member = schemaNode(branch);
        return member === undefined ? [] : visit(conjoin([...siblings, member]));
      });
      active.delete(branches);
      const accepted = summaries.filter((summary) => summary !== "not accepted");
      const unique = [...new Set(accepted.length > 0 ? accepted : summaries)];
      return unique.length > 0 ? unique : ["any value"];
    }
    const choices = objects.flatMap((part) =>
      "const" in part ? [[part.const]] : Array.isArray(part.enum) ? [part.enum] : [],
    );
    const firstChoices = choices[0];
    if (firstChoices !== undefined) {
      const accepted = firstChoices.filter((value) =>
        choices.every((values) =>
          values.some((candidate) => JSON.stringify(candidate) === JSON.stringify(value)),
        ),
      );
      if (accepted.length === 0) return ["not accepted"];
      return [accepted.length === 1 ? literal(accepted[0]) : `one of ${accepted.map(literal).join(", ")}`];
    }
    if (Array.isArray(merged.type)) {
      return [...new Set(merged.type.flatMap((type) => visit({ ...merged, type })))];
    }
    const type =
      merged.type ??
      (merged.properties || merged.additionalProperties || merged.patternProperties ? "object" : undefined);
    let summary: string;
    switch (type) {
      case "integer":
      case "number": {
        summary = type === "integer" ? "an integer" : "a number";
        if (typeof merged.minimum === "number" && typeof merged.maximum === "number")
          summary += ` from ${merged.minimum} to ${merged.maximum}`;
        else if (typeof merged.minimum === "number") summary += ` of at least ${merged.minimum}`;
        else if (typeof merged.maximum === "number") summary += ` of at most ${merged.maximum}`;
        if (typeof merged.exclusiveMinimum === "number")
          summary += ` greater than ${merged.exclusiveMinimum}`;
        if (typeof merged.exclusiveMaximum === "number") summary += ` less than ${merged.exclusiveMaximum}`;
        if (typeof merged.multipleOf === "number") summary += ` in multiples of ${merged.multipleOf}`;
        return [summary];
      }
      case "string":
        summary = "text";
        if (typeof merged.format === "string") summary += ` in ${merged.format} format`;
        return [summary + quantityQualifier(merged.minLength, merged.maxLength, "character")];
      case "boolean":
        return [BOOLEAN];
      case "null":
        return ["`null`"];
      case "array": {
        const items = objects.flatMap((part) => {
          const item = schemaNode(part.items);
          return item === undefined ? [] : [item];
        });
        summary = `a list of ${alternatives(visit(conjoin(items)).map(plural))}`;
        break;
      }
      case "object": {
        const fixed = objects.some(
          (part) => Predicate.isObject(part.properties) && Object.keys(part.properties).length > 0,
        );
        const values = objects.flatMap((part) => {
          const additional = schemaNode(part.additionalProperties);
          const patterns = Predicate.isObject(part.patternProperties)
            ? Object.values(part.patternProperties).flatMap((value) => {
                const child = schemaNode(value);
                return child === undefined ? [] : [child];
              })
            : [];
          return [...(additional === undefined || additional === false ? [] : [additional]), ...patterns];
        });
        summary =
          fixed || values.length === 0
            ? "a mapping"
            : `a mapping of names to ${alternatives(
                visit(conjoin(values)).map((value) => (value.startsWith("text") ? value : plural(value))),
              )}`;
        break;
      }
      default:
        return ["any value"];
    }
    const minimum = merged[type === "array" ? "minItems" : "minProperties"];
    const maximum = merged[type === "array" ? "maxItems" : "maxProperties"];
    const unit = type === "array" ? "item" : "entry";
    return [summary + quantityQualifier(minimum, maximum, unit)];
  };
  return alternatives(visit(node));
};
