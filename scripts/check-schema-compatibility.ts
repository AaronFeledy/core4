import { resolve } from "node:path";

import {
  type SchemaArtifactFamily,
  type SchemaArtifactSet,
  SchemaCompatibilityInputError,
  loadCompatibilityExceptions,
  loadWorkingSchemaArtifacts,
} from "./schema-compatibility-artifacts.ts";
import {
  SCHEMA_SNAPSHOT_GENERATOR_PATH,
  regenerateBaseSchemaArtifacts,
} from "./schema-compatibility-baseline.ts";
import type { AcceptCompatibilityOptions } from "./schema-compatibility/accept-exceptions.ts";
import {
  type CompatibilityException,
  type CompatibilityFinding,
  acceptCompatibilityExceptions,
  classifySchemaChange,
} from "./schema-compatibility/classifier.ts";
import type { JsonSchema } from "./schema-compatibility/model.ts";
import { buildPersistedSurfaceStores, readPersistedStoreVersions } from "./schema-compatibility/persisted.ts";
import { loadBasePersistedStoreVersions } from "./schema-compatibility/store-versions.ts";

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
  readonly ok: boolean;
}

export interface SchemaCompatibilitySkip {
  readonly family: SchemaArtifactFamily;
  readonly count: number;
  readonly generatorPath: string;
  readonly baseRef: string;
}

const FAMILY_METADATA = {
  sdk: { prefix: "schema:", label: "SDK schemas" },
  command: {
    prefix: "command:",
    label: "command schemas",
  },
} as const satisfies Record<SchemaArtifactFamily, { readonly prefix: string; readonly label: string }>;

export const skippedFamilyNotices = (
  after: SchemaArtifactSet,
  baseRef: string,
  unavailableFamilies: ReadonlyArray<SchemaArtifactFamily>,
): ReadonlyArray<SchemaCompatibilitySkip> =>
  unavailableFamilies.map((family) => ({
    family,
    count: [...after.keys()].filter((surface) => surface.startsWith(FAMILY_METADATA[family].prefix)).length,
    generatorPath: SCHEMA_SNAPSHOT_GENERATOR_PATH,
    baseRef,
  }));

const comparableArtifacts = (
  after: SchemaArtifactSet,
  unavailableFamilies: ReadonlyArray<SchemaArtifactFamily>,
): SchemaArtifactSet => {
  const unavailablePrefixes = unavailableFamilies.map((family) => FAMILY_METADATA[family].prefix);
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

const publishedSchemaIdsFromArtifacts = (artifacts: SchemaArtifactSet): Set<string> => {
  const ids = new Set<string>();
  for (const surface of artifacts.keys()) {
    if (surface.startsWith("schema:")) ids.add(surface.slice("schema:".length));
  }
  return ids;
};

const compareArtifactSets = (
  before: SchemaArtifactSet,
  after: SchemaArtifactSet,
  policy: AcceptCompatibilityOptions & { readonly exceptions: ReadonlyArray<CompatibilityException> },
): ReadonlyArray<SurfaceCompatibilityFinding> => {
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
          accepted: false,
        },
      ];
    } else if (oldArtifact !== undefined && newArtifact !== undefined) {
      findings = classifySchemaChange(oldArtifact.schema, newArtifact.schema, newArtifact.polarity);
    } else {
      findings = [];
    }
    return acceptCompatibilityExceptions(surface, findings, policy.exceptions, policy).map((entry) => ({
      ...entry,
      surface,
    }));
  });
};

export const checkSchemaCompatibility = async (
  baseRef = process.env.LANDO_SCHEMA_COMPATIBILITY_BASE_REF ?? DEFAULT_BASE_REF,
): Promise<SchemaCompatibilityResult> => {
  const [after, exceptions] = await Promise.all([
    loadWorkingSchemaArtifacts(REPO_ROOT),
    loadCompatibilityExceptions(EXCEPTIONS_PATH),
  ]);
  const storeVersions = readPersistedStoreVersions();
  const before = await regenerateBaseSchemaArtifacts({ repoRoot: REPO_ROOT, baseRef });
  const baseStoreVersions = await loadBasePersistedStoreVersions(REPO_ROOT, baseRef);
  const skips = skippedFamilyNotices(after, baseRef, before.unavailableFamilies);
  const persistedStoresBySurface = buildPersistedSurfaceStores(
    rootSchemasFromArtifacts(after),
    new Set([
      ...publishedSchemaIdsFromArtifacts(after),
      ...publishedSchemaIdsFromArtifacts(before.artifacts),
    ]),
    rootSchemasFromArtifacts(before.artifacts),
  );
  const findings = compareArtifactSets(
    before.artifacts,
    comparableArtifacts(after, before.unavailableFamilies),
    { exceptions, persistedStoresBySurface, storeVersions, baseStoreVersions },
  );
  return {
    baseRef,
    findings,
    skips,
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
      `SKIPPED ${FAMILY_METADATA[skip.family].label}: base ${skip.baseRef} predates ${skip.generatorPath}; skipped ${skip.count} current surfaces.\n`,
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
