import { Schema } from "effect";

export const ProbeIntervalSeconds = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0));
export const ProbeTimeoutSeconds = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThan(0));
export const ProbeRetries = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));
