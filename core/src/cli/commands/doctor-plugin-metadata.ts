import { join } from "node:path";

import { Effect } from "effect";

import { loadInstalledPluginManifest } from "@lando/engine/plugins/installed-plugin-loader";
import {
  type InstalledPluginRegistryFailure,
  inspectInstalledPluginRegistry,
} from "@lando/engine/plugins/installed-registry";
import {
  type DoctorSelfCheck,
  type DoctorSelfSolution,
  describeDoctorFailure,
  doctorSelfCheck,
  redactDoctorMessage,
} from "./doctor-self";

const PLUGIN_METADATA_REMEDIATION: DoctorSelfSolution = {
  kind: "manual",
  description:
    "Use the reported pluginId and pluginPath to identify the affected plugin. Remove it with `lando plugin:remove <name>` and reinstall it with `lando plugin:add <spec>` using its original source.",
};

const PLUGIN_REGISTRY_REMEDIATION: DoctorSelfSolution = {
  kind: "manual",
  description:
    "Repair the registry file at the reported metadataPath, correcting or removing the invalid entry. Re-run `lando doctor` after repairing the registry.",
};

export const installedPluginMetadataSelfChecks = (
  pluginsRoot: string,
  redact: (value: string) => string,
): Effect.Effect<ReadonlyArray<DoctorSelfCheck>> =>
  Effect.promise(async () => {
    const inspection = await inspectInstalledPluginRegistry(pluginsRoot);
    const failures: Array<{ failure: InstalledPluginRegistryFailure; registry: boolean }> =
      inspection.failures.map((failure) => ({ failure, registry: true }));
    for (const entry of Object.values(inspection.registry)) {
      try {
        await loadInstalledPluginManifest(entry.path);
      } catch (cause) {
        failures.push({
          failure: {
            pluginId: entry.name,
            pluginPath: entry.path,
            metadataPath: join(entry.path, "package.json"),
            cause,
          },
          registry: false,
        });
      }
    }
    return failures.map(({ failure, registry }) => {
      const described = describeDoctorFailure(failure.cause);
      return doctorSelfCheck({
        section: "plugin-metadata",
        reason: "failure",
        message: redactDoctorMessage(described.message, redact),
        ...(described.tag === undefined ? {} : { tag: described.tag }),
        context: {
          pluginId: redactDoctorMessage(failure.pluginId, redact),
          pluginPath: redactDoctorMessage(failure.pluginPath, redact),
          metadataPath: redactDoctorMessage(failure.metadataPath, redact),
        },
        solutions: [registry ? PLUGIN_REGISTRY_REMEDIATION : PLUGIN_METADATA_REMEDIATION],
      });
    });
  });
