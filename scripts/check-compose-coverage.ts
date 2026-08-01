import { resolve } from "node:path";

import {
  type ComposeDispositionEntry,
  composeServiceDispositions,
  composeTopLevelDispositions,
} from "../core/src/landofile/compose/dispositions.ts";
import {
  type ComposeCoverageDiff,
  collectComposeServiceKeyPaths,
  collectComposeTopLevelKeyPaths,
  compareComposeCoverage,
} from "./compose-schema.ts";
import { type ComposeVendorChecksumResult, verifyComposeVendorChecksum } from "./compose-vendor.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");

interface CheckComposeCoverageOptions {
  readonly pinPath?: string;
  readonly schemaPath?: string;
  readonly serviceDispositions?: Readonly<Record<string, ComposeDispositionEntry>>;
  readonly topLevelDispositions?: Readonly<Record<string, ComposeDispositionEntry>>;
}

export interface ComposeCoverageResult {
  readonly ok: boolean;
  readonly checksum: ComposeVendorChecksumResult;
  readonly service: ComposeCoverageDiff;
  readonly topLevel: ComposeCoverageDiff;
  readonly servicePathCount: number;
  readonly topLevelPathCount: number;
}

export const checkComposeCoverage = async (
  options: CheckComposeCoverageOptions = {},
): Promise<ComposeCoverageResult> => {
  const pinPath = options.pinPath ?? resolve(REPO_ROOT, "vendor/compose/pin.json");
  const schemaPath = options.schemaPath ?? resolve(REPO_ROOT, "vendor/compose/compose-spec.json");
  const serviceDispositions = options.serviceDispositions ?? composeServiceDispositions;
  const topLevelDispositions = options.topLevelDispositions ?? composeTopLevelDispositions;
  const schema: unknown = JSON.parse(await Bun.file(schemaPath).text());
  const servicePaths = collectComposeServiceKeyPaths(schema);
  const topLevelPaths = collectComposeTopLevelKeyPaths(schema);
  const checksum = await verifyComposeVendorChecksum({ pinPath, schemaPath });
  const service = compareComposeCoverage(servicePaths, Object.keys(serviceDispositions));
  const topLevel = compareComposeCoverage(topLevelPaths, Object.keys(topLevelDispositions));
  const ok =
    checksum.ok &&
    service.missingFromMatrix.length === 0 &&
    service.missingFromSchema.length === 0 &&
    topLevel.missingFromMatrix.length === 0 &&
    topLevel.missingFromSchema.length === 0;

  return {
    ok,
    checksum,
    service,
    topLevel,
    servicePathCount: servicePaths.length,
    topLevelPathCount: topLevelPaths.length,
  };
};

const formatPaths = (label: string, paths: ReadonlyArray<string>): string =>
  paths.length === 0 ? "" : `${label}:\n${paths.map((path) => `  - ${path}`).join("\n")}\n`;

export const formatComposeCoverageFailure = (result: ComposeCoverageResult): string =>
  [
    "Compose coverage check failed.\n",
    result.checksum.ok
      ? ""
      : `Vendored schema checksum mismatch: expected ${result.checksum.expectedSha256}, received ${result.checksum.actualSha256}.\n`,
    formatPaths("Unclassified service key paths", result.service.missingFromMatrix),
    formatPaths("Service matrix entries missing from schema", result.service.missingFromSchema),
    formatPaths("Unclassified top-level key paths", result.topLevel.missingFromMatrix),
    formatPaths("Top-level matrix entries missing from schema", result.topLevel.missingFromSchema),
  ].join("");

if (import.meta.main) {
  const result = await checkComposeCoverage();
  if (result.ok) {
    process.stdout.write(
      `Compose coverage check passed (${result.servicePathCount} service paths, ${result.topLevelPathCount} top-level paths).\n`,
    );
  } else {
    process.stderr.write(formatComposeCoverageFailure(result));
    process.exitCode = 1;
  }
}
