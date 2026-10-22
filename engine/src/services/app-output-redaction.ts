import { RedactionService } from "@lando/redaction/service";
import { AppId, type AppPlan, type AppRef } from "@lando/sdk/schema";
import { AppOutputRedaction, PathsService, type RuntimeProviderShape } from "@lando/sdk/services";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { Effect, Layer, Option, Redacted } from "effect";
import { isOwnerOnlyRecordFile } from "../subsystems/detached-worker/state-file.ts";
import { readWorkerRecordAt, workerStatePath } from "../subsystems/host-proxy/worker-state-file.ts";
import { sshAgentSessionPaths } from "../subsystems/ssh-agent/session.ts";
import { readAgentRelayWorkerRecord } from "../subsystems/ssh-agent/worker-state.ts";
import { collectAppPlanRedactionTokens } from "./app-plan-redaction.ts";

export const registerAppOutputRedaction = Effect.fnUntraced(function* (input: {
  readonly plan: AppPlan;
  readonly provider: RuntimeProviderShape;
  readonly app?: Pick<AppRef, "id" | "root">;
}) {
  const { plan, provider } = input;
  const redaction = yield* Effect.serviceOption(RedactionService);
  const register = (values: ReadonlyArray<string>) =>
    Option.isSome(redaction) ? redaction.value.registerValues(values) : Effect.void;
  yield* register(collectAppPlanRedactionTokens(plan));
  const app = input.app ?? { id: plan.id, root: plan.root };
  const paths = yield* Effect.serviceOption(PathsService);
  const access = yield* Effect.serviceOption(PrivateFileAccessService);
  if (Option.isSome(paths) && Option.isSome(access)) {
    const roots = paths.value.roots;
    const privateFileAccess = access.value;
    const path = workerStatePath(app, roots);
    if (yield* isOwnerOnlyRecordFile(path, privateFileAccess)) {
      const record = yield* readWorkerRecordAt(path);
      if (
        record !== undefined &&
        record.appId === app.id &&
        record.appRoot === app.root &&
        record.providerId === provider.id
      ) {
        yield* register([record.sessionId, record.token, record.controlToken]);
      }
    }
    for (const kind of ["ssh", "gpg"] as const) {
      const path = sshAgentSessionPaths(app, roots, kind).recordPath;
      if (!(yield* isOwnerOnlyRecordFile(path, privateFileAccess))) continue;
      const record = yield* readAgentRelayWorkerRecord(app, { paths: roots, kind, privateFileAccess }).pipe(
        Effect.catchTag("SshAgentTransportError", () => Effect.succeed(undefined)),
      );
      if (
        record !== undefined &&
        record.appId === app.id &&
        record.appRoot === app.root &&
        record.kind === kind
      ) {
        yield* register([record.controlToken]);
      }
    }
  }
  const secrets = yield* provider.readAppSecrets({ app: AppId.make(app.id), plan });
  yield* register(secrets.map((value) => Redacted.value(value)));
});

export const layer = Layer.succeed(AppOutputRedaction, {
  register: (plan, provider) => registerAppOutputRedaction({ plan, provider }),
});
