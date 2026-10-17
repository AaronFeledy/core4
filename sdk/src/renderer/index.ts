/**
 * `@lando/sdk/renderer` — pluggable terminal-renderer contracts.
 *
 * The default user-facing renderer (`lando`) ships as the bundled internal
 * `@lando/renderer-lando` plugin, which owns the renderer implementation
 * (task-tree painter, keybindings, formatters, event routing) and exports it as
 * a finished {@link RendererContribution}. Core resolves that contribution
 * through its bundled-renderer registry instead of assembling the renderer from
 * parts. A third-party renderer plugin follows `@lando/renderer-lando` as the
 * reference implementation: it exports a `RendererContribution` named `renderer`
 * built entirely from SDK contracts, without importing core internals.
 *
 * Runtime schema exports (`RendererCapabilities` and snapshot constants) are
 * re-exported for plugin authors; raw OpenTUI probing is never published here.
 */
import type { Layer } from "effect";

import type { EventService, Renderer } from "../services/index.ts";

export * from "./format.ts";

export {
  RENDERER_CAPABILITIES_NONE,
  RENDERER_CAPABILITIES_TTY,
  RENDERER_CAPABILITIES_VERBOSE_TTY,
  RendererCapabilities,
  type RendererCapabilities as RendererCapabilitiesType,
} from "../schema/renderer-capabilities.ts";

export {
  DEFAULT_KEYMAP_BINDINGS,
  KeymapConfig,
  RENDERER_ACTION_SURFACE,
  RendererActionId,
  RendererKeyBinding,
  RendererKeyChord,
  RendererKeyChordPattern,
  RendererKeyName,
  decodeKeymapConfig,
  type KeymapConfig as KeymapConfigType,
  type KeymapSurface,
  type RendererActionId as RendererActionIdType,
  type RendererKeyBinding as RendererKeyBindingType,
  type RendererKeyChord as RendererKeyChordType,
  type RendererKeyName as RendererKeyNameType,
} from "../schema/keymap.ts";

export { validateKeymapConfigConflicts } from "../schema/keymap-conflict.ts";

export {
  PanelView,
  RendererPanelId,
  RendererPanelManifestEntry,
  RendererPanelSize,
  RendererPanelSlot,
  RendererPanelWatch,
  RendererPanelContext,
  StyledSpan,
  StyledSpanTone,
  type PanelView as PanelViewType,
  type RendererPanel,
  type RendererPanelContext as RendererPanelContextType,
  type RendererPanelId as RendererPanelIdType,
  type RendererPanelManifestEntry as RendererPanelManifestEntryType,
  type RendererPanelSize as RendererPanelSizeType,
  type RendererPanelSlot as RendererPanelSlotType,
  type RendererPanelWatch as RendererPanelWatchType,
  type StyledSpan as StyledSpanType,
  type StyledSpanTone as StyledSpanToneType,
} from "../schema/renderer-panel.ts";

/**
 * Narration-only terminal access. Event consumers cannot write command stdout.
 * All terminal metadata describes stderr, independently of redirected results.
 */
export interface RendererNarrationIO {
  readonly writeStderr: (chunk: string) => void;
  /** Stderr terminal stream; undefined degrades to line mode. */
  readonly externalOutputStream?: NodeJS.WriteStream;
  /** `true` engages the interactive task-tree tail; `undefined`/`false` falls back to plain. */
  readonly isTTY?: boolean;
  /** Terminal width used by the TTY tail to account for wrapped rows. */
  readonly terminalColumns?: number | undefined;
  /** Terminal height used to bound the expanded task-detail tail. */
  readonly terminalRows?: number | undefined;
  /** Subscribe to raw keypress chunks; returns an unsubscribe that restores input state. */
  readonly subscribeInput?: (onKey: (raw: string) => void) => () => void;
}

const NARRATION_OPTIONAL_KEYS = [
  "externalOutputStream",
  "isTTY",
  "terminalColumns",
  "terminalRows",
  "subscribeInput",
] as const satisfies ReadonlyArray<keyof RendererNarrationIO>;

const narrationViews = new WeakMap<RendererNarrationIO, RendererNarrationIO>();
const narrationViewSet = new WeakSet<RendererNarrationIO>();

/**
 * Cached narration-only view of an IO object. The view has no stdout writer at
 * runtime, reads stderr metadata live from its source, and is stable per
 * source, so state keyed by IO identity stays shared between a Renderer
 * service and its event consumer. A view projects to itself.
 */
export const narrationIO = (io: RendererNarrationIO): RendererNarrationIO => {
  if (narrationViewSet.has(io)) return io;
  const cached = narrationViews.get(io);
  if (cached !== undefined) return cached;
  const view: RendererNarrationIO = { writeStderr: (chunk) => io.writeStderr(chunk) };
  for (const key of NARRATION_OPTIONAL_KEYS) {
    if (!(key in io)) continue;
    Object.defineProperty(view, key, {
      enumerable: true,
      get: () => {
        const value: unknown = Reflect.get(io, key);
        return typeof value === "function" ? value.bind(io) : value;
      },
    });
  }
  Object.freeze(view);
  narrationViews.set(io, view);
  narrationViewSet.add(view);
  return view;
};

/** Full service IO. Only the Renderer output channel owns stdout. */
export interface RendererIO extends RendererNarrationIO {
  readonly writeStdout: (chunk: string) => void;
  readonly writeStdoutBytes?: (chunk: Uint8Array) => void;
  readonly writeStderrBytes?: (chunk: Uint8Array) => void;
  /** Result formatting and payload suspension use stdout, not the narration terminal. */
  readonly stdoutIsTTY?: boolean;
  readonly stdoutColumns?: number | undefined;
}

export interface InteractivePromptDriver {
  readonly readRaw: (request: unknown, signal?: AbortSignal) => Promise<string>;
}

/**
 * A resolved renderer contribution: the `Renderer` service layer and the
 * event-consumer layer for a given {@link RendererIO}, both built and owned by
 * the contributing plugin. A renderer plugin exports one of these as `renderer`.
 */
export interface RendererContribution {
  readonly id: string;
  readonly makeService: (io: RendererIO) => Layer.Layer<Renderer>;
  readonly makeEventConsumer: (io: RendererNarrationIO) => Layer.Layer<never, never, EventService>;
  readonly loadInteractivePromptDriver?: () => Promise<InteractivePromptDriver>;
}
