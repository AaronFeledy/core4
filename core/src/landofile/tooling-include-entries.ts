import { isAbsolute, resolve } from "node:path";

import type { LandofileIncludeError } from "@lando/sdk/errors";
import type { IncludeEntry, LandofileShape, ToolingVarLiteral } from "@lando/sdk/schema";

import { includeError } from "./include-guard.ts";
import { mergeValues } from "./merge.ts";

type ObjectIncludeEntry = Exclude<IncludeEntry, string>;

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

const TOOLING_TRANSPORT_FIELDS = ["path", "version", "checksum"] as const;

const NAMESPACE_REMEDIATION =
  "Set namespace: on the tooling include, or set flatten: true to register its tasks unprefixed.";

const FLATTEN_ALIASES_REMEDIATION =
  "Drop flatten: true to register the aliases as extra namespaces, or remove aliases: from the flattened include.";

const KIND_REMEDIATION =
  'Move the field to a kind: "tooling" include, or drop it from this Landofile fragment include.';
const LOCAL_SOURCE_REMEDIATION =
  "Use a local tooling-fragment path and remove transport-only path, version, or checksum fields.";

const isRemoteSource = (source: string): boolean =>
  source.startsWith("npm:") ||
  source.startsWith("git@") ||
  source.startsWith("github:") ||
  /^https?:\/\//u.test(source);

const sourceFromRoot = (source: string, sourceRoot: string, appRoot: string): string =>
  sourceRoot === appRoot || isAbsolute(source) || isRemoteSource(source)
    ? source
    : resolve(sourceRoot, source);

export const resolveToolingIncludeSourceRoots = (
  landofile: LandofileShape,
  sourceRoot: string,
  appRoot: string,
): LandofileShape => ({
  ...landofile,
  ...(landofile.includes === undefined
    ? {}
    : {
        includes: landofile.includes.map((entry) =>
          typeof entry === "string" || entry.kind !== "tooling"
            ? entry
            : { ...entry, source: sourceFromRoot(entry.source, sourceRoot, appRoot) },
        ),
      }),
  ...(landofile.toolingIncludes === undefined
    ? {}
    : {
        toolingIncludes: Object.fromEntries(
          Object.entries(landofile.toolingIncludes).map(([namespace, entry]) => [
            namespace,
            { ...entry, file: sourceFromRoot(entry.file, sourceRoot, appRoot) },
          ]),
        ),
      }),
});

const canonicalToolingEntries = (
  landofile: Pick<LandofileShape, "includes">,
): ReadonlyArray<ObjectIncludeEntry> =>
  (landofile.includes ?? []).filter(
    (entry): entry is ObjectIncludeEntry => typeof entry !== "string" && entry.kind === "tooling",
  );

const groupByNamespace = (
  source: Pick<LandofileShape, "includes">,
): ReadonlyMap<string, ReadonlyArray<ObjectIncludeEntry>> => {
  const declared = new Map<string, ObjectIncludeEntry[]>();
  for (const entry of canonicalToolingEntries(source)) {
    const key = entry.namespace ?? entry.source;
    const group = declared.get(key);
    if (group === undefined) declared.set(key, [entry]);
    else group.push(entry);
  }
  return declared;
};

/**
 * Compose canonical `kind: tooling` declarations across sources the way the
 * `toolingIncludes:` map composes them: a namespace redeclared by a
 * higher-precedence source overrides, and distinct namespaces accumulate.
 * Ordinary `includes:` arrays carry no merge identity key, so they replace
 * wholesale under Landofile merge rules (later layers override earlier; maps
 * deep-merge, scalar arrays replace); without this a declaration from a
 * lower-precedence layer or a sibling fragment would be dropped instead of
 * composed, breaking the equivalence between the canonical `includes:` form
 * and the `toolingIncludes:` shorthand — both must resolve through one
 * resolver and produce equivalent plans.
 *
 * Declarations made *within* one source are siblings, not overrides: an
 * `includes:` array may legitimately point several fragments at one namespace,
 * which the shorthand map cannot even express. Only a single declaration
 * overriding a single earlier one deep-merges, so a namespace's flags survive
 * a higher layer that only redirects its source.
 */
export const composeToolingIncludeEntries = (
  sources: ReadonlyArray<Pick<LandofileShape, "includes">>,
): ReadonlyArray<ObjectIncludeEntry> => {
  const composed = new Map<string, ReadonlyArray<ObjectIncludeEntry>>();
  for (const source of sources) {
    for (const [key, declared] of groupByNamespace(source)) {
      const existing = composed.get(key);
      const overridden = existing?.length === 1 && declared.length === 1 ? existing[0] : undefined;
      const override = declared[0];
      composed.set(
        key,
        overridden === undefined || override === undefined
          ? declared
          : [mergeValues(overridden, override) as ObjectIncludeEntry],
      );
    }
  }
  return [...composed.values()].flat();
};

export const hasToolingIncludes = (landofile: ToolingIncludeSurface): boolean =>
  Object.keys(landofile.toolingIncludes ?? {}).length > 0 ||
  (landofile.includes ?? []).some((entry) => typeof entry !== "string" && entry.kind === "tooling");

export const assertCompatibleIncludeFields = (
  landofile: ToolingIncludeSurface,
): LandofileIncludeError | undefined => {
  for (const entry of landofile.includes ?? []) {
    if (typeof entry === "string") continue;
    if (entry.kind === "tooling") {
      const offending = TOOLING_TRANSPORT_FIELDS.find((field) => entry[field] !== undefined);
      if (offending !== undefined) {
        return includeError({
          message: `Tooling include ${entry.source} sets unsupported transport field "${offending}".`,
          source: entry.source,
          kind: "forbidden-field",
          remediation: LOCAL_SOURCE_REMEDIATION,
        });
      }
      if (isRemoteSource(entry.source)) {
        return includeError({
          message: `Tooling include ${entry.source} uses an unsupported remote source.`,
          source: entry.source,
          kind: "forbidden-field",
          remediation: LOCAL_SOURCE_REMEDIATION,
        });
      }
      continue;
    }
    const offending = TOOLING_ONLY_FIELDS.find((field) => entry[field] !== undefined);
    if (offending === undefined) continue;
    return includeError({
      message: `Include ${entry.source} sets tooling-only field "${offending}" on a kind: "${entry.kind ?? "landofile"}" include.`,
      source: entry.source,
      kind: "forbidden-field",
      remediation: KIND_REMEDIATION,
    });
  }
  for (const [namespace, entry] of Object.entries(landofile.toolingIncludes ?? {})) {
    if (!isRemoteSource(entry.file)) continue;
    return includeError({
      message: `Tooling include ${namespace} uses an unsupported remote source ${entry.file}.`,
      source: entry.file,
      kind: "forbidden-field",
      remediation: LOCAL_SOURCE_REMEDIATION,
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

/**
 * `aliases:` alias the include-namespace, which `flatten: true` removes, so the
 * pair would be accepted and then ignored: flattening removes the
 * include-namespace the aliases would alias. An include-level `dir:` is
 * rejected for the same reason (task-level `dir:` is itself unsupported, so an
 * include-level working directory would be accepted and then silently have no
 * effect); this guard applies the same fail-closed rule to aliases.
 */
export const assertNamespacing = (entry: NormalizedToolingInclude): LandofileIncludeError | undefined => {
  if (entry.flatten) {
    return entry.aliases.length === 0
      ? undefined
      : includeError({
          message: `Tooling include ${entry.source} sets aliases: with flatten: true, which removes the namespace they would alias.`,
          source: entry.source,
          kind: "forbidden-field",
          remediation: FLATTEN_ALIASES_REMEDIATION,
        });
  }
  return entry.namespace !== undefined && entry.namespace.trim() !== ""
    ? undefined
    : includeError({
        message: `Tooling include ${entry.source} must declare a namespace.`,
        source: entry.source,
        kind: "forbidden-field",
        remediation: NAMESPACE_REMEDIATION,
      });
};
