import {
  type RedactionForProfileOptions,
  RedactionService,
  createStandaloneRedactor,
} from "@lando/redaction/service";
import { Effect, Option } from "effect";

export const resolveSecretsRedactor = (options?: RedactionForProfileOptions) =>
  Effect.gen(function* () {
    const service = yield* Effect.serviceOption(RedactionService);
    const redactor = Option.isSome(service)
      ? yield* service.value.forProfile("secrets", options)
      : createStandaloneRedactor("secrets", options);
    return { redactor, redact: (value: string) => redactor.redactString(value) };
  });
