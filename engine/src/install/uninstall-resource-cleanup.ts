import { containerRemovalArgs } from "@lando/container-runtime/container-removal";
import {
  coherentContainerOwnership,
  coherentPrivateNetworkOwnership,
  decodeNativeObservation,
} from "@lando/container-runtime/native-ownership";
import {
  VOLUME_OWNER_LABEL,
  VOLUME_SELECTOR_LABEL,
  coherentVolumeOwnership,
} from "@lando/container-runtime/volume-ownership";
import { LANDO_SHARED_CROSS_APP_NETWORK } from "@lando/sdk/schema";
import { UninstallResourceCleanupError } from "./uninstall-cleanup-error.ts";
import { type RuntimeExec, type UninstallRuntime, runUninstallRuntime } from "./uninstall-runtime.ts";

const lines = (text: string) =>
  text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
const candidateLabels = {
  container: ["dev.lando.app", "com.lando.app"],
  network: ["dev.lando.app", "com.lando.app", "dev.lando.network", "dev.lando.owner"],
  volume: ["dev.lando.app", "com.lando.app", VOLUME_OWNER_LABEL, VOLUME_SELECTOR_LABEL, "dev.lando.volume"],
} as const;

export const cleanupUninstallResources = async (
  exec: RuntimeExec,
  runtime: UninstallRuntime,
): Promise<void> => {
  const removed: string[] = [];
  const retained: string[] = [];
  const failed: string[] = [];
  const run = (args: readonly string[]) => runUninstallRuntime(exec, runtime, { args, timeout: 60_000 });
  try {
    for (const kind of ["container", "network", "volume"] as const) {
      const candidates = new Set<string>();
      for (const label of candidateLabels[kind]) {
        const args = kind === "container" ? ["ps", "-a"] : [kind, "ls"];
        const format = kind === "volume" ? "{{.Name}}" : "{{.ID}}";
        const result = await run([...args, "--filter", `label=${label}`, "--format", format]);
        for (const ref of lines(result.stdout)) candidates.add(ref);
      }
      const seen = new Set<string>();
      for (const ref of candidates) {
        const resource = `${runtime.cmd} ${kind} ${ref}`;
        try {
          const inspected = await run([kind, "inspect", ref]);
          const observed = decodeNativeObservation(inspected.stdout);
          if (observed === undefined) {
            failed.push(`${resource}: inspection did not return one resource`);
            continue;
          }
          const labels = observed.Config?.Labels ?? observed.Labels ?? observed.labels ?? {};
          const id = kind === "volume" ? observed.Name : (observed.Id ?? observed.ID ?? observed.id);
          if (!id || (kind === "volume" && id !== ref)) {
            failed.push(`${resource}: exact native identity unavailable`);
            continue;
          }
          if (seen.has(id)) continue;
          seen.add(id);
          const owned =
            kind === "container"
              ? coherentContainerOwnership(labels, runtime.providerId)
              : kind === "network"
                ? coherentPrivateNetworkOwnership(labels, runtime.providerId)
                : coherentVolumeOwnership(labels, runtime.providerId);
          if (
            !owned ||
            (kind === "network" && (observed.Name ?? observed.name) === LANDO_SHARED_CROSS_APP_NETWORK)
          ) {
            retained.push(
              `${resource}: ownership unverified or shared; inspect and remove manually only after recovering its data`,
            );
            continue;
          }
          if (kind === "volume") {
            const fresh = decodeNativeObservation((await run(["volume", "inspect", id])).stdout);
            const freshLabels = fresh?.Labels ?? fresh?.labels ?? {};
            if (
              fresh?.Name !== id ||
              !coherentVolumeOwnership(freshLabels, runtime.providerId) ||
              Object.entries(labels).some(([key, value]) => freshLabels[key] !== value)
            ) {
              retained.push(`${resource}: volume generation or ownership changed; retry after inspection`);
              continue;
            }
          }
          await run(kind === "container" ? containerRemovalArgs([id]) : [kind, "rm", id]);
          removed.push(resource);
        } catch (cause) {
          failed.push(`${resource}: ${cause instanceof Error ? cause.message : String(cause)}`);
        }
      }
    }
  } catch (cause) {
    failed.push(
      `${runtime.cmd}: resource discovery failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  if (retained.length > 0 || failed.length > 0)
    throw new UninstallResourceCleanupError({
      message: `Incomplete cleanup on ${runtime.cmd}. Removed: ${removed.length}. Retained: ${retained.join("; ")}. Failed: ${failed.join("; ")}.`,
      removed,
      retained,
      failed,
      remediation:
        "Inspect retained or failed resources and recover their data before retrying purge. Managed storage and uninstall state must be preserved.",
    });
};
