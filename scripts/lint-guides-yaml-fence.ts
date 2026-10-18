/**
 * Guide MDX yaml|yml fence validation against public authoring schemas.
 *
 * Fragments use LandofileAuthoringFragmentNative so native !override/!reset
 * from parseLandofile validate without a wire-envelope rewrite (parser emits
 * native merge directives; the non-native Fragment codec expects wire tags).
 */
import { dirname, resolve } from "node:path";

import { Effect, Predicate, Result, Schema } from "effect";

import type { LandofileParseError } from "@lando/sdk/errors";
import { parseLandofile } from "@lando/sdk/landofile";
import {
  GlobalConfig,
  LandofileAuthoringFragmentNative,
  LandofileAuthoringShape,
  LandofileShape,
  ServiceConfig,
  formatValidationIssueLine,
  validationIssuesFromCause,
} from "@lando/sdk/schema";

import type { GuideLintDiagnostic } from "./lint-guides.ts";

const YAML_FENCE_LANGS = new Set(["yaml", "yml"]);

const LANDOFILE_KEYS = new Set(Object.keys(LandofileShape.schema.fields));
const SERVICE_KEYS = new Set([...Object.keys(ServiceConfig.fields), "working_dir", "env_file", "depends_on"]);
const GLOBAL_CONFIG_KEYS = new Set(Object.keys(GlobalConfig.fields));

export type YamlFenceMdxNode = {
  readonly type: string;
  readonly value?: unknown;
  readonly lang?: string | null;
  readonly meta?: string | null;
  readonly children?: ReadonlyArray<YamlFenceMdxNode>;
  readonly position?: { readonly start?: { readonly line?: number; readonly column?: number } };
};

const lineOf = (node: YamlFenceMdxNode): number => node.position?.start?.line ?? 1;

const walkAllNodes = (node: YamlFenceMdxNode, visitor: (node: YamlFenceMdxNode) => void): void => {
  visitor(node);
  for (const child of node.children ?? []) walkAllNodes(child, visitor);
};

const recordKeys = (value: Record<string, unknown>): ReadonlyArray<string> => Object.keys(value);

const isLandofileKey = (key: string): boolean => LANDOFILE_KEYS.has(key) || key.startsWith("x-");

const keysSubset = (
  keys: ReadonlyArray<string>,
  allowed: ReadonlySet<string> | ((key: string) => boolean),
): boolean => keys.every((key) => (typeof allowed === "function" ? allowed(key) : allowed.has(key)));

export type ClassifiedForm =
  | { readonly kind: "full" }
  | { readonly kind: "fragment"; readonly value: unknown }
  | { readonly kind: "global" }
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
  const keys = recordKeys(value);
  // `name:` marks a full Landofile; Shape excess-property checks catch unknown keys.
  if (Object.hasOwn(value, "name")) return { kind: "full" };
  if (keysSubset(keys, isLandofileKey)) return { kind: "fragment", value };
  if (keysSubset(keys, SERVICE_KEYS)) return { kind: "fragment", value: { services: { x: value } } };
  if (keys.length > 0 && keysSubset(keys, GLOBAL_CONFIG_KEYS)) return { kind: "global" };
  return { kind: "skip" };
};

const decodeStrict = <A, I>(schema: Schema.Codec<A, I>, input: unknown): Effect.Effect<A, unknown> =>
  Schema.decodeUnknownEffect(schema)(input, { onExcessProperty: "error", errors: "all" });

const hasNolintMeta = (meta: string | null | undefined): boolean =>
  typeof meta === "string" && /\bnolint\b/i.test(meta);

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
  const fenceLine = lineOf(fence);
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
  const issues = validationIssuesFromCause(cause);
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
      decoding = decodeStrict(LandofileAuthoringShape, value);
      break;
    case "global":
      decoding = decodeStrict(GlobalConfig, value);
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
