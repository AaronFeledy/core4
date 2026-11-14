import { RedactionService } from "@lando/redaction";
import { ToolingCompileError } from "@lando/sdk/errors";
import { Effect } from "effect";
import { type ToolingDiagnostic, projectToolingDiagnostic } from "./diagnostics.ts";

/** Run after registering supplied inputs and plan secrets, before emitting or retaining the failure. */
export const discloseToolingCompileError = Effect.fnUntraced(function* (
  diagnostic: ToolingDiagnostic,
): Effect.fn.Return<ToolingCompileError, never, RedactionService> {
  const service = yield* RedactionService;
  const redactor = yield* service.forProfile("secrets");
  return new ToolingCompileError(projectToolingDiagnostic(diagnostic, redactor));
});
