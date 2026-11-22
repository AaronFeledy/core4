import { containerRemovalArgs } from "@lando/container-runtime/container-removal";
import {
  coherentContainerOwnership,
  coherentPrivateNetworkOwnership,
  decodeNativeObservation,
  ownsSharedCrossAppNetwork,
} from "@lando/container-runtime/native-ownership";
import {
  VOLUME_OWNER_LABEL,
  VOLUME_SELECTOR_LABEL,
  coherentVolumeOwnership,
} from "@lando/container-runtime/volume-ownership";
import { LANDO_DATA_ROOT_LABEL, LANDO_SHARED_CROSS_APP_NETWORK } from "@lando/sdk/schema";
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
  dataRoot?: string,
): Promise<string> => {
  const removed: string[] = [];
  const retained: string[] = [];
  const failed: string[] = [];
  const outside: string[] = [];
  const run = (args: readonly string[]) => runUninstallRuntime(exec, runtime, { args, timeout: 60_000 });
  try {
    for (const kind of ["container", "network", "volume"] as const) {
      const args = kind === "container" ? ["ps", "-a"] : [kind, "ls"];
      const format = kind === "volume" ? "{{.Name}}" : "{{.ID}}";
      const list = async (label: string) =>
        lines((await run([...args, "--filter", `label=${label}`, "--format", format])).stdout);
      const candidates = new Set(
        runtime.managed
          ? (await Promise.all(candidateLabels[kind].map(list))).flat()
          : dataRoot === undefined
            ? []
            : await list(`${LANDO_DATA_ROOT_LABEL}=${dataRoot}`),
      );
      if (!runtime.managed)
        for (const label of [...candidateLabels[kind], LANDO_DATA_ROOT_LABEL]) {
          try {
            for (const ref of await list(label))
              if (!candidates.has(ref)) outside.push(`${runtime.cmd} ${kind} ${ref}`);
          } catch (cause) {
            outside.push(
              `${runtime.cmd} ${kind}: outside-scope discovery unavailable (${cause instanceof Error ? cause.message : String(cause)})`,
            );
          }
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
          if (!runtime.managed && (dataRoot === undefined || labels[LANDO_DATA_ROOT_LABEL] !== dataRoot)) {
            outside.push(resource);
            continue;
          }
          const id = kind === "volume" ? observed.Name : (observed.Id ?? observed.ID ?? observed.id);
          if (!id || (kind === "volume" && id !== ref)) {
            failed.push(`${resource}: exact native identity unavailable`);
            continue;
          }
          if (seen.has(id)) continue;
          seen.add(id);
          const shared =
            kind === "network" &&
            !runtime.managed &&
            dataRoot !== undefined &&
            ownsSharedCrossAppNetwork(dataRoot, observed.Name ?? observed.name, labels);
          const owned =
            kind === "container"
              ? coherentContainerOwnership(labels, runtime.providerId)
              : kind === "network"
                ? shared || coherentPrivateNetworkOwnership(labels, runtime.providerId)
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
          if (shared && Object.keys(observed.Containers ?? {}).length > 0) {
            retained.push(`${resource}: shared network has attached endpoints`);
            continue;
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
  return outside.length === 0 ? "" : `Outside this data root's purge scope: ${outside.join("; ")}.`;
};
