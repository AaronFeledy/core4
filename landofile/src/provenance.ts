import { type ValueOrigins, type ValueWithOrigins, withValueOrigins } from "@lando/sdk/landofile";
import type { LandofileLayer, ValidationIssue } from "@lando/sdk/schema";
import {
  type EnvironmentDependencies,
  emptyEnvironmentDependencies,
  unionEnvironmentDependencies,
} from "./environment-dependencies.ts";
import type { VersionConstraintEntry } from "./version-constraint.ts";

export type AuthoredOrigin = Extract<
  NonNullable<ValidationIssue["source"]>,
  { readonly layer: LandofileLayer }
>;

export interface SourceDocument {
  readonly file: string;
  readonly form: "yaml" | "typescript";
  readonly layer: LandofileLayer;
  readonly document: unknown;
  readonly content: string;
  readonly digest: string;
}

export interface LandofileIncludeSource {
  readonly id: string;
  readonly sha256: string;
}

export interface LandofileReferencedFile {
  readonly absolutePath: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly sha256: string;
}

export interface LandofileProvenance {
  /** Entry path selected by the loader, independently of which layer owns a value. */
  readonly landofilePath?: string;
  readonly origins: ValueOrigins<AuthoredOrigin>;
  /** Authored overlays retained for a resolved include tree, in composition order. */
  readonly overlays: readonly ValueWithOrigins<AuthoredOrigin>[];
  readonly documents: readonly SourceDocument[];
  readonly appRoot: string | undefined;
  readonly localIncludePaths: readonly string[];
  readonly includeSources: readonly LandofileIncludeSource[];
  readonly referencedFiles: readonly LandofileReferencedFile[];
  readonly environmentDependencies: EnvironmentDependencies;
  /** Tooling task ids Lando generated rather than the author declaring them. */
  readonly internalToolingTasks: readonly string[];
  readonly versionConstraints: readonly VersionConstraintEntry[];
}

export interface AuthoredDocument {
  readonly value: Record<string, unknown>;
  readonly provenance: LandofileProvenance;
}

export const emptyProvenance = (origins: ValueOrigins<AuthoredOrigin>): LandofileProvenance => ({
  origins,
  overlays: [],
  documents: [],
  appRoot: undefined,
  localIncludePaths: [],
  includeSources: [],
  referencedFiles: [],
  environmentDependencies: emptyEnvironmentDependencies(),
  internalToolingTasks: [],
  versionConstraints: [],
});

/**
 * Provenance for a raw authored layer: every value in `value` came from the
 * file and layer `origin` names. This is the acquisition boundary, where a new
 * document's provenance is created rather than copied.
 */
export const authoredDocumentFrom = (
  value: Record<string, unknown>,
  origin: AuthoredOrigin,
): AuthoredDocument => ({
  value,
  provenance: emptyProvenance(withValueOrigins(value, (path) => ({ ...origin, path })).origins),
});

export const normalizeLocalIncludePaths = (paths: Iterable<string>): ReadonlyArray<string> =>
  [...new Set(paths)].sort((left, right) => left.localeCompare(right));

export const normalizeIncludeSources = (
  sources: Iterable<LandofileIncludeSource>,
): ReadonlyArray<LandofileIncludeSource> =>
  [...new Map([...sources].map((source) => [source.id, source])).values()].sort((left, right) =>
    left.id.localeCompare(right.id),
  );

export const normalizeReferencedFiles = (
  files: Iterable<LandofileReferencedFile>,
): ReadonlyArray<LandofileReferencedFile> =>
  [...new Map([...files].map((file) => [file.absolutePath, file])).values()].sort((left, right) =>
    left.absolutePath.localeCompare(right.absolutePath),
  );

const isLandofileProvenance = (value: unknown): value is LandofileProvenance =>
  typeof value === "object" && value !== null && "origins" in value && "documents" in value;

/**
 * Compiled carriers allow absent opaque provenance, including hand-built carriers.
 */
export const provenanceOf = (value: object | undefined | null): LandofileProvenance | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate: unknown = Reflect.get(value, "provenance");
  return isLandofileProvenance(candidate) ? candidate : undefined;
};

/**
 * Union the provenance of composed layers. Origins come from the merge that
 * consumed every layer, so no part can be re-inferred from the output value.
 */
export const combineProvenance = (
  parts: readonly LandofileProvenance[],
  origins: ValueOrigins<AuthoredOrigin>,
): LandofileProvenance => {
  const appRoot = [...parts].reverse().find((part) => part.appRoot !== undefined)?.appRoot;
  return {
    origins,
    overlays: parts.flatMap((part) => part.overlays),
    documents: parts.flatMap((part) => part.documents),
    appRoot,
    localIncludePaths: normalizeLocalIncludePaths(parts.flatMap((part) => part.localIncludePaths)),
    includeSources: normalizeIncludeSources(parts.flatMap((part) => part.includeSources)),
    referencedFiles: normalizeReferencedFiles(parts.flatMap((part) => part.referencedFiles)),
    environmentDependencies: unionEnvironmentDependencies(
      ...parts.map((part) => part.environmentDependencies),
    ),
    internalToolingTasks: [...new Set(parts.flatMap((part) => part.internalToolingTasks))],
    versionConstraints: parts.flatMap((part) => part.versionConstraints),
  };
};

/**
 * Recorded `lando:` constraints, or the canonical layer's own range when the
 * caller holds a value that predates composition (a hand-built carrier).
 */
export const versionConstraintsFor = (
  provenance: LandofileProvenance | undefined,
  landofile: { readonly lando?: string | undefined },
  fallbackSource: string,
): readonly VersionConstraintEntry[] => {
  if (provenance !== undefined && provenance.versionConstraints.length > 0)
    return provenance.versionConstraints;
  return typeof landofile.lando !== "string"
    ? []
    : [{ range: landofile.lando, source: fallbackSource, layer: "canonical", order: 3 }];
};

export const withAppRootProvenance = <T extends object>(value: T, appRoot: string): T => {
  const provenance = provenanceOf(value);
  return provenance === undefined ? value : { ...value, provenance: { ...provenance, appRoot } };
};
