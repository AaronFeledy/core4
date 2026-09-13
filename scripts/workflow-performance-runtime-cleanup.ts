import { makeLandoPaths } from "@lando/paths";
import { teardownRuntimeService } from "@lando/provider-lando";
import { Effect } from "effect";

const root = process.env.LANDO_USER_DATA_ROOT;
if (root === undefined || process.platform !== "linux") process.exitCode = 1;
else
  await Effect.runPromise(
    Effect.scoped(teardownRuntimeService({ paths: makeLandoPaths({ userDataRoot: root }) })).pipe(
      Effect.timeout("30 seconds"),
    ),
  );
