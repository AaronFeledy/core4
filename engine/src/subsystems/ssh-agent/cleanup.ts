import type { RootOverrides } from "@lando/paths";
import type { AgentSocketKind, AppRef } from "@lando/sdk/schema";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { Effect } from "effect";
import { terminateOwnedAgentRelayWorker } from "./worker-state.ts";

export const cleanupAgentRelayState = (
  app: Pick<AppRef, "id" | "root">,
  paths: RootOverrides | undefined,
  kind: AgentSocketKind,
) =>
  Effect.gen(function* () {
    const privateFileAccess = yield* PrivateFileAccessService;
    yield* terminateOwnedAgentRelayWorker(app, {
      kind,
      privateFileAccess,
      ...(paths === undefined ? {} : { paths }),
    });
  }).pipe(Effect.catchAll(() => Effect.void));
