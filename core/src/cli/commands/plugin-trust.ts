import { isAbsolute, resolve } from "node:path";

import { Effect } from "effect";

import { type ConfigError, NotImplementedError } from "@lando/sdk/errors";
import { PluginTrustStore } from "@lando/sdk/services";

const REGISTRY_NAME_RE = /^(@[^/]+\/)?[a-z0-9][a-z0-9._-]*$/i;

export interface PluginTrustResult {
  readonly kind: "plugin";
  readonly pluginName: string;
}

export interface PluginTrustAuthoringRootResult {
  readonly kind: "authoring-root";
  readonly path: string;
}

const extractName = (input: { readonly name: string } | string): string =>
  typeof input === "string" ? input : input.name;

const extractPath = (input: { readonly path: string } | string): string =>
  typeof input === "string" ? input : input.path;

export const pluginTrust = (
  input: { readonly name: string } | string,
): Effect.Effect<PluginTrustResult, ConfigError | NotImplementedError, PluginTrustStore> =>
  Effect.gen(function* () {
    const name = extractName(input);
    if (name.trim() === "" || !REGISTRY_NAME_RE.test(name)) {
      return yield* Effect.fail(
        new NotImplementedError({
          message: `Invalid plugin name: ${name}`,
          commandId: "meta:plugin:trust",
          specSection: "spec/10-plugins.md",
          remediation: "Pass an npm plugin package name, e.g. `lando plugin:trust @lando/plugin-php`.",
        }),
      );
    }
    const store = yield* PluginTrustStore;
    yield* store.trustPlugin(name);
    return { kind: "plugin", pluginName: name };
  });

export const pluginTrustAuthoringRoot = (
  input: { readonly path: string } | string,
): Effect.Effect<PluginTrustAuthoringRootResult, ConfigError | NotImplementedError, PluginTrustStore> =>
  Effect.gen(function* () {
    const path = extractPath(input);
    if (!isAbsolute(path)) {
      return yield* Effect.fail(
        new NotImplementedError({
          message: `Plugin authoring root must be an absolute path: ${path}`,
          commandId: "meta:plugin:trust-authoring-root",
          specSection: "spec/10-plugins.md",
          remediation: "Pass an absolute path, e.g. `lando plugin:trust-authoring-root /home/me/plugin`.",
        }),
      );
    }
    const resolved = resolve(path);
    const store = yield* PluginTrustStore;
    yield* store.trustAuthoringRoot(resolved);
    return { kind: "authoring-root", path: resolved };
  });

export const renderPluginTrustResult = (result: PluginTrustResult): string =>
  `trusted-plugin: ${result.pluginName}`;

export const renderPluginTrustAuthoringRootResult = (result: PluginTrustAuthoringRootResult): string =>
  `trusted-authoring-root: ${result.path}`;
