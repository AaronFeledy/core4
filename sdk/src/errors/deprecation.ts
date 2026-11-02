import { Schema } from "effect";

import { DeprecationNotice, DeprecationSurfaceKind } from "../schema/deprecation.ts";

const Remediation = Schema.NonEmptyString.check(Schema.isPattern(/\S/u));

export class DeprecatedSurfaceError extends Schema.TaggedError<DeprecatedSurfaceError>()(
  "DeprecatedSurfaceError",
  {
    kind: DeprecationSurfaceKind,
    id: Schema.String,
    notice: DeprecationNotice,
    remediation: Remediation,
  },
) {}

export class DeprecationContradictionError extends Schema.TaggedError<DeprecationContradictionError>()(
  "DeprecationContradictionError",
  {
    canonicalId: Schema.String,
    aliasId: Schema.String,
    canonicalNotice: DeprecationNotice,
    remediation: Remediation,
  },
) {}
