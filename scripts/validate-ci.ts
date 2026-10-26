import * as Schema from "effect/Schema";
import { PROFILES, resultFailures } from "./ci-selection.ts";

if (import.meta.main) {
  const env = Schema.decodeUnknownSync(
    Schema.Struct({
      CI_PROFILE: Schema.Literals(PROFILES),
      CI_BROAD: Schema.Literals(["true", "false"]),
      CI_NEEDS: Schema.String,
    }),
  )(process.env);
  const needs = Schema.decodeUnknownSync(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        result: Schema.Literals(["success", "skipped", "failure", "cancelled"]),
      }),
    ),
  )(JSON.parse(env.CI_NEEDS));
  const failures = resultFailures(
    { profile: env.CI_PROFILE, broad: env.CI_BROAD === "true", reason: "gate" },
    needs,
  );
  for (const failure of failures) console.error(failure);
  process.exitCode = failures.length > 0 ? 1 : 0;
}
