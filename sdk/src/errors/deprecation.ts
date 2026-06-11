import { Schema } from "effect";

import { DeprecationNotice, DeprecationSurfaceKind } from "../schema/deprecation.ts";

export class DeprecatedSurfaceError extends Schema.TaggedError<DeprecatedSurfaceError>()(
  "DeprecatedSurfaceError",
  {
    kind: DeprecationSurfaceKind,
    id: Schema.String,
    notice: DeprecationNotice,
  },
) {}

export class DeprecationContradictionError extends Schema.TaggedError<DeprecationContradictionError>()(
  "DeprecationContradictionError",
  {
    canonicalId: Schema.String,
    aliasId: Schema.String,
    canonicalNotice: DeprecationNotice,
  },
) {}
