import { ProcessRunner } from "@lando/sdk/services";
import { makeOwnerOnlyFileAccess } from "@lando/state-store/private-file-access";
import { Effect } from "effect";
import { ProcessRunnerLive } from "./process-runner.ts";

export const ownerOnlyFileAccess = makeOwnerOnlyFileAccess({
  processRunner: Effect.runSync(ProcessRunner.pipe(Effect.provide(ProcessRunnerLive))),
});
