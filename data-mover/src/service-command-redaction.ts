import {
  RedactionService,
  collectSecretEnvValues,
  collectUrlCredentialValues,
} from "@lando/redaction/service";
import type { DataEndpoint } from "@lando/sdk/schema";
import type { ExecChunk } from "@lando/sdk/services";
import { Effect, Stream } from "effect";
import { checkedTransferCommand, serviceCommandFailure } from "./command-failure.ts";
import { execStdoutStream } from "./exec-stream.ts";

type ServiceCommand = Extract<DataEndpoint, { readonly _tag: "serviceCmd" }>;

const registerCommandRedaction = Effect.fnUntraced(function* (endpoint: ServiceCommand) {
  const tiers = endpoint.secrets ?? { substring: collectSecretEnvValues(endpoint.env), wholeToken: [] };
  const redaction = yield* RedactionService;
  yield* redaction.registerValues(tiers.substring);
  yield* redaction.registerValues(tiers.wholeToken, { match: "whole-token" });
  return [...tiers.substring, ...collectUrlCredentialValues(tiers.substring)];
});

export const serviceCommandStdout = <E, R>(
  source: Stream.Stream<ExecChunk, E, R>,
  endpoint: ServiceCommand,
) =>
  Stream.unwrap(
    registerCommandRedaction(endpoint).pipe(
      Effect.map((tokens) =>
        execStdoutStream(
          source,
          (exitCode, stderrTail, evidence) =>
            serviceCommandFailure("execStream", exitCode, stderrTail, evidence),
          tokens,
        ),
      ),
    ),
  ).pipe(Stream.provide(RedactionService.layer));

export const checkedServiceCommand = <E, R>(
  source: Stream.Stream<ExecChunk, E, R>,
  endpoint: ServiceCommand,
) =>
  registerCommandRedaction(endpoint).pipe(
    Effect.flatMap((tokens) => checkedTransferCommand(source, "exec", tokens)),
    Effect.provide(RedactionService.layer),
  );
