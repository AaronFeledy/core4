import { exactSecretReference } from "@lando/landofile/secret-reference";
import { RedactionService } from "@lando/redaction/service";
import { SecretReferenceInvalidError } from "@lando/sdk/errors";
import type { AppPlan } from "@lando/sdk/schema";
import { HOST_PROXY_CREDENTIAL_ENV_NAMES } from "@lando/sdk/secrets";
import { type AppSelector, PathsService, type RuntimeProviderShape } from "@lando/sdk/services";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { Effect, Option, Redacted } from "effect";
import { collectAppPlanRedactionTokens } from "../services/app-plan-redaction.ts";
import { isOwnerOnlyRecordFile } from "../subsystems/detached-worker/state-file.ts";
import { serviceHasHostProxyFeature } from "../subsystems/host-proxy/worker-service-plan.ts";
import { readWorkerRecordAt, workerStatePath } from "../subsystems/host-proxy/worker-state-file.ts";
import { sshAgentSessionPaths } from "../subsystems/ssh-agent/session.ts";
import { readAgentRelayWorkerRecord } from "../subsystems/ssh-agent/worker-state.ts";

export const appOutputEnvironmentNames = (
  plans: ReadonlyArray<AppPlan>,
): Readonly<Record<string, ReadonlyArray<string>>> => {
  const names = new Map<string, Set<string>>();
  for (const plan of plans) {
    for (const service of Object.values(plan.services)) {
      const keys = names.get(service.name) ?? new Set<string>();
      for (const [key, value] of Object.entries(service.environment)) {
        if (typeof value !== "string") {
          keys.add(key);
          continue;
        }
        const reference = exactSecretReference(value);
        if (reference !== undefined && !(reference instanceof SecretReferenceInvalidError)) keys.add(key);
      }
      if (serviceHasHostProxyFeature(service)) {
        for (const key of HOST_PROXY_CREDENTIAL_ENV_NAMES) keys.add(key);
      }
      names.set(service.name, keys);
    }
  }
  return Object.fromEntries([...names].map(([service, keys]) => [service, [...keys]]));
};

export const registerProviderOutput = Effect.fnUntraced(function* (input: {
  readonly target: AppSelector;
  readonly provider: RuntimeProviderShape;
  readonly appliedPlans: ReadonlyArray<AppPlan>;
}) {
  const { target, provider } = input;
  const redaction = yield* RedactionService;
  const register = redaction.registerValues;
  const plans = [
    ...(target.plan === undefined ? [] : [target.plan]),
    ...input.appliedPlans.filter((plan) => plan.id === target.app),
  ];
  for (const plan of plans) yield* register(collectAppPlanRedactionTokens(plan));
  const paths = yield* Effect.serviceOption(PathsService);
  const access = yield* Effect.serviceOption(PrivateFileAccessService);
  if (Option.isSome(paths) && Option.isSome(access)) {
    const roots = paths.value.roots;
    const privateFileAccess = access.value;
    for (const root of new Set(plans.map((plan) => plan.root))) {
      const app = { id: target.app, root };
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
  }
  const secrets = yield* provider.readAppEnvironment({ app: target.app }, appOutputEnvironmentNames(plans));
  yield* register(secrets.map((value) => Redacted.value(value)));
});
