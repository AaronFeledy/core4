import { readFileSync } from "node:fs";

import { Effect } from "effect";

import { ProviderUnavailableError } from "@lando/sdk/errors";
import type { PrivilegeService, ProviderHostChangeRequest } from "@lando/sdk/services";

import type { RootlessProbes } from "./rootless-preflight.ts";

const PROVIDER_ID = "lando";
const SUPPORTED_HOST = { id: "ubuntu", versionId: "26.04" } as const;
const APT_GET_UPDATE = ["/usr/bin/apt-get", "update"] as const;
const APT_GET_INSTALL_UIDMAP = [
  "/usr/bin/apt-get",
  "install",
  "--yes",
  "--no-install-recommends",
  "uidmap",
] as const;

export const UIDMAP_PACKAGE_REQUEST: ProviderHostChangeRequest = {
  _tag: "package-install",
  packageName: "uidmap",
  reason: "Rootless Podman requires newuidmap and newgidmap before the Lando-managed runtime can start.",
};

export interface LinuxHostRelease {
  readonly id: string;
  readonly versionId: string;
}

export type UidmapProvisionStage =
  | "unsupported-host"
  | "consent"
  | "privilege"
  | "update"
  | "install"
  | "verify";

interface UidmapProvisionDetails {
  readonly stage: UidmapProvisionStage;
  readonly packageName: "uidmap";
  readonly host?: LinuxHostRelease;
  readonly exitCode?: number;
  readonly stderr?: string;
}

export class UidmapProvisionError extends ProviderUnavailableError {
  constructor(
    stage: UidmapProvisionStage,
    message: string,
    remediation: string,
    details: Omit<UidmapProvisionDetails, "stage" | "packageName"> = {},
  ) {
    super({
      providerId: PROVIDER_ID,
      operation: "setup",
      message,
      remediation,
      details: { stage, packageName: "uidmap", ...details } satisfies UidmapProvisionDetails,
    });
  }

  get stage(): UidmapProvisionStage {
    return (this.details as UidmapProvisionDetails).stage;
  }
}

export interface UidmapProvisionOptions {
  readonly host: LinuxHostRelease | undefined;
  readonly probes: RootlessProbes;
  readonly privilege: typeof PrivilegeService.Service | undefined;
  readonly consent: ((request: ProviderHostChangeRequest) => Effect.Effect<boolean>) | undefined;
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

const aptFailure = (
  stage: "update" | "install",
  result: { readonly exitCode: number; readonly stderr: string },
): UidmapProvisionError =>
  new UidmapProvisionError(
    stage,
    `Failed to ${stage === "update" ? "refresh Ubuntu package metadata" : "install uidmap"}: ${result.stderr.trim() || `apt-get exited ${result.exitCode}`}`,
    "Resolve the apt-get failure, then rerun `lando setup --yes`; or install the Ubuntu `uidmap` package manually and rerun setup.",
    { exitCode: result.exitCode, stderr: result.stderr },
  );

export const provisionUidmapTools = (
  options: UidmapProvisionOptions,
): Effect.Effect<void, UidmapProvisionError> =>
  Effect.gen(function* () {
    if (options.probes.probe().hasUidmapTools) return;
    if (options.host?.id !== SUPPORTED_HOST.id || options.host.versionId !== SUPPORTED_HOST.versionId) {
      return yield* Effect.fail(
        new UidmapProvisionError(
          "unsupported-host",
          "Automatic uidmap provisioning is supported only on Ubuntu 26.04.",
          "Install newuidmap and newgidmap using the host's trusted package manager, then rerun `lando setup`.",
          options.host === undefined ? {} : { host: options.host },
        ),
      );
    }
    if (options.consent === undefined || !(yield* options.consent(UIDMAP_PACKAGE_REQUEST))) {
      return yield* Effect.fail(
        new UidmapProvisionError(
          "consent",
          "Installing the Ubuntu uidmap package requires explicit consent.",
          "Rerun `lando setup --yes --no-interactive` to approve this fixed host change, or install `uidmap` manually and rerun setup.",
          { host: options.host },
        ),
      );
    }
    if (options.privilege === undefined) {
      return yield* Effect.fail(
        new UidmapProvisionError(
          "privilege",
          "The privilege service is unavailable, so Lando cannot install uidmap.",
          "Install the Ubuntu `uidmap` package manually, then rerun `lando setup`.",
          { host: options.host },
        ),
      );
    }

    const update = yield* options.privilege.elevate(APT_GET_UPDATE);
    if (update.exitCode !== 0) return yield* Effect.fail(aptFailure("update", update));
    const install = yield* options.privilege.elevate(APT_GET_INSTALL_UIDMAP);
    if (install.exitCode !== 0) return yield* Effect.fail(aptFailure("install", install));
    if (!options.probes.probe().hasUidmapTools) {
      return yield* Effect.fail(
        new UidmapProvisionError(
          "verify",
          "The uidmap package installation completed, but newuidmap/newgidmap are still unavailable.",
          "Verify `/usr/bin/newuidmap` and `/usr/bin/newgidmap` exist and are executable, then rerun `lando setup`.",
          { host: options.host },
        ),
      );
    }
  });
