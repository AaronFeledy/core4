import { Schema } from "effect";
import { type LanguageSource, LanguageSourceSchema, languageSource } from "../language/errors.ts";

export class EventError extends Schema.TaggedError<EventError>()("ActionsEventError", {
  code: Schema.Literals([
    "event-invalid",
    "event-input",
    "event-secret",
    "pattern-unsupported",
    "event-limit",
    "schedule-unsupported",
  ]),
  message: Schema.Literal("The explicit Actions event could not be evaluated."),
  source: LanguageSourceSchema,
  remediation: Schema.String,
}) {}
const remediation: Record<EventError["code"], string> = {
  "event-invalid": "Supply a supported explicit event with valid fields at the indicated source location.",
  "event-input": "Provide declared workflow inputs with the required names, types, and allowed choices.",
  "event-secret": "Explicitly admit the required declared secrets and remove undeclared secret names.",
  "pattern-unsupported":
    "Use bounded literal, * and ** patterns with optional ordered exclusions; remove unsupported syntax and escaping paths.",
  "event-limit": "Reduce event data and filter sizes to fit the finite event evaluation budgets.",
  "schedule-unsupported":
    "Select an explicit configured cron value, or use five-field simulation patterns containing only * or bounded integers.",
};
export const eventError = (code: EventError["code"], source: LanguageSource) =>
  new EventError({
    code,
    message: "The explicit Actions event could not be evaluated.",
    source: languageSource(source),
    remediation: remediation[code],
  });
