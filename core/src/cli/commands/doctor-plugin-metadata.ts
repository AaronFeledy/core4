import { join } from "node:path";

import { Effect } from "effect";

import { loadInstalledPluginManifest } from "@lando/engine/plugins/installed-plugin-loader";
import {
  type InstalledPluginRegistryFailure,
  inspectInstalledPluginRegistry,
} from "@lando/engine/plugins/installed-registry";
import { makeLandoPaths } from "@lando/paths";
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
    "Run `lando plugin list` to inspect installed plugins, then remove and reinstall the affected plugin.",
  command: "lando plugin list",
};

export const installedPluginMetadataSelfChecks = (
  userDataRoot: string,
  redact: (value: string) => string,
): Effect.Effect<ReadonlyArray<DoctorSelfCheck>> =>
  Effect.promise(async () => {
    const pluginsRoot = makeLandoPaths({ userDataRoot }).pluginsDir;
    const inspection = await inspectInstalledPluginRegistry(pluginsRoot);
    const failures: InstalledPluginRegistryFailure[] = [...inspection.failures];
    for (const entry of Object.values(inspection.registry)) {
      try {
        await loadInstalledPluginManifest(entry.path);
      } catch (cause) {
        failures.push({
          pluginId: entry.name,
          pluginPath: entry.path,
          metadataPath: join(entry.path, "package.json"),
          cause,
        });
      }
    }
    return failures.map((failure) => {
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
        solutions: [PLUGIN_METADATA_REMEDIATION],
      });
    });
  });
