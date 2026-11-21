import { LandofileValidationError } from "@lando/sdk/errors";
import {
  type ExpressionSegment,
  type ExpressionTemplate,
  expressionInterpolationsTouchOnlyScopes,
  expressionTouchesOnlyScopes,
} from "@lando/sdk/expressions";
import { HostAliasName, type ParsedPendingSite, type ValidationIssuePath } from "@lando/sdk/schema";
import { Result, Schema } from "effect";
import { consumeSites, replaceSiteValue } from "./compiled-sites.ts";
import { type LoadFailureRecorder, loadPathBlocked } from "./load-failures.ts";
import { valueAtPath } from "./validation-suggestions.ts";

export const extraHostListPath = (path: ValidationIssuePath): boolean =>
  path.length === 4 && path[0] === "services" && path[2] === "extra_hosts" && typeof path[3] === "number";

const templateOf = (segments: readonly ExpressionSegment[]): ExpressionTemplate => ({
  whole: segments.length === 1 && segments[0]?.kind === "InterpolationSegment",
  segments,
});

/** Split at the first literal separator, not at punctuation inside a template tag. */
const extraHostTemplates = (template: ExpressionTemplate) => {
  for (const [index, segment] of template.segments.entries()) {
    if (segment.kind !== "LiteralSegment") continue;
    const separator = segment.text.search(/[:=]/);
    if (separator < 0) continue;
    const left = segment.text.slice(0, separator);
    const right = segment.text.slice(separator + 1);
    return {
      host: templateOf([...template.segments.slice(0, index), ...(left ? [{ ...segment, text: left }] : [])]),
      address: templateOf([
        ...(right ? [{ ...segment, text: right }] : []),
        ...template.segments.slice(index + 1),
      ]),
    };
  }
  return undefined;
};

export const deferredExtraHostKey = (template: ExpressionTemplate): boolean => {
  const host = extraHostTemplates(template)?.host;
  return host !== undefined && !expressionTouchesOnlyScopes(host, ["recipe", "env"]);
};

const extraHostParts = Symbol("deferred extra_hosts parts");
type ExtraHostTemplate = ExpressionTemplate & {
  readonly [extraHostParts]?:
    | "missing-separator"
    | {
        readonly host: ExpressionTemplate;
        readonly address: ExpressionTemplate;
        readonly addressText: string;
      };
};

export const compileExtraHostParts = (
  template: ExpressionTemplate,
  entry: string,
  separator: number | undefined,
): ExtraHostTemplate => {
  if (expressionInterpolationsTouchOnlyScopes(template, ["recipe", "env"])) return template;
  const split = extraHostTemplates(template);
  return {
    ...template,
    [extraHostParts]:
      split === undefined || separator === undefined
        ? "missing-separator"
        : { ...split, addressText: entry.slice(separator + 1) },
  };
};

type PreparedExtraHost = { readonly host: string; readonly address: ExpressionTemplate };
export type PreparedExtraHosts = ReadonlyMap<string, PreparedExtraHost>;

export const prepareDeferredExtraHosts = (
  document: Record<string, unknown>,
  sites: readonly (ParsedPendingSite & { readonly template: ExtraHostTemplate })[],
  scope: {
    readonly file: string;
    readonly env: Readonly<Record<string, string>>;
    readonly recipe: Readonly<Record<string, unknown>> | undefined;
    readonly recorder: LoadFailureRecorder;
  },
) => {
  let value: unknown = document;
  const prepared = new Map<string, PreparedExtraHost>();
  for (const site of sites) {
    const parts = site.template[extraHostParts];
    if (parts === undefined || loadPathBlocked(scope.recorder, site.source)) continue;
    const file = "file" in site.source ? site.source.file : scope.file;
    if (parts === "missing-separator") {
      const { source } = site;
      const message = "A deferred extra_hosts entry needs a literal hostname/address separator.";
      const suggestion = "Put HOST= or HOST: before the address expression.";
      scope.recorder.record(
        new LandofileValidationError({
          file,
          message,
          remediation: suggestion,
          issues: [{ rule: "unsupported-expression", path: source.path, source, message, suggestion }],
        }),
        { kind: "local", source },
      );
      continue;
    }
    const evaluated = consumeSites({
      document: valueAtPath(value, site.path),
      pathPrefix: site.source.path,
      pendingSites: [{ ...site, path: site.source.path, template: parts.host }],
      context: { env: scope.env, recipe: scope.recipe },
      scopes: ["recipe", "env"],
    });
    if (Result.isFailure(evaluated)) {
      scope.recorder.record(evaluated.failure, { kind: "local", source: site.source });
      continue;
    }
    const host = evaluated.success.document;
    if (!Schema.is(HostAliasName)(host)) {
      const message = "Invalid extra_hosts hostname.";
      const suggestion = "Use an ASCII hostname without a scheme, port, path, or separator.";
      scope.recorder.record(
        new LandofileValidationError({
          file,
          message,
          remediation: suggestion,
          issues: [
            { rule: "landofile.hostname", path: site.source.path, source: site.source, message, suggestion },
          ],
        }),
        { kind: "local", source: site.source },
      );
      continue;
    }
    prepared.set(site.id, { host, address: parts.address });
    value = replaceSiteValue(value, site.path, `${host}=${parts.addressText}`);
  }
  return { value, prepared };
};

export const extraHostDestination = (
  entries: readonly unknown[],
  index: number,
  target: { readonly host: string; readonly decoded: Readonly<Record<string, unknown>> },
): ValidationIssuePath | undefined => {
  const { host, decoded } = target;
  if (!Object.hasOwn(decoded, host)) return undefined;
  if (!Array.isArray(decoded[host])) return [host];
  // Literal entries occupy positions too, including duplicates of the same address.
  return [
    host,
    entries
      .slice(0, index)
      .filter(
        (entry) =>
          typeof entry === "string" && (entry.startsWith(`${host}=`) || entry.startsWith(`${host}:`)),
      ).length,
  ];
};
