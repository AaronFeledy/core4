import { Context, type Effect, type Stream } from "effect";

import type {
  ProcessExecError,
  ProcessTimeoutError,
  SecretNotFoundError,
  ShellExecError,
} from "../errors/index.ts";

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

export type ShellReplInput =
  | { readonly _tag: "line"; readonly line: string }
  | { readonly _tag: "interrupt" }
  | { readonly _tag: "eof" };

export interface ShellReplIO {
  readonly input: AsyncIterable<ShellReplInput>;
  readonly writeStdout: (chunk: string) => void;
  readonly writeStderr: (chunk: string) => void;
  readonly prompt?: () => void;
  readonly close?: () => void;
}

export interface ShellInteractiveSpec {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  readonly historyFile?: string;
  readonly historyLimit?: number;
  readonly io?: ShellReplIO;
  readonly resolveSecret: (id: string) => Effect.Effect<string, SecretNotFoundError>;
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
