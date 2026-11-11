import { Effect, Layer, Schema } from "effect";

import { definePlugin } from "@lando/sdk/plugins";
import { PluginManifest } from "@lando/sdk/schema";
import { CertificateAuthority, Downloader, PathsService, ProcessRunner } from "@lando/sdk/services";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";

import { CA_ID, makeMkcertCertificateAuthority } from "./ca.ts";

export const PLUGIN_NAME = "@lando/ca-mkcert" as const;

// The contribution layer receives no plugin context, so it acquires its own private-file access for
// the root lock and temporary directories.
export const layer = Layer.effect(
  CertificateAuthority,
  Effect.gen(function* () {
    const paths = yield* PathsService;
    const downloader = yield* Downloader;
    const processRunner = yield* ProcessRunner;
    const privateFileAccess = yield* PrivateFileAccessService;
    return makeMkcertCertificateAuthority({
      binDir: paths.binDir,
      toolDownloadsDir: paths.toolDownloadsDir(CA_ID),
      downloader,
      processRunner,
      privateFileAccess,
    });
  }),
).pipe(Layer.provide(PrivateFileAccessService.layer));

export const manifest = Schema.decodeSync(PluginManifest)({
  name: PLUGIN_NAME,
  version: "0.0.0",
  api: 4,
  requires: { "@lando/core": "^4.0.0" },
  description: "mkcert-backed CertificateAuthority implementation.",
  enabled: true,
  contributes: {
    certificateAuthorities: [
      {
        id: CA_ID,
        module: "./src/ca.ts",
        defaultFor: { platform: ["darwin", "linux", "win32"] },
        enabledByDefault: true,
        summary: "mkcert-backed local certificate authority",
      },
    ],
  },
  entry: "./src/index.ts",
});

export const plugin = definePlugin({
  name: manifest.name,
  manifest,
  certificateAuthorities: new Map([[CA_ID, layer]]),
});

export { CA_ID, makeMkcertCertificateAuthority } from "./ca.ts";
export type { MkcertCertificateAuthorityOptions } from "./ca.ts";
export {
  MKCERT_TOOL_MANIFEST,
  MKCERT_TOOL_VERSION,
  type InstalledMkcertStatus,
  type ProvisionMkcertInput,
  mkcertInstallName,
  mkcertInstallPath,
  mkcertInstalledVersionPath,
  provisionMkcert,
  readInstalledMkcertStatus,
} from "./provision.ts";
