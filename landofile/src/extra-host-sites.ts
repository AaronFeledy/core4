import {
  type ExpressionSegment,
  type ExpressionTemplate,
  expressionInterpolationsTouchOnlyScopes,
  expressionTouchesOnlyScopes,
} from "@lando/sdk/expressions";
import type { ParsedPendingSite, ValidationIssuePath } from "@lando/sdk/schema";

export const extraHostListPath = (path: ValidationIssuePath): boolean =>
  path.length === 4 && path[0] === "services" && path[2] === "extra_hosts" && typeof path[3] === "number";

const templateOf = (segments: readonly ExpressionSegment[]): ExpressionTemplate => ({
  whole: segments.length === 1 && segments[0]?.kind === "InterpolationSegment",
  segments,
});

/** Split at the first literal separator, not at punctuation inside a template tag. */
export const extraHostTemplates = (template: ExpressionTemplate) => {
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

const hostnameLoadTemplate = Symbol("extra_hosts hostname load template");
type ExtraHostTemplate = ExpressionTemplate & { readonly [hostnameLoadTemplate]?: ExpressionTemplate };

export const withExtraHostLoadTemplate = (
  template: ExpressionTemplate,
  entry: string,
  separator: number | undefined,
): ExtraHostTemplate => {
  if (separator === undefined) return template;
  const split = extraHostTemplates(template);
  if (
    split === undefined ||
    expressionInterpolationsTouchOnlyScopes(split.address, ["recipe", "env"]) ||
    (split.host.segments.length === 1 &&
      split.host.segments[0]?.kind === "LiteralSegment" &&
      split.host.segments[0].text === entry.slice(0, separator))
  )
    return template;
  return {
    ...template,
    [hostnameLoadTemplate]: templateOf([
      ...split.host.segments,
      { kind: "LiteralSegment", text: entry.slice(separator) },
    ]),
  };
};

export const projectExtraHostForLoad = (
  site: ParsedPendingSite & { readonly template: ExtraHostTemplate },
): ParsedPendingSite => {
  const template = site.template[hostnameLoadTemplate];
  return template === undefined ? site : { ...site, template };
};

export const extraHostDestination = (
  entries: readonly unknown[],
  index: number,
  decoded: Readonly<Record<string, unknown>>,
): ValidationIssuePath | undefined => {
  const hostname = (entry: unknown) => (typeof entry === "string" ? entry.split(/[:=]/, 1)[0] : undefined);
  const host = hostname(entries[index]);
  if (host === undefined || !Object.hasOwn(decoded, host)) return undefined;
  if (!Array.isArray(decoded[host])) return [host];
  // Literal entries occupy positions too, including duplicates of the same address.
  return [host, entries.slice(0, index).filter((entry) => hostname(entry) === host).length];
};
