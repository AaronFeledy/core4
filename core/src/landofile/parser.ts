/**
 * Landofile YAML parser with `!load` and `!import` extensions.
 *
 * `!load` returns the parsed/raw value directly. `!import` returns an
 * `ImportRef` that preserves the original filename in metadata; consumers
 * like the CA installer use this to choose a sensible in-container filename.
 *
 * Hint suffixes:
 * - `@string` — read as UTF-8 string
 * - `@yaml` — parse as YAML
 * - `@json` — parse as JSON
 * - `@binary` — read as bytes; emit base64
 *
 * Default inference (when no hint):
 * - `.yml` / `.yaml` → `@yaml`
 * - `.json` → `@json`
 * - otherwise → `@string`
 *
 * Status: stub. The YAML parser itself lives behind the `LandofileParser`
 * abstraction; `js-yaml` is not used directly.
 */
import type { Effect } from "effect";

import type { LandofileParseError } from "@lando/sdk/errors";

export type LoadHint = "string" | "yaml" | "json" | "binary";

export interface ImportRef {
  readonly _tag: "ImportRef";
  readonly path: string;
  readonly originalFilename: string;
  readonly content: string;
  readonly hint: LoadHint;
}

export interface ParseOptions {
  readonly file: string;
  readonly content: string;
  readonly cwd: string;
}

/**
 * TODO: parse YAML with `!load`/`!import` tag handlers.
 * Plug a low-level YAML parser via `LandofileParser` abstraction.
 */
export const parseLandofile = (_options: ParseOptions): Effect.Effect<unknown, LandofileParseError> => {
  throw new Error("parseLandofile: not yet implemented");
};
