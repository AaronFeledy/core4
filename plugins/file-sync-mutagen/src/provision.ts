import { join } from "node:path";

import { Effect, Schema, type Scope } from "effect";

import { ToolManifest } from "@lando/sdk/schema";
import type { Downloader } from "@lando/sdk/services";
import type { ToolError } from "@lando/sdk/tool-provisioning";
import {
  legacyToolVersionMarkerPath,
  provisionTool,
  readInstalledToolVersion,
  recordedFingerprintMatch,
  resolveHostKey,
  toolVersionMarkerPath,
} from "@lando/sdk/tool-provisioning";

import manifestData from "../mutagen-versions.json" with { type: "json" };

const TOOL_ID = "mutagen" as const;
const AGENT_GUESTS = ["linux-amd64", "linux-arm64", "linux-armv7"] as const;

export const MUTAGEN_TOOL_MANIFEST = Schema.decodeUnknownSync(ToolManifest)(manifestData);
export const MUTAGEN_TOOL_VERSION = MUTAGEN_TOOL_MANIFEST.toolVersion;

export interface ProvisionMutagenInput {
  readonly binDir: string;
  readonly toolDownloadsDir: string;
  readonly force?: boolean | undefined;
  readonly offline?: boolean | undefined;
  readonly platform?: string | undefined;
  readonly arch?: string | undefined;
}

export interface InstalledMutagenStatus {
  readonly installedVersion?: string;
  readonly isCurrent: boolean;
}

export const mutagenHostInstallName = (platform: string = process.platform): "mutagen" | "mutagen.exe" =>
  platform === "win32" ? "mutagen.exe" : "mutagen";

export const mutagenHostInstallPath = (binDir: string, platform: string = process.platform): string =>
  join(binDir, mutagenHostInstallName(platform));

export const mutagenAgentInstallPath = (binDir: string, guest: string): string =>
  join(binDir, "mutagen-agents", `mutagen-agent-${guest}`);

export const mutagenInstalledVersionPath = (binDir: string): string => toolVersionMarkerPath(binDir, TOOL_ID);

const readInstalledMutagenVersion = (binDir: string): Promise<string | undefined> =>
  readInstalledToolVersion([
    mutagenInstalledVersionPath(binDir),
    legacyToolVersionMarkerPath(binDir, TOOL_ID),
  ]);

const fileMatchesRecordedFingerprint = async (path: string): Promise<boolean> =>
  (await recordedFingerprintMatch(path)) !== undefined;

const expectedInstallPaths = (binDir: string, hostKey: string): ReadonlyArray<string> => {
  const keys = [
    `${hostKey}/cli`,
    `${hostKey}/agent-bundle`,
    ...AGENT_GUESTS.map((guest) => `${hostKey}/agent/${guest}`),
  ];
  const installNames = keys.map((key) => MUTAGEN_TOOL_MANIFEST.artifacts[key]?.installName);
  if (installNames.some((installName) => installName === undefined)) return [];
  return installNames.map((installName) => join(binDir, installName as string));
};

export const readInstalledMutagenStatus = async (
  binDir: string,
  platform: string = process.platform,
  arch: string = process.arch,
): Promise<InstalledMutagenStatus> => {
  const installedVersion = await readInstalledMutagenVersion(binDir);
  if (installedVersion !== MUTAGEN_TOOL_VERSION) {
    return { ...(installedVersion === undefined ? {} : { installedVersion }), isCurrent: false };
  }

  const hostKey = resolveHostKey(platform, arch);
  const paths = expectedInstallPaths(binDir, hostKey);
  if (paths.length === 0) return { installedVersion, isCurrent: false };

  const valid = await Promise.all(paths.map(fileMatchesRecordedFingerprint));
  return { installedVersion, isCurrent: valid.every(Boolean) };
};

export const provisionMutagen = Effect.fn("Mutagen.provision")(function* (
  input: ProvisionMutagenInput,
): Effect.fn.Return<void, ToolError, Downloader | Scope.Scope> {
  const platform = input.platform ?? process.platform;
  const arch = input.arch ?? process.arch;
  const hostKey = resolveHostKey(platform, arch);

  if (input.force !== true) {
    const installed = yield* Effect.promise(() => readInstalledMutagenStatus(input.binDir, platform, arch));
    if (installed.isCurrent) return;
  }

  const common = {
    manifest: MUTAGEN_TOOL_MANIFEST,
    toolId: TOOL_ID,
    binDir: input.binDir,
    toolDownloadsDir: input.toolDownloadsDir,
    platform,
    ...(input.force === undefined ? {} : { force: input.force }),
    ...(input.offline === undefined ? {} : { offline: input.offline }),
  };

  yield* provisionTool({ ...common, key: `${hostKey}/cli` });
  yield* provisionTool({ ...common, key: `${hostKey}/agent-bundle` });
  for (const guest of AGENT_GUESTS) {
    yield* provisionTool({ ...common, key: `${hostKey}/agent/${guest}` });
  }
});
