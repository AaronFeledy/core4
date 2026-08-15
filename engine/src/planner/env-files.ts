import { createHash } from "node:crypto";
import { resolve } from "node:path";

import { type Context, Effect } from "effect";

import { parseEnvFile } from "@lando/landofile/env-file";
import { LandofileValidationError } from "@lando/sdk/errors";
import type { ServiceConfig } from "@lando/sdk/schema";
import type { FileSystem } from "@lando/sdk/services";

type EnvFileInput = {
  readonly appRoot: string;
  readonly envFiles: ReadonlyArray<string>;
  readonly fileSystem: Context.Tag.Service<typeof FileSystem> | undefined;
  readonly owner: string;
  readonly readContext: string;
  readonly issuePath: string;
};

type LoadedEnvFiles = {
  readonly environment: Readonly<Record<string, string>>;
  readonly inputs: ReadonlyArray<{ readonly source: string; readonly hash: string }>;
};

const loadEnvFiles = (input: EnvFileInput): Effect.Effect<LoadedEnvFiles, LandofileValidationError> =>
  Effect.gen(function* () {
    if (input.envFiles.length === 0) return { environment: {}, inputs: [] };
    if (input.fileSystem === undefined) {
      return yield* Effect.fail(
        new LandofileValidationError({
          message: `${input.owner} declares env_file, but the FileSystem service is unavailable. Provide FileSystem so env files can be read.`,
          file: `${input.appRoot}/.lando.yml`,
          issues: [input.issuePath],
        }),
      );
    }

    const environment: Record<string, string> = {};
    const inputs: Array<{ readonly source: string; readonly hash: string }> = [];
    for (const [index, authoredPath] of input.envFiles.entries()) {
      const source = resolve(input.appRoot, authoredPath);
      const content = yield* input.fileSystem.readText(source).pipe(
        Effect.mapError(
          (cause) =>
            new LandofileValidationError({
              message: `Unable to read env file ${source} ${input.readContext}: ${cause.message}. Create a readable env file at that path or remove it from env_file.`,
              file: source,
              issues: [`${input.issuePath}[${index}]`],
            }),
        ),
      );
      const parsed = parseEnvFile(content, source);
      if (!parsed.ok) {
        return yield* Effect.fail(
          new LandofileValidationError({
            message: `Invalid env file entry at ${parsed.issue.source}:${parsed.issue.line}: ${parsed.issue.message} Use KEY=VALUE entries, optionally prefixed with export.`,
            file: parsed.issue.source,
            issues: [`line ${parsed.issue.line}`],
          }),
        );
      }
      Object.assign(environment, parsed.environment);
      inputs.push({ source, hash: createHash("sha256").update(content).digest("hex") });
    }
    return { environment, inputs };
  });

export const loadTopLevelEnvFiles = (input: {
  readonly appRoot: string;
  readonly envFiles: ReadonlyArray<string>;
  readonly fileSystem: Context.Tag.Service<typeof FileSystem> | undefined;
}): Effect.Effect<LoadedEnvFiles, LandofileValidationError> =>
  loadEnvFiles({
    ...input,
    owner: "The Landofile",
    readContext: "declared by the Landofile",
    issuePath: "env_file",
  });

export const loadServiceEnvFiles = (input: {
  readonly appRoot: string;
  readonly serviceName: string;
  readonly service: ServiceConfig;
  readonly fileSystem: Context.Tag.Service<typeof FileSystem> | undefined;
}): Effect.Effect<
  {
    readonly environment: Readonly<Record<string, string>> | undefined;
    readonly inputs: LoadedEnvFiles["inputs"];
  },
  LandofileValidationError
> =>
  loadEnvFiles({
    appRoot: input.appRoot,
    envFiles: input.service.envFile ?? [],
    fileSystem: input.fileSystem,
    owner: `Service ${input.serviceName}`,
    readContext: `for service ${input.serviceName}`,
    issuePath: `services.${input.serviceName}.envFile`,
  }).pipe(
    Effect.map(({ environment, inputs }) => ({
      environment: { ...environment, ...(input.service.environment ?? {}) },
      inputs,
    })),
  );
