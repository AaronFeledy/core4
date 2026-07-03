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
 * This subpath is type/contract only (like `@lando/sdk/expressions` and
 * `@lando/sdk/template`). It exports no runtime values and never appears in the
 * `Object.keys()` runtime export checks.
 */
import type { Layer } from "effect";

import type { EventService, Renderer } from "../services/index.ts";

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

/**
 * A resolved renderer contribution: the `Renderer` service layer and the
 * event-consumer layer for a given {@link RendererIO}, both built and owned by
 * the contributing plugin. A renderer plugin exports one of these as `renderer`.
 */
export interface RendererContribution {
  readonly id: string;
  readonly makeService: (io: RendererIO) => Layer.Layer<Renderer>;
  readonly makeEventConsumer: (io: RendererIO) => Layer.Layer<never, never, EventService>;
}
