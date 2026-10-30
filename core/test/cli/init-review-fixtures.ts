import { LandofileAuthoringFragment } from "@lando/sdk/schema";
import { Schema } from "effect";
import type { RecipeInitReview } from "../../src/recipes/prepared-init";

export const reviewWith = (source: unknown = {}): RecipeInitReview => ({
  appName: "chosen-app",
  appRoot: "/tmp/projects/日本語  wide path",
  source: Schema.decodeUnknownSync(LandofileAuthoringFragment)(source),
  outputs: [{ destination: ".lando.yml", mode: 0o644, digest: "sha256:fixture", bytes: 123 }],
  actions: [],
  skippedScaffold: [],
  diagnostics: [],
});
