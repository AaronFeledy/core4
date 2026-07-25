import { readFileSync } from "node:fs";

import { Effect } from "effect";

import {
  ProviderSetupPrivilegeUnavailableError,
  ProviderSetupProvisioningError,
  ProviderSetupUnsupportedHostError,
} from "@lando/sdk/errors";
import { type HostPlatform, ProviderId, type ProviderSetupPlan } from "@lando/sdk/schema";
import type { PrivilegeService } from "@lando/sdk/services";

import type { RootlessProbes } from "./rootless-preflight.ts";

const PROVIDER_ID = ProviderId.make("lando");
const APT_GET_UPDATE = ["/usr/bin/apt-get", "update"] as const;
const APT_GET_INSTALL_UIDMAP = [
  "/usr/bin/apt-get",
  "install",
  "--yes",
  "--no-install-recommends",
  "uidmap",
] as const;

export interface LinuxHostRelease {
  readonly id: string;
  readonly versionId: string;
}

interface UidmapInspection {
  readonly platform: HostPlatform;
  readonly host: LinuxHostRelease | undefined;
  readonly probes: RootlessProbes;
}

interface UidmapApply {
  readonly probes: RootlessProbes;
  readonly privilege: typeof PrivilegeService.Service | undefined;
}

const parseReleaseValue = (raw: string): string => raw.trim().replace(/^['"]|['"]$/gu, "");

export const parseLinuxHostRelease = (raw: string): LinuxHostRelease | undefined => {
  const values = new Map(
    raw
      .split(/\r?\n/gu)
      .map((line) => line.match(/^([A-Z_]+)=(.*)$/u))
      .filter((match): match is RegExpMatchArray => match !== null)
      .map((match) => [match[1] ?? "", parseReleaseValue(match[2] ?? "")] as const),
  );
  const id = values.get("ID");
  const versionId = values.get("VERSION_ID");
  return id === undefined || versionId === undefined ? undefined : { id, versionId };
};

export const readLinuxHostRelease = (): LinuxHostRelease | undefined => {
  try {
    return parseLinuxHostRelease(readFileSync("/etc/os-release", "utf8"));
  } catch {
    return undefined;
  }
};

const manualUidmapRemediation =
  "Install newuidmap and newgidmap using the host's trusted package manager, then rerun `lando setup`.";

export const inspectUidmapSetupPlan = (
  input: UidmapInspection,
): Effect.Effect<ProviderSetupPlan, ProviderSetupUnsupportedHostError> => {
  if (input.probes.probe().hasUidmapTools) {
    return Effect.succeed({ providerId: PROVIDER_ID, changes: [] });
  }
  if (input.platform !== "linux" || input.host?.id !== "ubuntu" || input.host.versionId !== "26.04") {
    return Effect.fail(
      new ProviderSetupUnsupportedHostError({
        providerId: PROVIDER_ID,
        prerequisite: "uidmap-tools",
        message: "Automatic uidmap provisioning is supported only on Ubuntu 26.04.",
        remediation: manualUidmapRemediation,
        ...(input.host === undefined ? {} : { host: input.host }),
      }),
    );
  }
  return Effect.succeed({
    providerId: PROVIDER_ID,
    changes: [
      {
        _tag: "install-uidmap",
        platform: "linux",
        distribution: "ubuntu",
        version: "26.04",
        reason: "Rootless Podman requires newuidmap and newgidmap before the managed runtime can start.",
      },
    ],
  });
};

const provisioningFailure = (
  stage: "update" | "install",
  result: { readonly exitCode: number; readonly stderr: string },
): ProviderSetupProvisioningError =>
  new ProviderSetupProvisioningError({
    providerId: PROVIDER_ID,
    change: "install-uidmap",
    stage,
    message: `Failed to ${stage === "update" ? "refresh Ubuntu package metadata" : "install uidmap"}.`,
    remediation:
      "Resolve the apt-get failure, then rerun `lando setup --yes`; or install Ubuntu's uidmap package manually.",
    exitCode: result.exitCode,
    stderr: result.stderr,
  });

export const applyApprovedProviderSetupPlan = (
  plan: ProviderSetupPlan,
  input: UidmapApply,
): Effect.Effect<void, ProviderSetupPrivilegeUnavailableError | ProviderSetupProvisioningError> =>
  Effect.gen(function* () {
    for (const change of plan.changes) {
      if (input.privilege === undefined) {
        return yield* Effect.fail(
          new ProviderSetupPrivilegeUnavailableError({
            providerId: PROVIDER_ID,
            change: "install-uidmap",
            message: "The privilege service is unavailable, so Lando cannot install uidmap.",
            remediation: manualUidmapRemediation,
          }),
        );
      }

      const update = yield* input.privilege.elevate(APT_GET_UPDATE);
      if (update.exitCode !== 0) return yield* Effect.fail(provisioningFailure("update", update));
      const install = yield* input.privilege.elevate(APT_GET_INSTALL_UIDMAP);
      if (install.exitCode !== 0) return yield* Effect.fail(provisioningFailure("install", install));
      if (!input.probes.probe().hasUidmapTools) {
        return yield* Effect.fail(
          new ProviderSetupProvisioningError({
            providerId: PROVIDER_ID,
            change: change._tag,
            stage: "verify",
            message: "uidmap installation completed, but newuidmap/newgidmap remain unavailable.",
            remediation:
              "Verify /usr/bin/newuidmap and /usr/bin/newgidmap are executable, then rerun `lando setup`.",
          }),
        );
      }
    }
  });
