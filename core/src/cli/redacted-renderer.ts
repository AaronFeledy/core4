import {
  type RedactionForProfileOptions,
  RedactionService,
  createPayloadValues,
  createStandaloneRedactor,
} from "@lando/redaction/service";
import { createPayloadRedactor } from "@lando/sdk/secrets";
import { Renderer } from "@lando/sdk/services";
import { Effect } from "effect";

export const withRedactedRenderer = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  options: RedactionForProfileOptions = {},
) =>
  Effect.gen(function* () {
    const renderer = yield* Renderer;
    const service = yield* Effect.serviceOption(RedactionService);
    const scoped = { sourceEnv: process.env, ...options };
    const redactor =
      service._tag === "Some"
        ? yield* service.value.forProfile("secrets", scoped)
        : createStandaloneRedactor("secrets", scoped);
    const values =
      service._tag === "Some" ? yield* service.value.payloadValues(scoped) : createPayloadValues([], scoped);
    const channel = (write: typeof renderer.output.stdout) => {
      const payload = createPayloadRedactor(values);
      const flush = Effect.suspend(() => {
        const tail = payload.flush();
        return tail.length === 0 ? Effect.void : write(tail);
      });
      return {
        flush,
        write: (chunk: string | Uint8Array) =>
          Effect.suspend(() => {
            if (typeof chunk === "string") {
              return flush.pipe(Effect.andThen(write(redactor.redactString(chunk))));
            }
            const bytes = payload.write(chunk);
            return bytes.length === 0 ? Effect.void : write(bytes);
          }),
      };
    };
    const stdout = channel(renderer.output.stdout);
    const stderr = channel(renderer.output.stderr);
    return yield* effect.pipe(
      Effect.provideService(Renderer, {
        ...renderer,
        message: {
          info: (body) => renderer.message.info(redactor.redactString(body)),
          warn: (body) => renderer.message.warn(redactor.redactString(body)),
          error: (body, remediation) =>
            renderer.message.error(
              redactor.redactString(body),
              remediation === undefined ? undefined : redactor.redactString(remediation),
            ),
        },
        output: { stdout: stdout.write, stderr: stderr.write },
      }),
      Effect.ensuring(stdout.flush.pipe(Effect.andThen(stderr.flush))),
    );
  });
