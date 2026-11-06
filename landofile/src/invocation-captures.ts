import { ConfigExpressionError } from "@lando/sdk/errors";
import type {
  ExpressionContext,
  ExpressionNode,
  ExpressionTemplate,
  PathSegment,
} from "@lando/sdk/expressions";
import { isPlainRecord } from "@lando/sdk/landofile";
import { LandofileSourceValue, type ParsedPendingSite, SecretRef } from "@lando/sdk/schema";
import { Schema } from "effect";
import { templateSource } from "./expression-source.ts";

const STATIC_SCOPES = new Set([
  "env",
  "app",
  "proxy",
  "recipe",
  "services",
  "secrets",
  "host",
  "global",
  "paths",
]);

/** Capture referenced static paths only. Missing values stay absent, including in lazy branches. */
export const captureTemplate = (site: ParsedPendingSite, context: ExpressionContext) => {
  const captures: Record<string, LandofileSourceValue> = {};
  const fail = (): never => {
    throw new ConfigExpressionError({
      message: "Invocation static capture is unbounded or exceeds its budget.",
      path: site.path,
      expression: templateSource(site.template),
      filePath: "file" in site.source ? site.source.file : "<invocation>",
      remediation: "Reference a specific static value and keep captures below 65536 bytes.",
    });
  };
  const segments = (parts: readonly PathSegment[]): readonly PathSegment[] =>
    parts.map((part) => (part.type === "dynamic" ? { ...part, expr: node(part.expr) } : part));
  const node = (value: ExpressionNode): ExpressionNode => {
    switch (value.kind) {
      case "Literal":
        return value;
      case "Path": {
        if (!STATIC_SCOPES.has(value.head)) return { ...value, segments: segments(value.segments) };
        const prefix = value.segments.findIndex((part) => part.type === "dynamic");
        const count = prefix < 0 ? value.segments.length : prefix;
        if (count === 0) return fail();
        let captured: unknown = Reflect.get(context, value.head);
        if (value.head === "secrets") {
          const first = value.segments[0];
          const name = first?.type === "prop" ? first.name : first?.type === "key" ? first.key : undefined;
          if (name !== undefined)
            captured = {
              ...context.secrets,
              [name]:
                context.secrets?.[name] ??
                Schema.decodeUnknownSync(SecretRef)({ _tag: "SecretRef", reference: name }),
            };
        }
        for (const part of value.segments.slice(0, count)) {
          switch (part.type) {
            case "prop":
              captured = isPlainRecord(captured) ? captured[part.name] : undefined;
              break;
            case "key":
              captured = isPlainRecord(captured) ? captured[part.key] : undefined;
              break;
            case "index":
              captured = Array.isArray(captured) ? captured[part.index] : undefined;
              break;
            case "dynamic":
              return fail();
            default:
              return part satisfies never;
          }
        }
        const key = JSON.stringify([value.head, value.segments.slice(0, count)]);
        if (captured !== undefined) captures[key] = Schema.decodeUnknownSync(LandofileSourceValue)(captured);
        return {
          kind: "Path",
          head: "services",
          segments: [
            { type: "prop", name: "__invocationCaptures" },
            { type: "key", key },
            ...segments(value.segments.slice(count)),
          ],
        };
      }
      case "Access":
        return { ...value, target: node(value.target), segments: segments(value.segments) };
      case "ArrayLiteral":
        return { ...value, elements: value.elements.map(node) };
      case "ObjectLiteral":
        return { ...value, entries: value.entries.map((entry) => ({ ...entry, value: node(entry.value) })) };
      case "Call":
        return { ...value, args: value.args.map(node) };
      case "Conditional":
        return {
          ...value,
          test: node(value.test),
          consequent: node(value.consequent),
          alternate: node(value.alternate),
        };
      default:
        return value satisfies never;
    }
  };
  const template: ExpressionTemplate = {
    ...site.template,
    segments: site.template.segments.map((segment) => {
      switch (segment.kind) {
        case "InterpolationSegment":
          return { ...segment, expression: node(segment.expression) };
        case "SecretRefSegment":
          return {
            kind: "InterpolationSegment",
            trimLeft: false,
            trimRight: false,
            expression: node({
              kind: "Path",
              head: "secrets",
              segments: [{ type: "prop", name: segment.name }],
            }),
          };
        case "LiteralSegment":
        case "CommentSegment":
        case "ShellParamSegment":
          return segment;
        default:
          return segment satisfies never;
      }
    }),
  };
  if (new TextEncoder().encode(JSON.stringify(captures)).byteLength > 65536) fail();
  return { template, captures };
};
