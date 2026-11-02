import { expect, test } from "bun:test";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { transportMessage } from "../../../src/subsystems/scanner/scan-target.ts";

const BUN_RESET =
  "The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()";

const transportFailure = (cause: unknown) =>
  new HttpClientError.HttpClientError({
    reason: new HttpClientError.TransportError({
      request: HttpClientRequest.get("http://localhost:4400/"),
      cause,
      description: "transport failed",
    }),
  });

test.each([new Error(BUN_RESET), BUN_RESET])("drops Bun's fetch developer hint from %p", (cause) => {
  // Given a Bun fetch transport failure / When it becomes scan detail / Then only the user-facing reason remains.
  expect(transportMessage(transportFailure(cause))).toBe("The socket connection was closed unexpectedly.");
});

test("keeps other transport messages unchanged", () => {
  expect(transportMessage(transportFailure(new Error("connect ECONNREFUSED 127.0.0.1:4400")))).toBe(
    "connect ECONNREFUSED 127.0.0.1:4400",
  );
});
