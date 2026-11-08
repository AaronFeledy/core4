import { Schema } from "effect";

import { GlobalReconciliationPending } from "./reconciliation.ts";

export class GlobalPolicyReconciliationError extends Schema.TaggedError<GlobalPolicyReconciliationError>()(
  "GlobalPolicyReconciliationError",
  {
    message: Schema.String,
    operation: Schema.Literals(["enable", "disable", "reconcile"]),
    policySaved: Schema.Boolean,
    revision: Schema.Number,
    contributions: Schema.Array(Schema.String),
    plugins: Schema.Array(Schema.String),
    servicesRemoved: Schema.Array(Schema.String),
    pending: Schema.Array(GlobalReconciliationPending),
    remediation: Schema.String,
    causes: Schema.Array(Schema.Unknown),
  },
) {}
