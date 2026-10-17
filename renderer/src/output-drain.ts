import type { RendererIO } from "@lando/sdk/renderer";
import { Effect } from "effect";
import { isBrokenPipeError } from "./io.ts";
import { outputDrainWaiters } from "./output-streams.ts";
import { outputStreams } from "./output-streams.ts";

const awaitOutputDrain = (stream: NodeJS.WriteStream): Effect.Effect<void> =>
  Effect.callback<void>((resume) => {
    if (stream.destroyed || stream.writableEnded || !stream.writableNeedDrain) {
      resume(Effect.void);
      return;
    }
    let active = true;
    const cleanup = () => {
      if (!active) return;
      active = false;
      stream.off("drain", drained);
      stream.off("close", drained);
      stream.off("error", failed);
      outputDrainWaiters.set(stream, Math.max(0, (outputDrainWaiters.get(stream) ?? 1) - 1));
    };
    const drained = () => {
      cleanup();
      resume(Effect.void);
    };
    const failed = (error: unknown) => {
      cleanup();
      resume(isBrokenPipeError(error) ? Effect.void : Effect.die(error));
    };
    outputDrainWaiters.set(stream, (outputDrainWaiters.get(stream) ?? 0) + 1);
    stream.on("drain", drained);
    stream.on("close", drained);
    stream.on("error", failed);
    return Effect.sync(cleanup);
  });

export const waitForRendererOutput = (
  io: RendererIO,
  destination: "stdout" | "stderr",
): Effect.Effect<void> =>
  Effect.suspend(() => {
    const output = outputStreams.get(destination === "stdout" ? io.writeStdout : io.writeStderr);
    return output === undefined || output.isBroken() ? Effect.void : awaitOutputDrain(output.stream);
  });
