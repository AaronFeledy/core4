import {
  CRUN_OOM_SCORE_ADJ_ISSUE_URL,
  CRUN_OOM_SCORE_ADJ_REMEDIATION,
  type CrunExecCompatibilityWarning,
  evaluateLibpodCrunExecCompatibility,
} from "@lando/container-runtime/podman/oci-runtime-floor";
import { MessageWarnEvent } from "@lando/sdk/events";
import type {
  PluginDoctorCheckContribution,
  PluginDoctorCheckInput,
  PluginDoctorReport,
} from "@lando/sdk/plugins";
import { EventService } from "@lando/sdk/services";
import { type Context, DateTime, Effect, Option } from "effect";

export const CRUN_ROOTLESS_EXEC_CHECK_ID = "crun-rootless-exec";

export type ReadLibpodInfo = (input: PluginDoctorCheckInput) => Effect.Effect<unknown, unknown>;

export interface CrunExecCompatibilityCheckSeams {
  readonly readInfo: ReadLibpodInfo;
}

type EventPublisher = Pick<Context.Service.Shape<typeof EventService>, "publish">;

const warningReport = (warning: CrunExecCompatibilityWarning): PluginDoctorReport => ({
  name: CRUN_ROOTLESS_EXEC_CHECK_ID,
  status: "warn",
  severity: "warn",
  runtimeStatus: warning.message,
  runtime: { running: true, version: warning.podmanVersion },
  context: {
    providerId: "podman",
    providerKind: "user-installed",
    ociRuntime: warning.runtimeName,
    ociRuntimeVersion: warning.runtimeVersion,
    podmanVersion: warning.podmanVersion,
    issue: CRUN_OOM_SCORE_ADJ_ISSUE_URL,
  },
  solutions: [
    {
      kind: "manual",
      description: CRUN_OOM_SCORE_ADJ_REMEDIATION,
      command: "lando setup",
    },
  ],
});

export const makeCrunRootlessExecCheck = (
  seams: CrunExecCompatibilityCheckSeams,
): PluginDoctorCheckContribution => ({
  id: CRUN_ROOTLESS_EXEC_CHECK_ID,
  run: Effect.fn("CrunRootlessExecCheck.run")(function* (input) {
    if (input.providerId !== "podman") return [];
    const info = yield* seams.readInfo(input).pipe(Effect.catch(() => Effect.succeed(undefined)));
    if (info === undefined) return [];
    const warning = evaluateLibpodCrunExecCompatibility(info);
    return warning === undefined ? [] : [warningReport(warning)];
  }),
});

export const publishCrunExecCompatibilityWarning = Effect.fnUntraced(function* (
  warning: CrunExecCompatibilityWarning | undefined,
  eventService: EventPublisher | undefined,
) {
  if (warning === undefined) return;
  const events = eventService ?? Option.getOrUndefined(yield* Effect.serviceOption(EventService));
  if (events === undefined) return;
  yield* events
    .publish(MessageWarnEvent.make({ body: warning.message, timestamp: yield* DateTime.now }))
    .pipe(Effect.catch(() => Effect.void));
});
