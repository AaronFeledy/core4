/**
 * Tiny pre-renderer used by the CLI fast path for the first-paint banner
 * defined in spec §8.9.1.
 *
 * Loaded BEFORE the Renderer Layer is forced and BEFORE any plugin module is
 * imported. To preserve the §2.1 cold first-byte budget and the "no Effect on
 * the fast path" canary, this module MUST NOT import Effect, the Renderer
 * service, @oclif/core, the Lando SDK, or any plugin code. Node builtins are
 * the only permitted dependencies.
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
