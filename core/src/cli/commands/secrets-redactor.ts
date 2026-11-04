import {
  type RedactionForProfileOptions,
  RedactionService,
  createStandaloneRedactor,
} from "@lando/redaction/service";
import { Effect, Option } from "effect";

export const resolveSecretsRedactor = Effect.fnUntraced(function* (
  options: RedactionForProfileOptions & { readonly sourceEnv: Readonly<Record<string, string | undefined>> },
) {
  const service = yield* Effect.serviceOption(RedactionService);
  const redactor = Option.isSome(service)
    ? yield* service.value.forProfile("secrets", options)
    : createStandaloneRedactor("secrets", options);
  return { redactor, redact: (value: string) => redactor.redactString(value) };
});
