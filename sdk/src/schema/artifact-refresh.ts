import { Schema } from "effect";

/** Plan extension carrying how long a local image may be reused before a registry check. */
export const ARTIFACT_REFRESH_EXTENSION = "@lando/artifact-refresh";

/** Stock floating tags are checked against the registry about once a week. */
export const STOCK_TAG_REFRESH_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export const ArtifactRefreshIntent = Schema.Struct({
  afterMs: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
});
export type ArtifactRefreshIntent = typeof ArtifactRefreshIntent.Type;
