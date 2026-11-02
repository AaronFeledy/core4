import { RedactionService, makeRedactionService } from "@lando/redaction/service";
import { Effect, Layer } from "effect";

/** Each acquisition owns the registry shared by fixture producers and consumers. */
export const testRedactionLayer = (values: readonly string[] = []) =>
  Layer.effect(
    RedactionService,
    Effect.gen(function* () {
      const service = makeRedactionService();
      yield* service.registerValues(values);
      return service;
    }),
  );
