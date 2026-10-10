/** Test `RedactionService` layer for plugin and engine operation harnesses. */
import { Effect, Layer } from "effect";

import {
  RedactionService,
  createStandaloneRedactor,
  registerRedactionValues,
} from "@lando/redaction/service";

export const testRedactionLayer = Layer.succeed(
  RedactionService,
  RedactionService.of({
    registerValues: registerRedactionValues,
    forProfile: (profile, redactionOptions) =>
      Effect.succeed(createStandaloneRedactor(profile, redactionOptions)),
  }),
);
