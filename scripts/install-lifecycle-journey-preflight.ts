import { UninstallResultSchema } from "@lando/engine/operations/uninstall";
import { Schema } from "effect";
import { LifecycleJourneyError } from "./install-lifecycle-journey-runner.ts";

const UninstallEnvelope = Schema.fromJsonString(Schema.Struct({ result: UninstallResultSchema }));

export const assertLifecycleHostIsolation = (dryRun: string): void => {
  const { result } = Schema.decodeUnknownSync(UninstallEnvelope)(dryRun);
  const hostTargets = result.steps.filter(
    (step) => ["socket-proxy-helper", "cgroups-delegate"].includes(step.id) && step.status !== "skipped",
  );
  if (hostTargets.length > 0) {
    throw new LifecycleJourneyError(
      `Fresh host required: uninstall reaches existing host-global integration: ${hostTargets.map((step) => step.target).join(", ")}. Isolated LANDO roots do not isolate these targets.`,
    );
  }
};

export type LifecycleCommand = (id: string, argv: readonly string[]) => Promise<string>;

export const assertLifecycleWindowsMachineAbsent = (listing: string): void => {
  if (/podman-lando/iu.test(listing.replaceAll("\0", ""))) {
    throw new LifecycleJourneyError(
      "podman-lando WSL machine exists; refusing adoption or reporting successful removal.",
    );
  }
};

export const assertFreshWindowsLifecycleHost = async (
  provider: string,
  command: LifecycleCommand,
): Promise<void> => {
  if (provider !== "lando" || process.env.LANDO_LIFECYCLE_FRESH_RUNNER !== "1") {
    throw new LifecycleJourneyError(
      "Windows requires provider=lando and LANDO_LIFECYCLE_FRESH_RUNNER=1 on a fresh dedicated runner.",
    );
  }
  assertLifecycleWindowsMachineAbsent(
    await command("windows-machine-preflight", ["wsl.exe", "--list", "--quiet"]),
  );
};

export const assertLifecycleRuntimeIsolation = async (
  runtime: string,
  command: LifecycleCommand,
): Promise<void> => {
  const queries = [
    ["ps", "-aq", "--filter", "label=dev.lando.app"],
    ["ps", "-aq", "--filter", "label=com.lando.app"],
    ["network", "ls", "-q", "--filter", "label=dev.lando.network=true"],
    ["volume", "ls", "-q", "--filter", "label=dev.lando.volume=true"],
  ] as const;
  for (const [index, query] of queries.entries()) {
    const resources = await command(`${runtime}-isolation-${index}`, [runtime, ...query]);
    if (resources.trim() !== "") {
      throw new LifecycleJourneyError(
        `Fresh runtime required: ${runtime} has pre-existing Lando resources (${query.join(" ")}). Refusing host-wide uninstall cleanup.`,
      );
    }
  }
};
