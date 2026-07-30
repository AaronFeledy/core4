/**
 * Host-binary provisioning for the mkcert-backed `CertificateAuthority`.
 *
 * The pinned upstream release is described by the committed canonical
 * `ToolManifest` (`mkcert-versions.json`). Upstream publishes plain,
 * unarchived binaries, so every artifact entry omits `archive`/`member` and the
 * downloaded bytes are the executable itself. Verified bytes come from
 * `Downloader` (and therefore honor `network.ca` / `network.proxy` through
 * `HttpClient`); placement, containment, and the version marker come from the
 * shared tool-provisioning helper.
 */
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { Effect, Schema, type Scope } from "effect";

import { ToolManifest } from "@lando/sdk/schema";
import type { Downloader } from "@lando/sdk/services";
import { type ToolError, provisionTool, resolveHostKey } from "@lando/sdk/tool-provisioning";

import manifestData from "../mkcert-versions.json" with { type: "json" };

const TOOL_ID = "mkcert" as const;

export const MKCERT_TOOL_MANIFEST = Schema.decodeUnknownSync(ToolManifest)(manifestData);
export const MKCERT_TOOL_VERSION = MKCERT_TOOL_MANIFEST.toolVersion;

export interface ProvisionMkcertInput {
  readonly binDir: string;
  readonly toolDownloadsDir: string;
  readonly force?: boolean | undefined;
  readonly offline?: boolean | undefined;
  readonly platform?: string | undefined;
  readonly arch?: string | undefined;
}

export interface InstalledMkcertStatus {
  readonly installedVersion?: string;
  readonly isCurrent: boolean;
}

const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

export const mkcertInstallName = (platform: string = process.platform): "mkcert" | "mkcert.exe" =>
  platform === "win32" ? "mkcert.exe" : "mkcert";

export const mkcertInstallPath = (binDir: string, platform: string = process.platform): string =>
  join(binDir, mkcertInstallName(platform));

export const mkcertInstalledVersionPath = (binDir: string): string => join(binDir, `.${TOOL_ID}.version`);

const fingerprintPath = (installPath: string): string => `${installPath}.sha256`;

const readInstalledVersion = async (binDir: string): Promise<string | undefined> => {
  try {
    const content = (await readFile(mkcertInstalledVersionPath(binDir), "utf-8")).trim();
    return content.length === 0 ? undefined : content;
  } catch {
    return undefined;
  }
};

const matchesRecordedFingerprint = async (path: string): Promise<boolean> => {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size === 0) return false;
    const [binary, recorded] = await Promise.all([readFile(path), readFile(fingerprintPath(path), "utf-8")]);
    return sha256Hex(binary) === recorded.trim();
  } catch {
    return false;
  }
};

/**
 * Report whether the pinned mkcert version is already installed with an intact
 * fingerprint. Used to keep `setup` idempotent and to decide whether
 * `issueCert` has a usable binary.
 */
export const readInstalledMkcertStatus = async (
  binDir: string,
  platform: string = process.platform,
  arch: string = process.arch,
): Promise<InstalledMkcertStatus> => {
  const installedVersion = await readInstalledVersion(binDir);
  if (installedVersion !== MKCERT_TOOL_VERSION) {
    return { ...(installedVersion === undefined ? {} : { installedVersion }), isCurrent: false };
  }
  if (MKCERT_TOOL_MANIFEST.artifacts[resolveHostKey(platform, arch)] === undefined) {
    return { installedVersion, isCurrent: false };
  }
  return {
    installedVersion,
    isCurrent: await matchesRecordedFingerprint(mkcertInstallPath(binDir, platform)),
  };
};

export const provisionMkcert = (
  input: ProvisionMkcertInput,
): Effect.Effect<void, ToolError, Downloader | Scope.Scope> =>
  Effect.gen(function* () {
    const platform = input.platform ?? process.platform;
    const arch = input.arch ?? process.arch;

    if (input.force !== true) {
      const installed = yield* Effect.promise(() => readInstalledMkcertStatus(input.binDir, platform, arch));
      if (installed.isCurrent) return;
    }

    yield* provisionTool({
      manifest: MKCERT_TOOL_MANIFEST,
      key: resolveHostKey(platform, arch),
      toolId: TOOL_ID,
      binDir: input.binDir,
      toolDownloadsDir: input.toolDownloadsDir,
      platform,
      ...(input.force === undefined ? {} : { force: input.force }),
      ...(input.offline === undefined ? {} : { offline: input.offline }),
    });
  });
