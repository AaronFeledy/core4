import { Effect } from "effect";
import { CommandWarnings, makeCommandWarnings } from "../landofile/command-warnings.ts";

export const collectDocumentDiagnostics = Effect.fnUntraced(function* <A, E, R>(
  evaluate: Effect.Effect<A, E, R>,
) {
  const collector = makeCommandWarnings(true);
  const value = yield* evaluate.pipe(Effect.provideService(CommandWarnings, collector));
  return { value, warnings: yield* collector.list };
});
