import { RedactionService } from "@lando/redaction/service";
import { Effect } from "effect";

export const helpRedactor = Effect.gen(function* () {
  const service = yield* RedactionService;
  return yield* service.forProfile("secrets", { sourceEnv: process.env });
}).pipe(Effect.provide(RedactionService.layer));

export const redactHelpText = (text: string): Promise<string> =>
  Effect.runPromise(Effect.map(helpRedactor, (redactor) => redactor.redactString(text)));
