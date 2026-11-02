import type { ResultFormat } from "./format-flags";
import type { RendererMode } from "./renderer-selection";

type NarrationRoute = "mode-narration" | "json-event-dump" | "verbose-dump";
type EnvelopeEventRoute = "notifications-only" | "silent-lando-consumer" | "verbose-dump" | "none";

export type OutputRouting = (
  | { readonly stdout: "human"; readonly events: NarrationRoute }
  | { readonly stdout: "envelope"; readonly events: EnvelopeEventRoute }
  | { readonly stdout: "frames"; readonly events: "frames" }
) & { readonly sink: "live" | "none" };

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

export const resolveOutputRouting = (input: {
  readonly rendererMode: RendererMode;
  readonly format: ResultFormat;
  readonly declaresStreaming: boolean;
  readonly live: boolean;
}): OutputRouting => {
  const sink = input.live ? "live" : "none";
  switch (input.format) {
    case "json":
      return input.declaresStreaming || input.live
        ? { stdout: "frames", events: "frames", sink }
        : { stdout: "envelope", events: envelopeRoutes[input.rendererMode], sink };
    case "yaml":
      return { stdout: "envelope", events: envelopeRoutes[input.rendererMode], sink: "none" };
    case "text":
    case "table":
    case "ndjson":
      return { stdout: "human", events: narrationRoutes[input.rendererMode], sink };
    default: {
      const exhaustive: never = input.format;
      return exhaustive;
    }
  }
};
