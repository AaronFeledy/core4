import type { RendererIO } from "@lando/renderer/io";
import * as RendererOutput from "@lando/renderer/output";
import type { RendererContribution } from "@lando/sdk/renderer";
import { Effect } from "effect";
import type { RenderedOutput } from "./command-settlement";
import type { RendererMode } from "./renderer-selection";
import type { TerminalWrite } from "./terminal-document";

/** Collects a render's writes in order, undecoded, so bytes and stream interleaving stay exact. */
const capturedWrites = () => {
  const writes: Array<Extract<TerminalWrite, { readonly channel: "stdout" | "stderr" }>> = [];
  const writer = (channel: "stdout" | "stderr") => (chunk: string | Uint8Array) => {
    // A write consumes its bytes when it is made, so a caller may reuse its buffer afterwards.
    if (chunk.length > 0)
      writes.push({ channel, text: typeof chunk === "string" ? chunk : new Uint8Array(chunk) });
  };
  return { stdout: writer("stdout"), stderr: writer("stderr"), writes: (): RenderedOutput => writes };
};

/**
 * Runs a command's human render against a renderer that buffers its writes,
 * so the render's output joins the terminal document instead of preceding the
 * runtime teardown. The buffer keeps the real output's terminal facts.
 */
export const captureRender = Effect.fnUntraced(function* <E, R>(
  render: Effect.Effect<void, E, R>,
  rendererMode: RendererMode,
  landoRenderer: RendererContribution,
  io: RendererIO,
) {
  const captured = capturedWrites();
  const capture: RendererIO = { ...io, writeStdout: captured.stdout, writeStderr: captured.stderr };
  yield* Effect.provide(render, RendererOutput.layerServiceForMode(rendererMode, landoRenderer, capture));
  return captured.writes();
});
