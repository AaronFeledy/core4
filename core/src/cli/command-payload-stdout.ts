import type { RendererIO } from "@lando/renderer/io";
import { Context, type Effect } from "effect";

/** Unredacted payload writer to the real stdout when machine output owns stderr. */
export class CommandPayloadStdout extends Context.Service<
  CommandPayloadStdout,
  (chunk: Uint8Array) => Effect.Effect<void>
>()("@lando/core/CommandPayloadStdout") {}

export const machineOutputOnStderr = (io: RendererIO): RendererIO => ({
  ...io,
  writeStdout: io.writeStderr,
  stdoutIsTTY: io.isTTY === true,
  get stdoutColumns() {
    return io.terminalColumns;
  },
});
