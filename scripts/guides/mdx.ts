import { dirname } from "node:path";
import { GuideFrontmatterValidationError, NotImplementedError } from "@lando/core/errors";
import { Effect, Result, Schema } from "effect";
import remarkFrontmatter from "remark-frontmatter";
import remarkMdx from "remark-mdx";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { parseLandofile } from "../../landofile/src/parser.ts";
import { decodeGuideFrontmatterEither } from "../../sdk/src/docs/components/index.ts";
import { validationIssuesFromCause } from "../../sdk/src/schema/validation-issue.ts";
import { GuidePropError } from "./diagnostic.ts";

export type MdxNode = {
  readonly type: string;
  readonly name?: string | null;
  readonly value?: unknown;
  readonly lang?: string | null | undefined;
  readonly meta?: string | null | undefined;
  readonly depth?: number;
  readonly attributes?: ReadonlyArray<MdxAttribute>;
  readonly children?: ReadonlyArray<MdxNode>;
  readonly position?: { readonly start?: { readonly line?: number; readonly column?: number } } | undefined;
};
type MdxAttribute = {
  readonly type: string;
  readonly name?: string;
  readonly position?: MdxNode["position"];
  readonly value?:
    | string
    | null
    | { readonly type?: string; readonly value?: string; readonly data?: unknown }
    | undefined;
};
export const processor = unified().use(remarkParse).use(remarkMdx).use(remarkFrontmatter, ["yaml"]);
export const lineOf = (node: MdxNode): number => node.position?.start?.line ?? 1;
export const elementChildren = (node: MdxNode): ReadonlyArray<MdxNode> =>
  (node.children ?? []).filter((child) => child.type === "mdxJsxFlowElement");
export const firstYaml = (root: MdxNode): string | undefined => {
  const value = root.children?.find((child) => child.type === "yaml")?.value;
  return typeof value === "string" ? value : undefined;
};
const expressionToValue = (expression: string): unknown => {
  const trimmed = expression.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (/^(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')$/s.test(trimmed)) return trimmed.slice(1, -1);
  if (/^`(?:[^`\\]|\\.)*`$/s.test(trimmed)) {
    if (trimmed.replace(/\\./g, "").includes("${"))
      throw new SyntaxError(
        "Template literal interpolation is not allowed in guide props; use a literal backtick string without `${...}`.",
      );
    return trimmed.slice(1, -1);
  }
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return JSON.parse(trimmed.replace(/([{,]\s*)([A-Za-z_$][\w$]*)(\s*:)/g, '$1"$2"$3').replace(/'/g, '"'));
  }
  throw new SyntaxError("Unsupported MDX attribute expression; use literal guide props.");
};
const rootGuideProps = Schema.Struct({ scaffoldStrip: Schema.optionalKey(Schema.Boolean) });
export const propsOf = (node: MdxNode, sourcePath: string): Record<string, unknown> => {
  const props: Record<string, unknown> = {};
  for (const attribute of node.attributes ?? []) {
    const prop = attribute.name ?? "attributes";
    const line = attribute.position?.start?.line ?? lineOf(node);
    try {
      if (attribute.type !== "mdxJsxAttribute" || attribute.name === undefined)
        throw new SyntaxError("Use named literal attributes, not spreads.");
      props[attribute.name] =
        attribute.value == null
          ? true
          : typeof attribute.value === "string"
            ? attribute.value
            : expressionToValue(attribute.value.value ?? "");
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      throw new GuidePropError({
        code: "guide.props.literal",
        sourcePath,
        line,
        column: attribute.position?.start?.column ?? node.position?.start?.column ?? 1,
        component: node.name ?? "MDX",
        prop,
        issues: [{ path: [prop] }],
        message: `Unsupported literal prop <${node.name}>.${prop} at ${sourcePath}:${line}.`,
        remediation:
          "Use named literal guide props without expressions, interpolation, or spreads. Rerun bun run lint:guides.",
      });
    }
  }
  if (node.name === "Guide")
    decodeOrThrow(Schema.decodeUnknownResult(rootGuideProps)(props, { onExcessProperty: "error" }), {
      sourcePath,
      node,
    });
  return props;
};
export const parseFrontmatter = (sourcePath: string, yaml: string | undefined): Record<string, unknown> => {
  if (yaml === undefined) return {};
  try {
    return Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(
      Effect.runSync(parseLandofile({ file: sourcePath, content: yaml, cwd: dirname(sourcePath) })),
    );
  } catch (error) {
    throw new GuideFrontmatterValidationError({
      message: `Invalid guide frontmatter at ${sourcePath}.`,
      sourcePath,
      field: "frontmatter",
      rejectedValue: undefined,
      issues: [{ path: [], message: String(error) }],
      remediation: `Fix the YAML frontmatter in ${sourcePath}.`,
    });
  }
};
export const decodeFrontmatter = (sourcePath: string, input: Record<string, unknown>) => {
  const { diataxis: _diataxis, ...schemaFrontmatter } = input;
  const decoded = decodeGuideFrontmatterEither(schemaFrontmatter);
  if (Result.isSuccess(decoded)) return decoded.success;
  if (decoded.failure instanceof NotImplementedError) throw decoded.failure;
  const issues = validationIssuesFromCause(decoded.failure);
  const field = String(issues[0]?.path[0] ?? "frontmatter");
  throw new GuideFrontmatterValidationError({
    message: `Guide frontmatter is invalid at ${sourcePath}.`,
    sourcePath,
    field,
    rejectedValue: input[field],
    issues,
    remediation: `Fix guide frontmatter field ${field}.`,
  });
};
export const decodeOrThrow = <A>(
  either: Result.Result<A, unknown>,
  context: { readonly sourcePath: string; readonly node: MdxNode },
): A => {
  if (Result.isSuccess(either)) return either.success;
  if (either.failure instanceof NotImplementedError) throw either.failure;
  const { sourcePath, node } = context;
  const component = node.name ?? "MDX";
  const issues = validationIssuesFromCause(either.failure).map(({ path }) => ({ path }));
  const prop =
    (
      issues.find(({ path }) => !node.attributes?.some((attribute) => attribute.name === path[0])) ??
      issues[0]
    )?.path.join(".") || component;
  const codes: Readonly<Record<string, string>> = {
    Run: "guide.run.binding",
    Verify: "guide.verify.matcher",
    Scenario: "guide.scenario.props",
  };
  throw new GuidePropError({
    code: codes[component] ?? "guide.component.props",
    message: `Invalid <${component}> props: ${prop} at ${sourcePath}:${lineOf(node)}.`,
    sourcePath,
    line: lineOf(node),
    column: node.position?.start?.column ?? 1,
    component,
    prop,
    issues,
    remediation: `Fix <${component}>.${prop} using the component prop schema. Rerun bun run lint:guides.`,
  });
};
