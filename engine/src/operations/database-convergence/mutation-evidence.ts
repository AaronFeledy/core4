import type { SqlCredentialApplyError, SqlCredentialMember } from "@lando/sdk/errors";
import { Effect } from "effect";
import type { ClientResult } from "./types.ts";

export const credentialMembers = ["user", "password", "database", "rootPassword"] as const;

export const makeCredentialMutationEvidence = () => {
  let dispatched = false;
  const acknowledged = new Set<SqlCredentialMember>();
  return {
    // Keep the exec cancellable, but record a successful response before cancellation resumes.
    run: (
      exec: Effect.Effect<ClientResult, SqlCredentialApplyError>,
      members: readonly SqlCredentialMember[] = [],
    ) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          dispatched = true;
          const response = yield* restore(exec);
          if (response.exitCode === 0) {
            for (const member of members) acknowledged.add(member);
          }
          return response;
        }),
      ),
    snapshot: (): Pick<SqlCredentialApplyError, "mutation" | "completed"> => ({
      mutation: acknowledged.size > 0 ? "partial" : dispatched ? "possible" : "none",
      completed: credentialMembers.filter((member) => acknowledged.has(member)),
    }),
  };
};

export type CredentialMutationEvidence = ReturnType<typeof makeCredentialMutationEvidence>;
