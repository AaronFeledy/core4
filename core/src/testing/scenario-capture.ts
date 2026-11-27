import { Effect, Predicate, Result, Schema } from "effect";
import { CAPTURE_ARG } from "../docs/guide-compiler/capture-token.ts";

type Capture = { readonly name: string; readonly json: string };

class ScenarioCaptureError extends Schema.TaggedError<ScenarioCaptureError>()("ScenarioCaptureError", {
  message: Schema.String,
  captureName: Schema.String,
  remediation: Schema.String,
}) {}

const decodeResult = Schema.decodeUnknownResult(
  Schema.fromJsonString(Schema.Struct({ result: Schema.Unknown })),
);

export const makeScenarioCapture = () => {
  const values = new Map<string, string>();
  return {
    record: Effect.fnUntraced(function* ({ name, json }: Capture, stdout: string) {
      const decoded = decodeResult(stdout);
      if (Result.isFailure(decoded))
        return yield* new ScenarioCaptureError({
          captureName: name,
          message: `Cannot capture "${name}": stdout is not a single JSON envelope: ${JSON.stringify(stdout.slice(0, 200))}`,
          remediation: "Capture from a command that prints one JSON envelope with --format=json.",
        });
      const value = json.split(".").reduce<unknown>((parent, key) => {
        return Predicate.hasProperty(parent, key) && Object.hasOwn(parent, key) ? parent[key] : undefined;
      }, decoded.success.result);
      if (typeof value !== "string" || value.includes("\0"))
        return yield* new ScenarioCaptureError({
          captureName: name,
          message: `Cannot capture "${name}": result.${json} is not an argv string.`,
          remediation: "Use a JSON envelope and choose a result field containing a string without NULs.",
        });
      values.set(name, value);
    }),
    argv: Effect.fnUntraced(function* (template: readonly string[], cleanup: boolean) {
      const argv: string[] = [];
      for (const word of template) {
        const name = CAPTURE_ARG.exec(word)?.[1];
        if (name === undefined) {
          argv.push(word);
          continue;
        }
        const value = values.get(name);
        if (value === undefined) {
          if (cleanup) {
            yield* Effect.logWarning(
              `Skipped cleanup command \`${template.join(" ")}\`: capture "${name}" has no value, so anything an earlier step created may remain.`,
            );
            return undefined;
          }
          return yield* new ScenarioCaptureError({
            captureName: name,
            message: `Capture "${name}" has no value.`,
            remediation: "Capture the value in an earlier Run before using it in a command.",
          });
        }
        argv.push(value);
      }
      return argv;
    }),
  };
};
