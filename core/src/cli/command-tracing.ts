import * as EnvSecretStore from "@lando/engine/services/secret-store";
import { CORE_VERSION } from "@lando/engine/version";
import * as LandoHttpClient from "@lando/http-client";
import { RedactionService, collectSecretEnvValues } from "@lando/redaction/service";
import { Effect, Layer, type Tracer } from "effect";
import * as OtlpExporter from "effect/observability/OtlpExporter";
import * as OtlpSerialization from "effect/observability/OtlpSerialization";
import * as OtlpTracer from "effect/observability/OtlpTracer";
import { type CommandTraceCapture, makeCommandTracer } from "./command-tracer";
import type { TraceSelection } from "./trace-selection";

export const withCommandTracing = async (
  selection: TraceSelection,
  run: (capture: CommandTraceCapture, redactionTokens: ReadonlyArray<string>) => Promise<void>,
  flags: Readonly<Record<string, unknown>> = {},
): Promise<void> => {
  const secrets = [
    ...Object.values(selection.headers),
    ...collectSecretEnvValues(
      Object.fromEntries(
        Object.entries(flags).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
      ),
    ),
  ];
  const execute = Effect.fnUntraced(function* (delegate?: Tracer.Tracer) {
    const redaction = yield* RedactionService;
    const redactor = yield* redaction.forProfile("secrets", {
      sourceEnv: selection.env,
      redactionTokens: secrets,
    });
    const capture = makeCommandTracer({ redactor, ...(delegate === undefined ? {} : { delegate }) });
    yield* Effect.tryPromise({ try: () => run(capture, secrets), catch: (cause) => cause });
    yield* capture.exportSpans;
  });
  const program =
    selection.endpoint === undefined
      ? execute()
      : Effect.gen(function* () {
          const delegate = yield* OtlpTracer.make({
            url: `${selection.endpoint?.replace(/\/+$/u, "")}/v1/traces`,
            headers: selection.headers,
            exportInterval: "1 day",
            maxBatchSize: Number.MAX_SAFE_INTEGER,
            shutdownTimeout: "1 millis",
            resource: {
              serviceName: "lando",
              serviceVersion: CORE_VERSION,
              attributes: { "os.type": process.platform, "host.arch": process.arch },
            },
          });
          yield* execute(delegate);
          const flusher = yield* OtlpExporter.Flusher;
          yield* flusher.flush.pipe(
            Effect.interruptible,
            Effect.timeout("1 second"),
            Effect.catchCause(() => Effect.void),
          );
        }).pipe(
          Effect.provide(
            Layer.mergeAll(LandoHttpClient.layer, OtlpSerialization.layerJson, OtlpExporter.layerFlusher),
          ),
        );
  const redactionLayer = RedactionService.layer.pipe(Layer.provide(EnvSecretStore.layer));
  await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(redactionLayer)));
};
