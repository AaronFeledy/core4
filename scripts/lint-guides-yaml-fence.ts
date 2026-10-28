/**
 * Guide MDX yaml|yml fence validation against public authoring schemas.
 *
 * Fragments use LandofileAuthoringFragmentNative so native !override/!reset
 * from parseLandofile validate without a wire-envelope rewrite (parser emits
 * native merge directives; the non-native Fragment codec expects wire tags).
 */
import { dirname, resolve } from "node:path";

import { Effect, Predicate, Result, Schema } from "effect";

import { type LandofileParseError, LandofileValidationError } from "@lando/sdk/errors";
import { decodeLandofileAuthoringLayer, parseLandofile } from "@lando/sdk/landofile";
import {
  GlobalConfig,
  LandofileAuthoringFragmentNative,
  LandofileShape,
  ServiceConfig,
  formatValidationIssueLine,
  validationIssuesFromCause,
} from "@lando/sdk/schema";

import type { MdxNode } from "./guides/mdx.ts";
import type { GuideLintDiagnostic } from "./lint-guides.ts";

const YAML_FENCE_LANGS = new Set(["yaml", "yml"]);

const LANDOFILE_KEYS = new Set(Object.keys(LandofileShape.schema.fields));
const SERVICE_KEYS = new Set([...Object.keys(ServiceConfig.fields), "working_dir", "env_file", "depends_on"]);
const GLOBAL_CONFIG_KEYS = new Set(Object.keys(GlobalConfig.fields));
const AmbiguousConfig = Schema.Union([LandofileAuthoringFragmentNative, GlobalConfig]);

export type YamlFenceMdxNode = MdxNode;

const walkAllNodes = (node: YamlFenceMdxNode, visitor: (node: YamlFenceMdxNode) => void): void => {
  visitor(node);
  for (const child of node.children ?? []) walkAllNodes(child, visitor);
};

export type ClassifiedForm =
  | { readonly kind: "full" }
  | { readonly kind: "fragment"; readonly value: unknown }
  | { readonly kind: "global" }
  | { readonly kind: "ambiguous" }
  | { readonly kind: "skip" };

/**
 * Resolve schema form for a parsed YAML root.
 * `formOverride` (fixtures) never skips: arrays/scalars still go to decode and fail.
 */
export const classifiedFormFor = (value: unknown, formOverride?: "full" | "fragment"): ClassifiedForm => {
  if (formOverride === "full") return { kind: "full" };
  if (formOverride === "fragment") return { kind: "fragment", value };
  return classifyYamlFenceDocument(value);
};

/** Classify a parsed YAML root for guide fence validation (no form override). */
export const classifyYamlFenceDocument = (value: unknown): ClassifiedForm => {
  if (!Predicate.isObject(value)) return { kind: "skip" };
  const keys = Object.keys(value);
  // A recognized authoring key keeps unknown siblings in strict validation.
  const hasLandofileKey = keys.some(
    (key) => LANDOFILE_KEYS.has(key) && key !== "name" && key !== "version" && !GLOBAL_CONFIG_KEYS.has(key),
  );
  if (
    !hasLandofileKey &&
    (keys.includes("apiVersion") || keys.includes("jobs") || (keys.includes("id") && keys.includes("title")))
  )
    return { kind: "skip" };
  if (Object.hasOwn(value, "name")) return { kind: "full" };
  if (keys.length > 0 && keys.every((key) => LANDOFILE_KEYS.has(key) && GLOBAL_CONFIG_KEYS.has(key)))
    return { kind: "ambiguous" };
  if (hasLandofileKey || keys.every((key) => LANDOFILE_KEYS.has(key) || key.startsWith("x-")))
    return { kind: "fragment", value };
  if (
    keys.every((key) => SERVICE_KEYS.has(key)) ||
    keys.some((key) => ["image", "type", "build", "healthcheck"].includes(key))
  )
    return { kind: "fragment", value: { services: { x: value } } };
  if (keys.length > 0 && keys.every((key) => GLOBAL_CONFIG_KEYS.has(key))) return { kind: "global" };
  return { kind: "skip" };
};

const decodeStrict = <A, I>(schema: Schema.Codec<A, I>, input: unknown): Effect.Effect<A, unknown> =>
  Schema.decodeUnknownEffect(schema)(input, { onExcessProperty: "error", errors: "all" });

const hasNolintMeta = (meta: string | null | undefined): boolean =>
  typeof meta === "string" &&
  (meta.match(/(?:[^\s"']|"(?:\\.|[^"\\])*"|'[^']*')+/g) ?? []).some(
    (token) => token.toLowerCase() === "nolint",
  );

type YamlLintContext = {
  readonly sourcePath: string;
  readonly fence: YamlFenceMdxNode;
  readonly code: string;
  readonly diagnostics: Array<GuideLintDiagnostic>;
};

const fenceDiagnostic = (
  { sourcePath, fence, code }: YamlLintContext,
  message: string,
  offset?: { readonly line?: number | undefined; readonly column?: number | undefined },
): GuideLintDiagnostic => {
  const fenceLine = fence.position?.start?.line ?? 1;
  const contentLine = offset?.line;
  return {
    sourcePath,
    line: fenceLine + (contentLine ?? 1),
    column: offset?.column ?? 1,
    code,
    message,
  };
};

const formatParseMessage = (error: LandofileParseError): string => {
  const remediation = error.remediation;
  return remediation === undefined || remediation.length === 0
    ? error.message
    : `${error.message} ${remediation}`;
};

export const firstValidationMessage = (cause: unknown): string => {
  const issues = cause instanceof LandofileValidationError ? cause.issues : validationIssuesFromCause(cause);
  const first = issues[0];
  return first === undefined ? "Invalid Landofile." : formatValidationIssueLine(first);
};

function assertNever(value: never): never {
  throw new TypeError(`Unexpected YAML document form: ${String(value)}`);
}

export const validateClassified = (context: YamlLintContext, value: unknown, form: ClassifiedForm): void => {
  let decoding: Effect.Effect<unknown, unknown>;
  switch (form.kind) {
    case "skip":
      return;
    case "full":
      decoding = decodeLandofileAuthoringLayer(context.sourcePath, value);
      break;
    case "global":
      decoding = decodeStrict(GlobalConfig, value);
      break;
    case "ambiguous":
      decoding = decodeStrict(AmbiguousConfig, value);
      break;
    case "fragment":
      decoding = decodeStrict(LandofileAuthoringFragmentNative, form.value);
      break;
    default:
      assertNever(form);
  }
  const decoded = Effect.runSync(Effect.result(decoding));
  if (Result.isSuccess(decoded)) return;
  context.diagnostics.push(fenceDiagnostic(context, firstValidationMessage(decoded.failure)));
};

/** Validate one YAML string as a guide fence or fixture body. */
export const lintYamlDocument = (options: {
  readonly sourcePath: string;
  readonly content: string;
  readonly cwd: string;
  readonly fence: YamlFenceMdxNode;
  readonly formOverride?: "full" | "fragment";
  readonly code: string;
  readonly parseCode: string;
  readonly diagnostics: Array<GuideLintDiagnostic>;
}): void => {
  const { sourcePath, content, cwd, fence, formOverride, code, parseCode, diagnostics } = options;
  const context = { sourcePath, fence, code, diagnostics };
  if (formOverride === undefined && content.trim().length === 0) return;
  if (formOverride === undefined) {
    // Project only root block keys, before the restricted parser sees foreign YAML.
    // Values and tags are never parsed or validated by this applicability check.
    const keys = [...content.matchAll(/^(?:"([^"\n]+)"|'([^'\n]+)'|([A-Za-z_][\w-]*))\s*:/gm)].map(
      (match) => match[1] ?? match[2] ?? match[3] ?? "",
    );
    if (classifyYamlFenceDocument(Object.fromEntries(keys.map((key) => [key, null]))).kind === "skip") return;
  }

  const parsed = Effect.runSync(
    Effect.result(
      parseLandofile({
        file: sourcePath,
        content,
        cwd,
      }),
    ),
  );
  if (Result.isFailure(parsed)) {
    const error = parsed.failure;
    diagnostics.push(
      fenceDiagnostic({ ...context, code: parseCode }, formatParseMessage(error), {
        line: error.line,
        column: error.column,
      }),
    );
    return;
  }

  const value = parsed.success;
  const form = classifiedFormFor(value, formOverride);
  validateClassified(context, value, form);
};

/** Walk an MDX AST and lint yaml|yml fenced code nodes (meta `nolint` skips). */
export const lintYamlFences = (
  sourcePath: string,
  root: YamlFenceMdxNode,
  diagnostics: Array<GuideLintDiagnostic>,
): void => {
  walkAllNodes(root, (node) => {
    if (node.type !== "code") return;
    const lang = typeof node.lang === "string" ? node.lang.toLowerCase() : undefined;
    if (lang === undefined || !YAML_FENCE_LANGS.has(lang)) return;
    if (hasNolintMeta(node.meta)) return;
    const value = typeof node.value === "string" ? node.value : "";
    lintYamlDocument({
      sourcePath,
      content: value,
      cwd: dirname(resolve(sourcePath)),
      fence: node,
      code: "guide.yaml-fence.invalid",
      parseCode: "guide.yaml-fence.parse",
      diagnostics,
    });
  });
};
