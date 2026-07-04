import { Context, type Effect, type Stream } from "effect";

import type { ProcessExecError, ProcessTimeoutError, ShellExecError } from "../errors/index.ts";

export interface ShellCommandOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly shell?: "bun";
}

export interface ProcessSpawnOptions {
  readonly cmd: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly stdin?: string | Uint8Array;
  readonly timeoutMs?: number;
}

export interface ProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ShellInteractiveSpec {
  readonly shell: string;
  readonly args?: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  /** Ensures this file's parent dir exists and injects `HISTFILE` into the shell. */
  readonly historyFile?: string;
}

export interface ShellInteractiveResult {
  readonly exitCode: number;
}

export interface ProcessStreamChunk {
  readonly kind: "stdout" | "stderr";
  readonly chunk: Uint8Array;
}

export class ProcessRunner extends Context.Tag("@lando/core/ProcessRunner")<
  ProcessRunner,
  {
    readonly run: (
      options: ProcessSpawnOptions,
    ) => Effect.Effect<ProcessResult, ProcessExecError | ProcessTimeoutError>;
    readonly stream: (
      options: ProcessSpawnOptions,
    ) => Stream.Stream<ProcessStreamChunk, ProcessExecError | ProcessTimeoutError>;
  }
>() {}

export class ShellRunner extends Context.Tag("@lando/core/ShellRunner")<
  ShellRunner,
  {
    readonly exec: (
      command: string,
      options?: ShellCommandOptions,
    ) => Effect.Effect<ProcessResult, ShellExecError>;
    readonly run: (
      command: string,
      options?: ShellCommandOptions,
    ) => Effect.Effect<ProcessResult, ShellExecError>;
    readonly runScript: (
      path: string,
      options?: ShellCommandOptions,
    ) => Effect.Effect<ProcessResult, ShellExecError>;
    readonly interactive: (
      spec: ShellInteractiveSpec,
    ) => Effect.Effect<ShellInteractiveResult, ShellExecError>;
  }
>() {}

export class PrivilegeService extends Context.Tag("@lando/core/PrivilegeService")<
  PrivilegeService,
  {
    readonly elevate: (command: ReadonlyArray<string>) => Effect.Effect<ProcessResult, never>;
  }
>() {}
