import { Schema } from "effect";
import { patternString } from "../../schema/string-forms.ts";

export const runCapture = Schema.Struct({
  name: patternString(/^[A-Za-z_][A-Za-z0-9_-]*$/u).annotate({
    description: "Scenario-local name used in a later capture token.",
  }),
  json: patternString(/^[^.\s]+(?:\.[^.\s]+)*$/u).annotate({
    description: "Dot path to a string inside the command envelope's result.",
  }),
}).annotate({
  description: "Capture a value from JSON for later commands in a scenario with render={false}.",
});
