import { Effect, Result, Schema, SchemaIssue, SchemaTransformation } from "effect";

import { type ExpressionNode, ExpressionTemplate, type PathSegment } from "../expressions/ast.ts";
import { EXPRESSION_HELPER_NAMES } from "../expressions/evaluator.ts";
import { parseExpressionEither } from "../expressions/parser.ts";

// ==== Parsed authoring expressions retain source without resolving values.
export const AuthoringExpressionExpectedType = Schema.Literals([
  "string",
  "number",
  "boolean",
  "array",
  "object",
  "unknown",
]).annotate({
  identifier: "AuthoringExpressionExpectedType",
  title: "Authoring expression expected type",
  description: "Value kind required by the authoring site, or unknown for unconstrained sites.",
});
export type AuthoringExpressionExpectedType = typeof AuthoringExpressionExpectedType.Type;

export const AuthoringExpressionForm = Schema.Literals(["whole", "composite"]).annotate({
  identifier: "AuthoringExpressionForm",
  title: "Authoring expression form",
  description: "Whether an expression occupies the whole value or forms interpolated text.",
});
export type AuthoringExpressionForm = typeof AuthoringExpressionForm.Type;

export const AuthoringExpression = Schema.Struct({
  _tag: Schema.Literal("AuthoringExpression").annotate({
    description: "Parsed authoring expression discriminator.",
  }),
  form: AuthoringExpressionForm.annotate({
    description: "Whole value or composite string interpolation.",
  }),
  expectedType: AuthoringExpressionExpectedType.annotate({
    description: "Value kind required at this authoring site.",
  }),
  source: Schema.String.annotate({
    description: "Original expression source, preserved verbatim for encoding.",
  }),
  template: ExpressionTemplate.annotate({
    description: "Parsed expression template, never evaluated during authoring validation.",
  }),
  scopes: Schema.Array(Schema.String).annotate({
    description: "Sorted unique context scope heads referenced by the template.",
  }),
}).annotate({
  identifier: "AuthoringExpression",
  title: "Authoring expression",
  description: "A parsed, statically checked expression occupying a typed Landofile authoring site.",
});
export type AuthoringExpression = typeof AuthoringExpression.Type;

export const AUTHORING_EXPRESSION_SCOPES: ReadonlyArray<string> = [
  "host",
  "env",
  "paths",
  "app",
  "global",
  "recipe",
  "vars",
  "service",
  "services",
  "plugin",
  "info",
  "secrets",
  "globalServices",
  "task",
  "flags",
  "args",
  "raw",
  "sources",
  "generates",
  "checksum",
  "timestamp",
  "event",
  "answers",
  "destination",
  "cwd",
  "proxy",
  "item",
  "key",
];
const allowedScopes = new Set(AUTHORING_EXPRESSION_SCOPES);

// ==== Classification depends on parsed segments, including literal escapes.
export type AuthoringSourceClass = "plain" | "expression" | "invalid";

const hasExpression = (template: ExpressionTemplate): boolean =>
  template.segments.some((segment) => {
    switch (segment.kind) {
      case "LiteralSegment":
      case "CommentSegment":
        return false;
      case "InterpolationSegment":
      case "ShellParamSegment":
      case "SecretRefSegment":
        return true;
      default:
        return segment satisfies never;
    }
  });

export const classifyAuthoringSource = (source: string): AuthoringSourceClass => {
  const parsed = parseExpressionEither(source, { filePath: "<authoring>" });
  return Result.match(parsed, {
    onFailure: () => "invalid",
    onSuccess: (template) => (hasExpression(template) ? "expression" : "plain"),
  });
};

export const isPlainAuthoringString = (source: string): boolean =>
  classifyAuthoringSource(source) === "plain";

// ==== Static helper return kinds deliberately leave runtime-dependent values unknown.
const helperTypes: ReadonlyMap<string, AuthoringExpressionExpectedType> = new Map([
  ..."eq ne lt gt le ge not contains startsWith endsWith semver.satisfies"
    .split(" ")
    .map((name) => [name, "boolean"] as const),
  ..."lower upper trim join replace url.build shellQuote shellJoin json b64encode b64decode"
    .split(" ")
    .map((name) => [name, "string"] as const),
  ...["split", "keys", "values", "entries", "map", "filter", "range"].map((name) => [name, "array"] as const),
  ...["length", "semver.compare"].map((name) => [name, "number"] as const),
]);

const agree = (
  left: AuthoringExpressionExpectedType | undefined,
  right: AuthoringExpressionExpectedType | undefined,
): AuthoringExpressionExpectedType => (left === right ? (left ?? "unknown") : "unknown");

const analyzeTemplate = (template: ExpressionTemplate) => {
  const scopes = new Set<string>();
  const callees = new Set<string>();
  const visitSegments = (segments: ReadonlyArray<PathSegment>): void => {
    for (const segment of segments) {
      switch (segment.type) {
        case "dynamic":
          visit(segment.expr);
          break;
        case "prop":
        case "index":
        case "key":
          break;
        default:
          segment satisfies never;
      }
    }
  };
  const visit = (node: ExpressionNode): AuthoringExpressionExpectedType => {
    switch (node.kind) {
      case "Literal": {
        if (node.value === null) return "unknown";
        const kind = typeof node.value;
        return kind === "string" || kind === "number" || kind === "boolean" ? kind : "object";
      }
      case "ArrayLiteral":
        for (const element of node.elements) visit(element);
        return "array";
      case "ObjectLiteral":
        for (const entry of node.entries) visit(entry.value);
        return "object";
      case "Path":
        scopes.add(node.head);
        visitSegments(node.segments);
        return "unknown";
      case "Access":
        visit(node.target);
        visitSegments(node.segments);
        return "unknown";
      case "Call": {
        callees.add(node.callee);
        const args = node.args.map(visit);
        if (node.callee === "default" || node.callee === "and" || node.callee === "or")
          return agree(args[0], args[1]);
        return node.callee.startsWith("path.") ? "string" : (helperTypes.get(node.callee) ?? "unknown");
      }
      case "Conditional":
        visit(node.test);
        return agree(visit(node.consequent), visit(node.alternate));
      default:
        return node satisfies never;
    }
  };
  let inferredType: AuthoringExpressionExpectedType = "unknown";
  for (const segment of template.segments) {
    switch (segment.kind) {
      case "InterpolationSegment":
        inferredType = visit(segment.expression);
        break;
      case "ShellParamSegment":
        scopes.add("env");
        break;
      case "SecretRefSegment":
        scopes.add("secrets");
        break;
      case "LiteralSegment":
      case "CommentSegment":
        break;
      default:
        segment satisfies never;
    }
  }
  return { scopes: [...scopes].sort(), callees, inferredType };
};

// ==== Memoized wire-to-expression slots enforce the site's static constraints.
const slots = new Map<AuthoringExpressionExpectedType, Schema.Codec<AuthoringExpression, string>>();

export const authoringExpressionSlot = (
  expectedType: AuthoringExpressionExpectedType,
): Schema.Codec<AuthoringExpression, string> => {
  const cached = slots.get(expectedType);
  if (cached !== undefined) return cached;
  const slot = Schema.String.pipe(
    Schema.decodeTo(
      Schema.toType(AuthoringExpression),
      SchemaTransformation.transformEffect<AuthoringExpression, string>({
        decode: (source, options) => {
          const fail = (message: string) =>
            Effect.fail(
              new SchemaIssue.InvalidValue(
                { message: `${expectedType} authoring site: ${message}` },
                source,
                options,
              ),
            );
          const parsed = parseExpressionEither(source, { filePath: "<authoring>" });
          if (Result.isFailure(parsed)) return fail("Invalid expression syntax.");
          const template = parsed.success;
          if (!hasExpression(template)) return fail("Expected an expression, not plain text.");
          const form = template.whole ? "whole" : "composite";
          if (!template.whole && expectedType !== "string")
            return fail("Composite expressions require a string site.");
          const analysis = analyzeTemplate(template);
          if (analysis.scopes.some((head) => !allowedScopes.has(head)))
            return fail("Expression references an unknown scope.");
          if ([...analysis.callees].some((callee) => !EXPRESSION_HELPER_NAMES.has(callee)))
            return fail("Expression calls an unknown helper.");
          if (
            template.whole &&
            expectedType !== "unknown" &&
            analysis.inferredType !== "unknown" &&
            analysis.inferredType !== expectedType
          ) {
            return fail(`Expression has static type ${analysis.inferredType}.`);
          }
          return Effect.succeed({
            _tag: "AuthoringExpression" as const,
            form,
            expectedType,
            source,
            template,
            scopes: analysis.scopes,
          });
        },
        encode: (expression) => Effect.succeed(expression.source),
      }),
    ),
  );
  slots.set(expectedType, slot);
  return slot;
};
