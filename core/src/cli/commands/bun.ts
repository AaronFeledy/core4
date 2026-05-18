import { Effect } from "effect";

import type { NotImplementedError } from "@lando/sdk/errors";

import { type BunSelfSpawner, bunSelfRun, bunSelfX } from "./bun-self-runner.ts";

export interface MetaBunOptions {
  readonly argv: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly spawner?: BunSelfSpawner;
  readonly execPath?: string;
}

export interface MetaBunResult {
  readonly exitCode: number;
}

export const metaBun = (options: MetaBunOptions): Effect.Effect<MetaBunResult, NotImplementedError> =>
  Effect.gen(function* () {
    const result = yield* bunSelfRun({
      argv: options.argv,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.spawner === undefined ? {} : { spawner: options.spawner }),
      ...(options.execPath === undefined ? {} : { execPath: options.execPath }),
    });
    return { exitCode: result.exitCode };
  });

export const renderMetaBunResult = (result: MetaBunResult): string | undefined =>
  result.exitCode === 0 ? undefined : `bun exited with code ${result.exitCode}`;

export interface MetaXOptions {
  readonly spec: string;
  readonly argv: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly spawner?: BunSelfSpawner;
  readonly execPath?: string;
  readonly onBanner?: (line: string) => void;
}

export interface MetaXResult {
  readonly spec: string;
  readonly exitCode: number;
}

export const metaX = (options: MetaXOptions): Effect.Effect<MetaXResult, NotImplementedError> =>
  Effect.gen(function* () {
    const banner = `Running ${options.spec}`;
    if (options.onBanner !== undefined) options.onBanner(banner);
    else process.stdout.write(`${banner}\n`);
    const result = yield* bunSelfX({
      spec: options.spec,
      argv: options.argv,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.spawner === undefined ? {} : { spawner: options.spawner }),
      ...(options.execPath === undefined ? {} : { execPath: options.execPath }),
    });
    return { spec: options.spec, exitCode: result.exitCode };
  });

export const renderMetaXResult = (result: MetaXResult): string | undefined =>
  result.exitCode === 0 ? undefined : `${result.spec} exited with code ${result.exitCode}`;
