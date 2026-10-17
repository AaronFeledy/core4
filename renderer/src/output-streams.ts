import type { RendererIO } from "@lando/sdk/renderer";

export const outputStreams = new WeakMap<
  RendererIO["writeStdout"],
  {
    readonly stream: NodeJS.WriteStream;
    readonly isBroken: () => boolean;
    readonly isBlocked: () => boolean;
  }
>();

export const outputDrainWaiters = new WeakMap<object, number>();
