import { resolve } from "node:path";
import { buildPersistedSchemaSnapshot } from "./build-persisted-schema-snapshot.ts";
import type { AcceptCompatibilityOptions } from "./schema-compatibility/accept-exceptions.ts";
import {
  type CompatibilityException,
  type CompatibilityFinding,
  acceptCompatibilityExceptions,
  classifySchemaChange,
} from "./schema-compatibility/classifier.ts";
import { loadCompatibilityExceptions } from "./schema-compatibility/exceptions.ts";
import { changeFingerprint } from "./schema-compatibility/fingerprint.ts";
import type { JsonSchema } from "./schema-compatibility/model.ts";
import { normalizeJsonSchema } from "./schema-compatibility/normalize.ts";
import {
  buildPersistedSurfaceStores,
  legacyAppliedPayload,
  readPersistedStoreVersions,
} from "./schema-compatibility/persisted.ts";
import { loadBasePersistedStoreVersions } from "./schema-compatibility/store-versions.ts";
import { suggestCompatibilityExceptions } from "./schema-compatibility/suggest-exceptions.ts";
import {
  SCHEMA_ARTIFACT_FAMILIES,
  type SchemaArtifactFamily,
  type SchemaArtifactSet,
  SchemaCompatibilityInputError,
  loadWorkingSchemaArtifacts,
} from "./schema-compatibility-artifacts.ts";
import { regenerateBaseSchemaArtifacts } from "./schema-compatibility-baseline.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const DEFAULT_BASE_REF = "origin/main";
const EXCEPTIONS_PATH = resolve(REPO_ROOT, "sdk/compatibility-exceptions.json");

export interface SurfaceCompatibilityFinding extends CompatibilityFinding {
  readonly surface: string;
}

export interface SchemaCompatibilityResult {
  readonly baseRef: string;
  readonly findings: ReadonlyArray<SurfaceCompatibilityFinding>;
  readonly skips: ReadonlyArray<SchemaCompatibilitySkip>;
  /** Entries to review and record for every finding no exception covers. */
  readonly suggestions: ReadonlyArray<CompatibilityException>;
  readonly ok: boolean;
}

export interface SchemaCompatibilitySkip {
  readonly family: SchemaArtifactFamily;
  readonly count: number;
  readonly generatorPath: string;
  readonly baseRef: string;
}

export const skippedFamilyNotices = (
  after: SchemaArtifactSet,
  baseRef: string,
  unavailableFamilies: ReadonlyArray<SchemaArtifactFamily>,
): ReadonlyArray<SchemaCompatibilitySkip> =>
  unavailableFamilies.map((family) => ({
    family,
    count: [...after.keys()].filter((surface) => surface.startsWith(SCHEMA_ARTIFACT_FAMILIES[family].prefix))
      .length,
    generatorPath: SCHEMA_ARTIFACT_FAMILIES[family].generatorPath,
    baseRef,
  }));

const comparableArtifacts = (
  after: SchemaArtifactSet,
  unavailableFamilies: ReadonlyArray<SchemaArtifactFamily>,
): SchemaArtifactSet => {
  const unavailablePrefixes = unavailableFamilies.map((family) => SCHEMA_ARTIFACT_FAMILIES[family].prefix);
  return new Map(
    [...after].filter(([surface]) => !unavailablePrefixes.some((prefix) => surface.startsWith(prefix))),
  );
};

const rootSchemasFromArtifacts = (artifacts: SchemaArtifactSet): Map<string, JsonSchema> => {
  const roots = new Map<string, JsonSchema>();
  for (const [surface, artifact] of artifacts) {
    if (!surface.startsWith("schema:")) continue;
    roots.set(surface.slice("schema:".length), artifact.schema);
  }
  return roots;
};

/** Adds the store bindings that internal persisted artifacts declare themselves. */
const withArtifactStores = (
  before: SchemaArtifactSet,
  after: SchemaArtifactSet,
  policy: AcceptCompatibilityOptions,
): Required<AcceptCompatibilityOptions> => {
  const persistedStoresBySurface = new Map(policy.persistedStoresBySurface);
  const storeVersions = { ...policy.storeVersions };
  const baseStoreVersions = { ...policy.baseStoreVersions };
  for (const artifact of before.values()) {
    if (artifact.persistedState === undefined) continue;
    const { store, version } = artifact.persistedState;
    persistedStoresBySurface.set(artifact.surface, new Set([store]));
    baseStoreVersions[store] = version;
  }
  for (const artifact of after.values()) {
    if (artifact.persistedState === undefined) continue;
    const { store, version } = artifact.persistedState;
    persistedStoresBySurface.set(artifact.surface, new Set([store]));
    storeVersions[store] = version;
  }
  return { persistedStoresBySurface, storeVersions, baseStoreVersions };
};

export const compareArtifactSets = (
  before: SchemaArtifactSet,
  after: SchemaArtifactSet,
  policy: AcceptCompatibilityOptions & { readonly exceptions: ReadonlyArray<CompatibilityException> },
): ReadonlyArray<SurfaceCompatibilityFinding> => {
  const options = withArtifactStores(before, after, policy);
  const surfaces = [...new Set([...before.keys(), ...after.keys()])].sort();
  return surfaces.flatMap((surface) => {
    const oldArtifact = before.get(surface);
    const newArtifact = after.get(surface);
    let findings: ReadonlyArray<CompatibilityFinding>;
    if (oldArtifact === undefined && newArtifact !== undefined) {
      findings = [
        {
          verdict: "compatible",
          changeKind: "surface-added",
          path: "$",
          message: "A public schema surface was added.",
          fingerprint: changeFingerprint("surface-added", undefined, normalizeJsonSchema(newArtifact.schema)),
          accepted: false,
        },
      ];
    } else if (oldArtifact !== undefined && newArtifact === undefined) {
      findings = [
        {
          verdict: "breaking",
          changeKind: "surface-removed",
          path: "$",
          message: "A public schema surface was removed.",
          fingerprint: changeFingerprint(
            "surface-removed",
            normalizeJsonSchema(oldArtifact.schema),
            undefined,
          ),
          accepted: false,
        },
      ];
    } else if (oldArtifact !== undefined && newArtifact !== undefined) {
      findings = classifySchemaChange(oldArtifact.schema, newArtifact.schema, newArtifact.polarity);
    } else {
      findings = [];
    }
    return acceptCompatibilityExceptions(surface, findings, policy.exceptions, options).map((entry) => ({
      ...entry,
      surface,
    }));
  });
};

export const checkSchemaCompatibility = async (
  baseRef = process.env.LANDO_SCHEMA_COMPATIBILITY_BASE_REF ?? DEFAULT_BASE_REF,
): Promise<SchemaCompatibilityResult> => {
  await buildPersistedSchemaSnapshot();
  const [after, exceptions] = await Promise.all([
    loadWorkingSchemaArtifacts(REPO_ROOT),
    loadCompatibilityExceptions(EXCEPTIONS_PATH),
  ]);
  const storeVersions = readPersistedStoreVersions();
  const before = await regenerateBaseSchemaArtifacts({ repoRoot: REPO_ROOT, baseRef });
  const baseStoreVersions = await loadBasePersistedStoreVersions(REPO_ROOT, baseRef, before.artifacts);
  const skips = skippedFamilyNotices(after, baseRef, before.unavailableFamilies);
  const afterRoots = rootSchemasFromArtifacts(after);
  const beforeRoots = rootSchemasFromArtifacts(before.artifacts);
  const persistedStoresBySurface = buildPersistedSurfaceStores(
    afterRoots,
    new Set([...afterRoots.keys(), ...beforeRoots.keys()]),
    beforeRoots,
  );
  const baseline = new Map(before.artifacts);
  const legacy = baseline.get("schema:AppPlan");
  if (legacy !== undefined && !baseline.has("schema:AppliedAppPlan")) {
    const surface = "schema:AppliedAppPlan";
    baseline.set(surface, { ...legacy, surface, schema: legacyAppliedPayload(legacy.schema) });
  }
  const comparable = comparableArtifacts(after, before.unavailableFamilies);
  const policy = { persistedStoresBySurface, storeVersions, baseStoreVersions };
  const findings = compareArtifactSets(baseline, comparable, { ...policy, exceptions });
  return {
    baseRef,
    findings,
    skips,
    suggestions: suggestCompatibilityExceptions(
      findings,
      exceptions,
      withArtifactStores(baseline, comparable, policy),
    ),
    ok: findings.every((entry) => entry.accepted || entry.verdict === "compatible"),
  };
};

const formatFinding = (entry: SurfaceCompatibilityFinding): string => {
  const status = entry.accepted ? `ACCEPTED ${entry.verdict.toUpperCase()}` : entry.verdict.toUpperCase();
  const justification = entry.justification === undefined ? "" : ` Accepted: ${entry.justification}`;
  return `${status} ${entry.surface} ${entry.changeKind} ${entry.path}: ${entry.message}${justification}`;
};

const main = async (): Promise<void> => {
  const result = await checkSchemaCompatibility();
  for (const skip of result.skips) {
    process.stdout.write(
      `SKIPPED ${SCHEMA_ARTIFACT_FAMILIES[skip.family].label}: base ${skip.baseRef} predates ${skip.generatorPath}; skipped ${skip.count} current surfaces. Compare against a base containing this generator once it lands (LANDO_SCHEMA_COMPATIBILITY_BASE_REF=<ref>).\n`,
    );
  }
  for (const entry of result.findings) process.stdout.write(`${formatFinding(entry)}\n`);
  const counts = {
    compatible: result.findings.filter((entry) => entry.verdict === "compatible").length,
    breaking: result.findings.filter((entry) => entry.verdict === "breaking" && !entry.accepted).length,
    unknown: result.findings.filter((entry) => entry.verdict === "unknown" && !entry.accepted).length,
    accepted: result.findings.filter((entry) => entry.accepted).length,
    skipped: result.skips.reduce((total, skip) => total + skip.count, 0),
  };
  process.stdout.write(
    `[schema-compatibility] base=${result.baseRef} compatible=${counts.compatible} breaking=${counts.breaking} unknown=${counts.unknown} accepted=${counts.accepted} skipped=${counts.skipped}\n`,
  );
  if (result.suggestions.length > 0) {
    process.stdout.write(
      `[schema-compatibility] ${result.suggestions.length} unreviewed change(s). After review, add each entry below to sdk/compatibility-exceptions.json (an entry whose fingerprint already exists replaces it) and write its justification:\n${JSON.stringify(result.suggestions, null, 2)}\n`,
    );
  }
  if (!result.ok) process.exitCode = 1;
};

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    if (error instanceof SchemaCompatibilityInputError) {
      process.stderr.write(
        `[schema-compatibility] ${error.message}${error.detail === undefined ? "" : ` ${error.detail}`}\n`,
      );
      process.exitCode = 1;
    } else {
      throw error;
    }
  }
}
