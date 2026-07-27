import { Effect, Layer, Schema } from "effect";

import { CaError } from "@lando/sdk/errors";
import { definePlugin } from "@lando/sdk/plugins";
import { PluginManifest } from "@lando/sdk/schema";
import { CertificateAuthority } from "@lando/sdk/services";

export const PLUGIN_NAME = "@lando/ca-mkcert" as const;
export const CA_ID = "mkcert" as const;

const CA_UNAVAILABLE_MESSAGE =
  "mkcert is not installed. Run `lando setup` to download mkcert and install the local CA.";

export const makeCertificateAuthority = () => ({
  id: CA_ID,
  setup: (_opts: { force: boolean; skipTrustInstall?: boolean }) =>
    Effect.fail(new CaError({ message: CA_UNAVAILABLE_MESSAGE, caId: CA_ID })),
  issueCert: (_spec: { cn: string; sans: ReadonlyArray<string> }) =>
    Effect.fail(new CaError({ message: CA_UNAVAILABLE_MESSAGE, caId: CA_ID })),
});

export const engine = Layer.succeed(CertificateAuthority, makeCertificateAuthority());

export const manifest = Schema.decodeSync(PluginManifest)({
  name: PLUGIN_NAME,
  version: "0.0.0",
  api: 4,
  requires: { "@lando/core": "^4.0.0" },
  description: "mkcert-backed CertificateAuthority implementation.",
  enabled: true,
  contributes: {
    cas: [CA_ID],
  },
  entry: "./src/index.ts",
});

export const plugin = definePlugin({
  name: manifest.name,
  manifest,
  layer: engine,
});
