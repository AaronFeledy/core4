import { Effect } from "effect";
import type { EngineHttpRequest, EngineHttpResponse, ProviderErrorContext } from "./engine-api.ts";
import { buildContainerRemoveRequest } from "./engine-api.ts";
import { apiResponseFailure, missingApi } from "./engine-errors.ts";

export const removeRuntimeContainer = Effect.fn("ContainerRemoval.remove")(function* <E>(
  api: { readonly request?: (input: EngineHttpRequest) => Effect.Effect<EngineHttpResponse, E> },
  rawReference: string,
  ctx: ProviderErrorContext & { readonly operation: string },
) {
  if (api.request === undefined) return yield* Effect.fail(missingApi(ctx, ctx.operation));
  const response = yield* api.request(buildContainerRemoveRequest(rawReference));
  switch (response.status) {
    case 200:
    case 204:
      return true;
    case 404:
      return false;
    default:
      return yield* Effect.fail(
        apiResponseFailure(ctx, ctx.operation, response, "Container removal failed."),
      );
  }
});

export const containerRemovalArgs = (refs: readonly string[]): readonly string[] => [
  "rm",
  "-f",
  "--volumes",
  ...refs,
];
