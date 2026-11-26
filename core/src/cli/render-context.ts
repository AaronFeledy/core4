import type { FormatSummaryOptions } from "@lando/renderer/summary";
import type { ResultFormat } from "./format-flags";
import type { RendererMode } from "./renderer-selection";

/** The terminal facts a human result renderer paints for. */
export interface RenderContext {
  readonly mode: RendererMode;
  readonly format: ResultFormat;
  readonly columns: number | undefined;
  readonly isTTY: boolean;
  readonly proxyDefaultDomain?: string;
  readonly noColor: boolean;
  /** Exact-value redactor for summary fields; apply before paint, never after. */
  readonly redact?: (text: string) => string;
}

/** Decorated grouped summaries apply only in the default `lando` renderer on a TTY. */
export const isDecoratedContext = (ctx?: RenderContext): boolean =>
  ctx?.mode === "lando" && ctx.isTTY === true;

/**
 * OSC 8 wraps existing labels only where decorated output already goes: the
 * default `lando` renderer on a TTY, with TERM not dumb and NO_COLOR unset.
 * `--renderer=plain` advertises `color: false`, so it stays escape-free.
 */
export const contextAllowsHyperlinks = (ctx?: RenderContext): boolean =>
  ctx !== undefined && isDecoratedContext(ctx) && !ctx.noColor;

/** Columns + before-paint redactor for {@link formatSummary}. */
export const summaryPaintOptions = (ctx?: RenderContext): FormatSummaryOptions => ({
  color: ctx?.noColor !== true,
  hyperlinks: contextAllowsHyperlinks(ctx),
  ...(ctx?.columns === undefined ? {} : { columns: ctx.columns }),
  ...(ctx?.redact === undefined ? {} : { redact: ctx.redact }),
});
