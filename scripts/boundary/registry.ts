import { envHelperRule } from "./rules/env-helper.ts";
import { generatedOutputRule } from "./rules/generated-output.ts";
import { importCycleRule } from "./rules/import-cycle.ts";
import { libpodPrefixRule } from "./rules/libpod-prefix.ts";
import { machineOutputRule } from "./rules/machine-output.ts";
import { managedFileRule } from "./rules/managed-file.ts";
import { networkRule } from "./rules/network.ts";
import { packageDagRule } from "./rules/package-dag.ts";
import { pathsRule } from "./rules/paths.ts";
import { probeRule } from "./rules/probe.ts";
import { redactionRule } from "./rules/redaction.ts";
import { rendererRule } from "./rules/renderer.ts";
import { specReferenceRule } from "./rules/spec-reference.ts";
import { stateStoreRule } from "./rules/state-store.ts";
import type { BoundaryRule } from "./types.ts";

export const BOUNDARY_RULE_IDS = [
  "env-helper",
  "import-cycle",
  "libpod-prefix",
  "machine-output",
  "managed-file",
  "network",
  "package-dag",
  "paths",
  "probe",
  "redaction",
  "renderer",
  "spec-reference",
  "state-store",
  "generated-output",
] as const;

export const BOUNDARY_RULES: ReadonlyMap<string, BoundaryRule> = new Map<string, BoundaryRule>([
  [envHelperRule.id, envHelperRule],
  [importCycleRule.id, importCycleRule],
  [libpodPrefixRule.id, libpodPrefixRule],
  [machineOutputRule.id, machineOutputRule],
  [managedFileRule.id, managedFileRule],
  [networkRule.id, networkRule],
  [packageDagRule.id, packageDagRule],
  [pathsRule.id, pathsRule],
  [probeRule.id, probeRule],
  [redactionRule.id, redactionRule],
  [rendererRule.id, rendererRule],
  [specReferenceRule.id, specReferenceRule],
  [stateStoreRule.id, stateStoreRule],
  [generatedOutputRule.id, generatedOutputRule],
]);
