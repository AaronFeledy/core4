/**
 * Tiny pre-renderer for the CLI fast path.
 *
 * This module must stay dependency-free apart from Node builtins so the first
 * paint happens before the renderer layer and any plugin code load.
 *
 * The function returns the banner string so the caller can later publish a
 * synthetic `paint.banner` event to the Renderer Layer; that hand-off lets
 * renderers like `json` know what was already shown without emitting a
 * duplicate line.
 */

export const DEFAULT_BANNER_RUNTIME_LABEL = "lando runtime";

export interface FormatBannerOptions {
  readonly commandId: string;
  readonly runtime?: string;
  readonly isTTY?: boolean;
}

export interface PaintBannerStream {
  readonly write: (chunk: string) => unknown;
}

export interface PaintBannerOptions extends FormatBannerOptions {
  readonly stream?: PaintBannerStream | undefined;
}

export interface PaintBannerResult {
  readonly banner: string;
  readonly emitted: boolean;
}

export const formatBanner = (options: FormatBannerOptions): string => {
  const runtime = options.runtime ?? DEFAULT_BANNER_RUNTIME_LABEL;
  return `▲ Starting ${options.commandId} (using ${runtime})…`;
};

export const paintBanner = (options: PaintBannerOptions): PaintBannerResult => {
  const banner = formatBanner(options);
  const stream = options.stream ?? process.stdout;
  if (stream === undefined || typeof stream.write !== "function") {
    return { banner, emitted: false };
  }
  stream.write(`${banner}\n`);
  return { banner, emitted: true };
};
