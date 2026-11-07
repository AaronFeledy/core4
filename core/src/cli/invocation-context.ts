import type { RendererIO } from "@lando/renderer/io";
import { createStdioRendererIO } from "@lando/renderer/io";
import type { LandoEvent, RuntimeProviderRegistry } from "@lando/sdk/services";
import { Context, type Layer } from "effect";

/** Host-owned resources for one CLI invocation. */
export interface CliInvocationContext {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly io: RendererIO;
  readonly setExitCode: (code: number) => void;
  readonly providerRegistry?: Layer.Layer<RuntimeProviderRegistry>;
  readonly serviceLayers?: ReadonlyArray<Layer.Layer<never, unknown>>;
  readonly observeEvent?: (event: LandoEvent) => void;
}

export const processInvocationContext = (): CliInvocationContext => ({
  cwd: process.cwd(),
  env: { ...process.env },
  io: createStdioRendererIO(),
  setExitCode: (code) => {
    process.exitCode = code;
  },
});

export const processInvocationDefaults: CliInvocationContext = {
  get cwd() {
    return process.cwd();
  },
  get env() {
    return process.env;
  },
  get io() {
    return createStdioRendererIO();
  },
  setExitCode: (code) => {
    process.exitCode = code;
  },
};

export const CliInvocation = Context.Reference<CliInvocationContext>("@lando/core/CliInvocation", {
  defaultValue: () => processInvocationDefaults,
});
