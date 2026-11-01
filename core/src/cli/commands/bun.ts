import { Effect, Schema } from "effect";

import { Renderer } from "@lando/sdk/services";
import { ChildOutput } from "../child-output.ts";
import { bunSelfRun, bunSelfX } from "./bun-self-runner";

export interface MetaBunOptions {
  readonly argv: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly execPath?: string;
}

export interface MetaBunResult {
  readonly exitCode: number;
}

export const MetaBunResultSchema = Schema.Struct({
  exitCode: Schema.Number,
});

export const metaBun = Effect.fn("MetaBun.run")(function* (options: MetaBunOptions) {
  const result = yield* bunSelfRun({
    argv: options.argv,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    output: "native",
    ...(options.execPath === undefined ? {} : { execPath: options.execPath }),
  });
  return { exitCode: result.exitCode };
});

// Completion carries the exit status; native stdout remains the child's payload.
export const renderMetaBunResult = (_result: MetaBunResult): undefined => undefined;

export interface MetaXOptions {
  readonly spec: string;
  readonly argv: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly execPath?: string;
  readonly onBanner?: (line: string) => void;
}

export interface MetaXResult {
  readonly spec: string;
  readonly exitCode: number;
}

export const MetaXResultSchema = Schema.Struct({
  spec: Schema.String,
  exitCode: Schema.Number,
});

export const metaX = Effect.fn("MetaBun.runX")(function* (options: MetaXOptions) {
  const banner = `Running ${options.spec}`;
  const policy = yield* ChildOutput;
  if (policy?.native === true) {
    if (options.onBanner !== undefined) options.onBanner(banner);
    else {
      const renderer = yield* Effect.serviceOption(Renderer);
      if (renderer._tag === "Some") yield* renderer.value.message.info(banner);
    }
  }
  const result = yield* bunSelfX({
    spec: options.spec,
    argv: options.argv,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    output: "native",
    ...(options.execPath === undefined ? {} : { execPath: options.execPath }),
  });
  return { spec: options.spec, exitCode: result.exitCode };
});

export const renderMetaXResult = (_result: MetaXResult): undefined => undefined;
