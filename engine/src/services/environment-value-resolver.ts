import { RedactionService } from "@lando/redaction/service";
import { EnvironmentValueResolutionError } from "@lando/sdk/errors";
import { type Environment, encodeUriComponent } from "@lando/sdk/schema";
import { EnvironmentValueResolver, SecretStore } from "@lando/sdk/services";
import { Cache, Effect, Layer } from "effect";

const OUTPUT_BUDGET = 1_048_576;

export const layer = Layer.effect(
  EnvironmentValueResolver,
  Effect.gen(function* () {
    const store = yield* SecretStore;
    const redaction = yield* RedactionService;
    return EnvironmentValueResolver.of({
      openSession: Effect.fn("EnvironmentValueResolver.openSession")(function* () {
        const references = yield* Cache.make({
          capacity: Number.POSITIVE_INFINITY,
          lookup: (reference: string) =>
            store
              .get(reference)
              .pipe(Effect.tap((raw) => redaction.registerValues([raw, encodeUriComponent(raw)]))),
        });
        yield* Effect.addFinalizer(() => Cache.invalidateAll(references));
        return {
          resolveEnvironment: Effect.fnUntraced(function* (environment: Environment) {
            const resolved: Record<string, string> = {};
            let bytes = 0;
            for (const [variable, value] of Object.entries(environment)) {
              let text: string;
              if (typeof value === "string") {
                text = value;
              } else {
                switch (value._tag) {
                  case "SecretRef":
                    text = yield* Cache.get(references, value.reference);
                    break;
                  case "BoundText": {
                    const parts: string[] = [];
                    for (const part of value.parts) {
                      if (typeof part === "string") parts.push(part);
                      else {
                        const raw = yield* Cache.get(references, part.reference);
                        switch (part.encoding) {
                          case "raw":
                            parts.push(raw);
                            break;
                          case "uri-component":
                            parts.push(encodeUriComponent(raw));
                            break;
                          default:
                            part.encoding satisfies never;
                        }
                      }
                    }
                    text = parts.join("");
                    yield* redaction.registerValues([text]);
                    break;
                  }
                  default:
                    return value satisfies never;
                }
              }
              bytes += new TextEncoder().encode(text).byteLength;
              if (bytes > OUTPUT_BUDGET) {
                return yield* Effect.fail(
                  new EnvironmentValueResolutionError({
                    message: "Resolved environment exceeds the output byte budget.",
                    variable,
                    reason: "budget-exceeded",
                    remediation: "Reduce the environment values supplied to this operation.",
                  }),
                );
              }
              resolved[variable] = text;
            }
            return resolved;
          }),
        };
      }),
    });
  }),
);
