import { sha256Hex } from "@lando/sdk/digest";
import { ToolingCompileError } from "@lando/sdk/errors";
import {
  type ExpressionContext,
  type ExpressionTemplate,
  expressionScopeMembers,
} from "@lando/sdk/expressions";
import {
  type Environment,
  LandofileLayer,
  SecretRef,
  type ValidationIssueSource,
  formatValidationIssuePath,
} from "@lando/sdk/schema";
import { Result, Schema } from "effect";
import { type InvocationSite, evaluateInvocationSite } from "./invocation-sites.ts";
import { readsToolingData } from "./tooling-provenance.ts";
import { nextShellSegment, shellContext } from "./tooling-shell-context.ts";
import {
  type SafeShellInsertion,
  isSafeShellInsertion,
  shellInsertionRefusal,
} from "./tooling-shell-insertion.ts";
import { unsupportedSecretReference } from "./unsupported-secret-reference.ts";

/** Namespace for the execution-scoped bindings Lando generates for lowered secret references. */
export const BOUND_SECRET_PREFIX = "LANDO_BOUND_SECRET_";

/** Stable generated environment name for one raw `${secret:...}` reference. */
export const boundSecretName = (reference: string): string =>
  `${BOUND_SECRET_PREFIX}${sha256Hex(reference).slice(0, 16)}`;

const quoteWord = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export const shellBindingError = (site: InvocationSite) =>
  new ToolingCompileError({
    tool: "<tooling-task>",
    message: `Cannot safely bind invocation data at ${site.source.path.join(".")} in this shell context.`,
    remediation: `Move the interpolation at ${site.source.path.join(".")} to an ordinary argument outside backticks, heredocs, arithmetic, parameter expansions, and dollar-prefixed quotes. Place raw alone in an unquoted argument, never as the executable or a redirection operand.`,
  });

const sourceForAdvice = (source: ValidationIssueSource) => ({
  file: "file" in source ? source.file : "<landofile>",
  layer: Schema.is(LandofileLayer)(source.layer) ? source.layer : "base",
  path: source.path,
});

const secretBindingError = (site: InvocationSite, context: string, references: readonly string[]) => {
  const advice = unsupportedSecretReference({
    source: sourceForAdvice(site.source),
    references,
    value: site.expression,
  }).suggestion;
  return new ToolingCompileError({
    tool: "<tooling-task>",
    message: `Cannot lower the secret reference at ${formatValidationIssuePath(site.source.path)}: it sits in ${context}.`,
    remediation: advice,
  });
};

const secretReferenceOf = (value: unknown): string | undefined =>
  typeof value === "object" &&
  value !== null &&
  "_tag" in value &&
  value._tag === "SecretRef" &&
  "reference" in value &&
  typeof value.reference === "string"
    ? value.reference
    : undefined;

const secretReferenceSegment = (
  segment: InvocationSite["template"]["segments"][number],
): string | undefined => {
  if (segment.kind === "SecretRefSegment") return segment.name;
  if (segment.kind !== "InterpolationSegment" || segment.expression.kind !== "Path") return undefined;
  if (segment.expression.head !== "secrets") return undefined;
  const first = segment.expression.segments[0];
  if (first?.type === "prop") return first.name;
  if (first?.type === "key") return first.key;
  return undefined;
};

const secretDescriptor = (site: InvocationSite, reference: string): SecretRef => {
  const decoded = Schema.decodeUnknownResult(SecretRef)({ _tag: "SecretRef", reference });
  if (Result.isFailure(decoded))
    throw new ToolingCompileError({
      tool: "<tooling-task>",
      message: `Invalid secret reference at ${formatValidationIssuePath(site.source.path)}.`,
      remediation: "Use a supported secret store URI or a valid bare identifier.",
    });
  return decoded.success;
};

const loweredSecretText = (insertion: SafeShellInsertion, name: string): string => {
  switch (insertion) {
    case "unquoted":
      // Bun Shell drops a word that is only an empty quoted expansion; the trailing
      // empty string keeps an empty secret as one argument, as sh -c already does.
      return `"$${name}"""`;
    case "single":
      return `'"$${name}"'`;
    case "double":
      return `""$${name}""`;
    default:
      return insertion satisfies never;
  }
};

const secretCollisionError = (site: InvocationSite, name: string) =>
  new ToolingCompileError({
    tool: "<tooling-task>",
    message: `Cannot lower the secret reference at ${formatValidationIssuePath(site.source.path)}: the generated binding ${name} is already present in the command text or environment.`,
    remediation: `Remove ${name} from ${formatValidationIssuePath(site.source.path)} or its environment and retry; Lando owns that generated name.`,
  });

/**
 * Static refusal check for a lowered site whose template has only literal and
 * secret segments: reject unsafe shell positions before anything runs so lint
 * reports them. Undefined means the site lowers safely.
 */
export const loweredSecretRefusal = (
  template: ExpressionTemplate,
): { readonly context: string } | undefined => {
  let text = "";
  for (const segment of template.segments) {
    if (segment.kind === "LiteralSegment") text += segment.text;
    else if (segment.kind === "SecretRefSegment") {
      const position = shellContext(text);
      const refusal = shellInsertionRefusal(position.insertion);
      if (refusal !== undefined || position.dollar || position.refused)
        return { context: refusal ?? "a position preceded by an unescaped dollar sign" };
      if (!isSafeShellInsertion(position.insertion)) return { context: "a position Lando cannot lower" };
      text += loweredSecretText(position.insertion, boundSecretName(segment.name));
    }
  }
  return undefined;
};

/**
 * Lower one authored shell command site. Data interpolations bind as escaped
 * words; `${secret:...}` segments become a generated environment reference for
 * this invocation only. Returns the lowered text and the binding descriptors.
 */
export const bindToolingShellSite = (
  site: InvocationSite,
  context: ExpressionContext,
  names: ReadonlySet<string>,
  env?: Environment,
): { readonly text: string; readonly env: Readonly<Record<string, SecretRef>> } => {
  const bindings = new Map<string, SecretRef>();
  const references = [
    ...site.template.segments.flatMap((segment) => {
      const reference = secretReferenceSegment(segment);
      return reference === undefined ? [] : [reference];
    }),
    ...Object.values(site.captures).flatMap((value) => {
      const reference = secretReferenceOf(value);
      return reference === undefined ? [] : [reference];
    }),
  ];
  let text = "";
  let authored = "";
  let trimNextLiteral = false;
  const lowerSecret = (reference: string) => {
    const position = shellContext(text);
    const refusal = shellInsertionRefusal(position.insertion);
    if (refusal !== undefined || position.dollar || position.refused)
      throw secretBindingError(
        site,
        refusal ?? "a position preceded by an unescaped dollar sign",
        references,
      );
    if (!isSafeShellInsertion(position.insertion))
      throw secretBindingError(site, "a position Lando cannot lower", references);
    const name = boundSecretName(reference);
    bindings.set(name, secretDescriptor(site, reference));
    authored += reference;
    text += loweredSecretText(position.insertion, name);
    trimNextLiteral = false;
  };
  for (const [index, segment] of site.template.segments.entries()) {
    if (segment.kind === "InterpolationSegment" && segment.trimLeft) text = text.replace(/\s+$/u, "");
    if (segment.kind === "SecretRefSegment") {
      lowerSecret(segment.name);
      continue;
    }
    const result = evaluateInvocationSite(
      { ...site, template: { whole: true, segments: [segment] } },
      context,
    );
    const secret = secretReferenceOf(result);
    if (secret !== undefined) {
      lowerSecret(secret);
      continue;
    }
    if (typeof result === "object" && result !== null && "_tag" in result && result._tag === "BoundText")
      throw secretBindingError(site, "text that mixes literal bytes with a secret reference", references);
    const value =
      segment.kind === "LiteralSegment" && trimNextLiteral
        ? String(result).replace(/^\s+/u, "")
        : String(result);
    if (segment.kind !== "CommentSegment")
      trimNextLiteral = segment.kind === "InterpolationSegment" && segment.trimRight;
    if (segment.kind !== "InterpolationSegment" || !readsToolingData(segment.expression, names)) {
      text += value;
      authored += value;
      continue;
    }
    const position = shellContext(text);
    if (position.refused || position.escaped || position.dollar) throw shellBindingError(site);
    const next = nextShellSegment(site.template.segments, index, segment.trimRight);
    const endsWord =
      next === undefined || (next.kind === "LiteralSegment" && /^[\s;|&<>()]/u.test(next.text));
    const ordinaryWord =
      position.quote === undefined &&
      position.word === "" &&
      position.command &&
      !position.redirect &&
      endsWord;
    const raw = expressionScopeMembers(segment.expression, "raw");
    if ((!raw.analyzable || raw.members.size > 0) && !ordinaryWord) throw shellBindingError(site);
    if (Array.isArray(result)) {
      if (!ordinaryWord || result.some((entry) => typeof entry !== "string")) throw shellBindingError(site);
      text += result.map(quoteWord).join(" ");
      authored += result.join(" ");
      continue;
    }
    const quote = position.quote;
    switch (quote) {
      case "single":
        text += value.replaceAll("'", "'\\''");
        break;
      case "double":
        text += value.replace(/[\\"$`]/gu, "\\$&");
        break;
      case undefined:
        text += value === "" && ordinaryWord ? "" : quoteWord(value);
        break;
      default:
        quote satisfies never;
    }
    authored += value;
  }
  for (const [name, descriptor] of bindings) {
    if (authored.includes(name)) throw secretCollisionError(site, name);
    if (env === undefined || !Object.hasOwn(env, name)) continue;
    if (secretReferenceOf(env[name]) !== descriptor.reference) throw secretCollisionError(site, name);
  }
  return { text, env: Object.fromEntries(bindings) };
};
