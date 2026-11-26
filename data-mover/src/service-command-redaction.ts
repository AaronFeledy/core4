import {
  RedactionService,
  collectSecretEnvValues,
  collectUrlCredentialValues,
} from "@lando/redaction/service";
import type { DataEndpoint } from "@lando/sdk/schema";
import { type ExecChunk, StreamFrameSink } from "@lando/sdk/services";
import { Effect, Option, Stream } from "effect";
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

/**
 * A service command's stderr is its user-visible diagnostic output: it streams to the
 * invocation's live sink when one is present. Stdout is the transfer payload.
 */
const liveServiceCommand = (endpoint: ServiceCommand) =>
  Effect.map(Effect.serviceOption(StreamFrameSink), (sink) =>
    Option.match(sink, {
      onNone: () => undefined,
      onSome: (live) => ({ sink: live, service: endpoint.service }),
    }),
  );

export const serviceCommandStdout = <E, R>(
  source: Stream.Stream<ExecChunk, E, R>,
  endpoint: ServiceCommand,
) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const tokens = yield* registerCommandRedaction(endpoint);
      return execStdoutStream(
        source,
        (exitCode, stderrTail, evidence) =>
          serviceCommandFailure("execStream", exitCode, stderrTail, evidence),
        tokens,
        yield* liveServiceCommand(endpoint),
      );
    }),
  ).pipe(Stream.provide(RedactionService.layer));

export const checkedServiceCommand = Effect.fnUntraced(function* <E, R>(
  source: Stream.Stream<ExecChunk, E, R>,
  endpoint: ServiceCommand,
) {
  const tokens = yield* registerCommandRedaction(endpoint);
  return yield* checkedTransferCommand(source, "exec", tokens, yield* liveServiceCommand(endpoint));
}, Effect.provide(RedactionService.layer));
