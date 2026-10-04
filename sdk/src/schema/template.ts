import { Schema } from "effect";

import { GlobalConfig } from "./config.ts";
import { LandofileShape } from "./landofile.ts";
import { AbsolutePath, BootstrapLevel, ProviderId } from "./primitives.ts";

// Template render context — passed to TemplateEngine.render.

export const TemplateRenderContext = Schema.Struct({
  /** Bootstrap level the renderer is running at. */
  bootstrapLevel: BootstrapLevel,
  /** App root (when known). */
  appRoot: Schema.optionalKey(AbsolutePath),
  /** Effective env at render time. */
  env: Schema.Record(Schema.String, Schema.String),
  /** Resolved global config snapshot (immutable). */
  global: Schema.optionalKey(GlobalConfig),
  /** Resolved Landofile (immutable). */
  landofile: Schema.optionalKey(LandofileShape),
  /** Provider id, if selected. */
  provider: Schema.optionalKey(ProviderId),
  /** Render scope tag for cache keying (`landofile`, `recipe`, `mount`, …). */
  scope: Schema.String,
});
export type TemplateRenderContext = typeof TemplateRenderContext.Type;
