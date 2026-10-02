import { definePlugin } from "@lando/sdk/plugins";
import { PluginManifest } from "@lando/sdk/schema";
import { Schema } from "effect";
import { ONEPASSWORD_SCHEME, ONEPASSWORD_STORE_ID, onePasswordSecretStore } from "./store.ts";

export const PLUGIN_NAME = "@lando/secret-store-1password";
export const secretStores = new Map([[ONEPASSWORD_STORE_ID, onePasswordSecretStore]]);

export const manifest = Schema.decodeSync(PluginManifest)({
  name: PLUGIN_NAME,
  version: "0.0.0",
  api: 4,
  requires: { "@lando/core": "^4.0.0" },
  description: "1Password CLI-backed secret store.",
  enabled: true,
  contributes: {
    secretStores: [{ id: ONEPASSWORD_STORE_ID, module: "./src/store.ts", schemes: [ONEPASSWORD_SCHEME] }],
  },
  entry: "./src/index.ts",
});

export const plugin = definePlugin({ name: manifest.name, manifest, secretStores });

export { OP_READ_TIMEOUT_MS, type OpRunner, makeOpRunner } from "./op-cli.ts";
export {
  ONEPASSWORD_SCHEME,
  ONEPASSWORD_STORE_ID,
  makeOnePasswordSecretStore,
  onePasswordSecretStore,
} from "./store.ts";
