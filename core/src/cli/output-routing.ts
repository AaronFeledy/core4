import type { ResultFormat } from "./format-flags";
import type { RendererMode } from "./renderer-selection";

type NarrationRoute = "mode-narration" | "json-event-dump" | "verbose-dump";
type EnvelopeEventRoute = "notifications-only" | "silent-lando-consumer" | "verbose-dump" | "none";

/**
 * Where one command run's output goes. `human` is the only non-machine route;
 * every other route ends in exactly one terminal document (an envelope, or the
 * result frame that ends a frame sequence) written after the runtime closes.
 */
export type OutputRouting =
  | { readonly stdout: "human"; readonly events: NarrationRoute; readonly sink: "live" | "none" }
  | {
      readonly stdout: "envelope";
      readonly serialization: "json" | "yaml";
      readonly events: EnvelopeEventRoute;
      readonly sink: "discard" | "none";
    }
  | { readonly stdout: "frames"; readonly events: "frames"; readonly sink: "live" | "none" }
  | { readonly stdout: "report"; readonly events: NarrationRoute; readonly sink: "none" };

const narrationRoutes = {
  lando: "mode-narration",
  plain: "mode-narration",
  json: "json-event-dump",
  verbose: "verbose-dump",
} as const satisfies Record<RendererMode, NarrationRoute>;

const envelopeRoutes = {
  lando: "silent-lando-consumer",
  plain: "none",
  json: "notifications-only",
  verbose: "verbose-dump",
} as const satisfies Record<RendererMode, EnvelopeEventRoute>;

export const resolveOutputRouting = (
  input: {
    readonly rendererMode: RendererMode;
    readonly format: ResultFormat;
    /** The command declares a frame schema. */
    readonly frames: boolean;
    readonly live: boolean;
    /** The command supplies its own `ndjson` report frames. */
    readonly report: boolean;
  },
  selection?: { readonly jqExpression?: string; readonly projectResultKeys?: readonly string[] },
): OutputRouting => {
  const sink = input.live ? "live" : "none";
  const framed = input.frames || input.live;
  switch (input.format) {
    case "json": {
      const selectsResult =
        selection?.jqExpression !== undefined || selection?.projectResultKeys !== undefined;
      return framed && !selectsResult
        ? { stdout: "frames", events: "frames", sink }
        : {
            stdout: "envelope",
            serialization: "json",
            events: envelopeRoutes[input.rendererMode],
            // Keep the live result shape without buffering output the selection never saw.
            sink: input.live ? "discard" : "none",
          };
    }
    case "ndjson":
      return input.report && !framed
        ? { stdout: "report", events: narrationRoutes[input.rendererMode], sink: "none" }
        : { stdout: "frames", events: "frames", sink };
    case "yaml":
      return {
        stdout: "envelope",
        serialization: "yaml",
        events: envelopeRoutes[input.rendererMode],
        sink: "none",
      };
    case "text":
    case "table":
      return { stdout: "human", events: narrationRoutes[input.rendererMode], sink };
    default: {
      const exhaustive: never = input.format;
      return exhaustive;
    }
  }
};
