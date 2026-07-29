import type { LandofileIncludeError } from "@lando/sdk/errors";
import type { IncludeEntry, LandofileShape, ToolingVarLiteral } from "@lando/sdk/schema";

import { includeError } from "./include-guard.ts";

export interface NormalizedToolingInclude {
  readonly source: string;
  readonly namespace: string | undefined;
  readonly flatten: boolean;
  readonly internal: boolean;
  readonly optional: boolean;
  readonly aliases: ReadonlyArray<string>;
  readonly excludes: ReadonlyArray<string>;
  readonly vars: Readonly<Record<string, ToolingVarLiteral>>;
}

type ToolingIncludeSurface = Pick<LandofileShape, "includes" | "toolingIncludes">;

const TOOLING_ONLY_FIELDS = [
  "namespace",
  "flatten",
  "internal",
  "optional",
  "aliases",
  "excludes",
  "vars",
] as const;

const NAMESPACE_REMEDIATION =
  "Set namespace: on the tooling include, or set flatten: true to register its tasks unprefixed.";

const KIND_REMEDIATION =
  'Move the field to a kind: "tooling" include, or drop it from this Landofile fragment include.';

export const hasToolingIncludes = (landofile: ToolingIncludeSurface): boolean =>
  Object.keys(landofile.toolingIncludes ?? {}).length > 0 ||
  (landofile.includes ?? []).some((entry) => typeof entry !== "string" && entry.kind === "tooling");

export const assertNoToolingFieldsOnNonToolingIncludes = (
  landofile: ToolingIncludeSurface,
): LandofileIncludeError | undefined => {
  for (const entry of landofile.includes ?? []) {
    if (typeof entry === "string" || entry.kind === "tooling") continue;
    const offending = TOOLING_ONLY_FIELDS.find((field) => entry[field] !== undefined);
    if (offending === undefined) continue;
    return includeError({
      message: `Include ${entry.source} sets tooling-only field "${offending}" on a kind: "${entry.kind ?? "landofile"}" include.`,
      source: entry.source,
      kind: "forbidden-field",
      remediation: KIND_REMEDIATION,
    });
  }
  return undefined;
};

const normalizeEntry = (input: {
  readonly source: string;
  readonly namespace: string | undefined;
  readonly flatten: boolean | undefined;
  readonly internal: boolean | undefined;
  readonly optional: boolean | undefined;
  readonly aliases: ReadonlyArray<string> | undefined;
  readonly excludes: ReadonlyArray<string> | undefined;
  readonly vars: Readonly<Record<string, ToolingVarLiteral>> | undefined;
}): NormalizedToolingInclude => ({
  source: input.source,
  namespace: input.namespace,
  flatten: input.flatten === true,
  internal: input.internal === true,
  optional: input.optional === true,
  aliases: input.aliases ?? [],
  excludes: input.excludes ?? [],
  vars: input.vars ?? {},
});

const fromIncludesArray = (entries: ReadonlyArray<IncludeEntry>): ReadonlyArray<NormalizedToolingInclude> =>
  entries.flatMap((entry) =>
    typeof entry === "string" || entry.kind !== "tooling"
      ? []
      : [
          normalizeEntry({
            source: entry.source,
            namespace: entry.namespace,
            flatten: entry.flatten,
            internal: entry.internal,
            optional: entry.optional,
            aliases: entry.aliases,
            excludes: entry.excludes,
            vars: entry.vars,
          }),
        ],
  );

const fromShorthandMap = (
  map: NonNullable<LandofileShape["toolingIncludes"]>,
): ReadonlyArray<NormalizedToolingInclude> =>
  Object.entries(map).map(([namespace, entry]) =>
    normalizeEntry({
      source: entry.file,
      namespace,
      flatten: entry.flatten,
      internal: entry.internal,
      optional: entry.optional,
      aliases: entry.aliases,
      excludes: entry.excludes,
      vars: entry.vars,
    }),
  );

export const normalizeToolingIncludes = (
  landofile: ToolingIncludeSurface,
): ReadonlyArray<NormalizedToolingInclude> => [
  ...fromIncludesArray(landofile.includes ?? []),
  ...fromShorthandMap(landofile.toolingIncludes ?? {}),
];

export const assertNamespaced = (entry: NormalizedToolingInclude): LandofileIncludeError | undefined =>
  entry.flatten || (entry.namespace !== undefined && entry.namespace.trim() !== "")
    ? undefined
    : includeError({
        message: `Tooling include ${entry.source} must declare a namespace.`,
        source: entry.source,
        kind: "forbidden-field",
        remediation: NAMESPACE_REMEDIATION,
      });
