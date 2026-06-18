/**
 * `@lando/sdk/renderer` — pluggable terminal-renderer contracts.
 *
 * The default user-facing renderer (`lando`) ships as the bundled internal
 * `@lando/renderer-lando` plugin. This subpath defines the contracts that let a
 * renderer plugin assemble a `Renderer` service plus its event-consumer layer
 * WITHOUT importing core internals: core supplies the reusable rendering
 * primitives ({@link RendererRuntimePrimitives}) and the plugin owns the
 * renderer's identity and event-routing assembly ({@link RendererContribution}).
 *
 * This subpath is type/contract only (like `@lando/sdk/expressions` and
 * `@lando/sdk/template`). It exports no runtime values and never appears in the
 * `Object.keys()` runtime export checks; the visual implementation (task-tree
 * painter, keybindings, formatters) stays in core and is exposed to the plugin
 * only through the {@link RendererRuntimePrimitives} dependency-injection seam.
 */
import type { Layer } from "effect";

import type { EventService, LandoEvent, Renderer } from "../services/index.ts";

/**
 * The terminal I/O seam constructed at the CLI command boundary and injected
 * into a renderer's factories. `isTTY` engages the interactive task-tree tail;
 * the column/row hints bound wrapping and the expanded detail pane.
 */
export interface RendererIO {
  readonly writeStdout: (chunk: string) => void;
  readonly writeStderr: (chunk: string) => void;
  /** `true` engages the interactive task-tree tail; `undefined`/`false` falls back to plain. */
  readonly isTTY?: boolean;
  /** Terminal width used by the TTY tail to account for wrapped rows. */
  readonly terminalColumns?: number | undefined;
  /** Terminal height used to bound the expanded task-detail tail. */
  readonly terminalRows?: number | undefined;
  /** Subscribe to raw keypress chunks; returns an unsubscribe that restores input state. */
  readonly subscribeInput?: (onKey: (raw: string) => void) => () => void;
}

/** Options for {@link RendererRuntimePrimitives.createTaskTreePainter}. */
export interface TaskTreePainterOptions {
  readonly getTerminalColumns?: () => number | undefined;
  readonly getTerminalRows?: () => number | undefined;
}

/**
 * Opaque handle over the core task-tree painter. A renderer plugin uses
 * `consume`/`passthrough` to route events and `makeInputLive` to attach the TTY
 * keyboard layer; the painter's internal state and the input controller stay
 * core-private (never exposed as SDK surface).
 */
export interface TaskTreePainterHandle {
  /** Apply a render event and return the byte chunk to write for the live frame. */
  readonly consume: (event: LandoEvent) => string;
  /** Emit a plain line above the live frame, then repaint the frame beneath it. */
  readonly passthrough: (line: string) => string;
  /** Build the TTY keyboard-input layer bound to this painter (focus/expand/collapse). */
  readonly makeInputLive: (io: RendererIO) => Layer.Layer<never, never, EventService>;
}

/**
 * Reusable rendering primitives supplied by core to a renderer plugin. These
 * keep the visual implementation (painter, keybindings, line formatters,
 * message/output infra) in core while letting the plugin own the renderer's
 * identity and per-event routing assembly.
 */
export interface RendererRuntimePrimitives {
  /** Build the `Renderer` service layer for a given mode id (message contract + raw output channel). */
  readonly makeRendererService: (io: RendererIO, id: string) => Layer.Layer<Renderer>;
  /** Create a task-tree painter handle bound to the supplied terminal-size getters. */
  readonly createTaskTreePainter: (options: TaskTreePainterOptions) => TaskTreePainterHandle;
  /** Wrap a synchronous per-event handler in the EventService subscription/drain layer. */
  readonly makeEventConsumer: (
    handle: (event: LandoEvent) => void,
  ) => Layer.Layer<never, never, EventService>;
  /** Format a renderable event as a single plain line, or `null` when not renderable. */
  readonly renderPlainLine: (event: LandoEvent) => string | null;
  /** `true` when the event participates in the task-tree (vs. a passthrough line). */
  readonly isRenderableTaskTreeEvent: (event: LandoEvent) => boolean;
}

/**
 * A resolved renderer contribution: the `Renderer` service layer and the
 * event-consumer layer for a given {@link RendererIO}, both built by the
 * contributing plugin.
 */
export interface RendererContribution {
  readonly id: string;
  readonly makeService: (io: RendererIO) => Layer.Layer<Renderer>;
  readonly makeEventConsumer: (io: RendererIO) => Layer.Layer<never, never, EventService>;
}

/**
 * The plugin export shape consumed by core's bundled-renderer registry: a
 * factory that, given core-supplied {@link RendererRuntimePrimitives}, produces
 * a {@link RendererContribution}. A renderer plugin exports a
 * `ReadonlyMap<string, RendererContributionFactory>` named `rendererFactories`.
 */
export interface RendererContributionFactory {
  readonly id: string;
  readonly make: (primitives: RendererRuntimePrimitives) => RendererContribution;
}
