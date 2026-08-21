import { createHash } from "node:crypto";
import { resolve } from "node:path";

import { type Context, Effect } from "effect";

import { LandofileValidationError } from "@lando/sdk/errors";
import type { LandofileShape, ProviderCapabilities } from "@lando/sdk/schema";
import type { FileSystem } from "@lando/sdk/services";

import { isRecord } from "./extensions.ts";

type ComposeConfigFileInput = {
  readonly name: string;
  readonly source: string;
  readonly hash: string;
};

const grantSources = (
  landofile: LandofileShape,
): ReadonlyArray<{ readonly service: string; readonly source: string }> => {
  const grants: Array<{ readonly service: string; readonly source: string }> = [];
  for (const [service, config] of Object.entries(landofile.services ?? {})) {
    for (const grant of config.configs ?? []) {
      if (grant.source === undefined || grant.source.length === 0) {
        continue;
      }
      grants.push({ service, source: grant.source });
    }
  }
  return grants;
};

const providerRealizesConfigs = (capabilities: ProviderCapabilities): boolean =>
  capabilities.composeSpec === "native" &&
  (capabilities.composeProjectFields?.supported.includes("configs") ?? false) &&
  (capabilities.composeServiceFields?.supported.includes("configs") ?? false);

export const loadComposeConfigFiles = (input: {
  readonly appRoot: string;
  readonly landofile: LandofileShape;
  readonly fileSystem: Context.Tag.Service<typeof FileSystem> | undefined;
  readonly capabilities: ProviderCapabilities;
}): Effect.Effect<ReadonlyArray<ComposeConfigFileInput>, LandofileValidationError> =>
  Effect.gen(function* () {
    const definitions = input.landofile.configs ?? {};
    const grants = grantSources(input.landofile);
    if (Object.keys(definitions).length === 0 && grants.length === 0) return [];
    if (!providerRealizesConfigs(input.capabilities)) return [];

    const definedNames = new Set(Object.keys(definitions));

    for (const grant of grants) {
      if (definedNames.has(grant.source)) continue;
      return yield* Effect.fail(
        new LandofileValidationError({
          message: `Service ${grant.service} grants Compose config ${grant.source}, which is not defined under top-level configs. Add configs.${grant.source}.file or remove the grant.`,
          file: `${input.appRoot}/.lando.yml`,
          issues: [`services.${grant.service}.configs`, `configs.${grant.source}`],
        }),
      );
    }

    if (input.fileSystem === undefined) {
      return yield* Effect.fail(
        new LandofileValidationError({
          message:
            "The Landofile declares configs, but the FileSystem service is unavailable. Provide FileSystem so config files can be read.",
          file: `${input.appRoot}/.lando.yml`,
          issues: ["configs"],
        }),
      );
    }

    const inputs: Array<ComposeConfigFileInput> = [];
    for (const [name, definition] of Object.entries(definitions)) {
      if (!isRecord(definition)) continue;
      if (definition.external === true) {
        return yield* Effect.fail(
          new LandofileValidationError({
            message: `Compose config ${name} uses external: true, which Lando does not realize. Remove external and set file: to a path under the app root.`,
            file: `${input.appRoot}/.lando.yml`,
            issues: [`configs.${name}.external`],
          }),
        );
      }
      if (typeof definition.file !== "string" || definition.file.length === 0) {
        return yield* Effect.fail(
          new LandofileValidationError({
            message: `Compose config ${name} is missing file:. Set file: to a readable path under the app root.`,
            file: `${input.appRoot}/.lando.yml`,
            issues: [`configs.${name}.file`],
          }),
        );
      }
      const source = resolve(input.appRoot, definition.file);
      const content = yield* input.fileSystem.readText(source).pipe(
        Effect.mapError(
          (cause) =>
            new LandofileValidationError({
              message: `Unable to read config file ${source} for configs.${name}: ${cause.message}. Create a readable file at that path or remove the configs entry.`,
              file: source,
              issues: [`configs.${name}.file`],
            }),
        ),
      );
      inputs.push({ name, source, hash: createHash("sha256").update(content).digest("hex") });
    }
    return inputs;
  });
