import type { ProviderInternalError, ProviderUnavailableError } from "@lando/sdk/errors";
import { Stream } from "effect";
import type { EngineHttpRequest } from "../../src/engine-api.ts";
import { engineApiFailure } from "../../src/engine-errors.ts";
import { ContainerTransportError, runtimeRemediation } from "../../src/transport-error.ts";

/**
 * A stream request naming a container the engine does not have, failing exactly as the socket
 * transport reports Docker's and Podman's HTTP 404 answer.
 */
export const missingContainerStream = (
  providerId: string,
  request: EngineHttpRequest,
  container: string,
): Stream.Stream<never, ProviderUnavailableError | ProviderInternalError> =>
  Stream.fail(
    engineApiFailure(
      { providerId, remediation: runtimeRemediation, env: {} },
      "engine-api",
      request,
      new ContainerTransportError({
        kind: "http",
        operation: "engine-api",
        message: "Container runtime stream request failed with HTTP 404.",
        details: {
          method: request.method,
          path: request.path,
          status: 404,
          body: JSON.stringify({ message: `No such container: ${container}` }),
        },
      }),
    ),
  );
