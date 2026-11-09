import { FileSyncStopError } from "@lando/sdk/errors";
import { AppId, type AppRef, ProviderId } from "@lando/sdk/schema";
import { RuntimeProviderRegistry } from "@lando/sdk/services";
import { Effect } from "effect";
import { TeardownProvider } from "../providers/app-placement.ts";
import { acceleratedStartStopError } from "./accelerated-start-disposal.ts";
import { openJournal, readPendingAcceleratedStart } from "./accelerated-start-journal.ts";
import { type PendingStart, digest, pendingStartTransitions } from "./accelerated-start-record.ts";
import { acquireFileSyncEngine } from "./file-sync-acquire.ts";

export const prepareMissingRootStartDisposal = Effect.fn("AppOperation.prepareMissingRootStartDisposal")(
  function* (app: AppRef, record: PendingStart, options: { readonly volumes: boolean }) {
    const failure = (message: string) =>
      new FileSyncStopError({
        engineId: record.engineId,
        sessionRef: record.appId,
        message,
        remediation: `Restore access to the recorded provider ${record.providerId} and file-sync engine ${record.engineId}, then retry lando apps:gc --prune --volumes. Keep journal attempt ${record.attemptId} until its file-sync copies are removed.`,
      });
    const recordedApp: AppRef = { kind: "user", id: AppId.make(record.appId), root: app.root };
    const selected = yield* TeardownProvider;
    if (selected !== undefined && selected !== record.providerId)
      return yield* Effect.fail(
        failure("The selected provider differs from the journal's recorded provider."),
      );
    const checked = yield* readPendingAcceleratedStart(recordedApp).pipe(
      Effect.mapError((cause) => acceleratedStartStopError(recordedApp, cause)),
    );
    if (checked === null || digest(checked) !== digest(record) || record.appRoot !== app.root)
      return yield* Effect.fail(failure("The missing-root journal identity changed."));
    const registry = yield* RuntimeProviderRegistry;
    const provider = yield* registry.select(ProviderId.make(record.providerId));
    if (provider.id !== record.providerId)
      return yield* Effect.fail(failure("The recorded provider does not match."));
    const engine = yield* acquireFileSyncEngine(record.engineId).pipe(
      Effect.mapError((cause) => acceleratedStartStopError(recordedApp, cause)),
    );
    if (engine.id !== record.engineId || !(yield* engine.isAvailable))
      return yield* Effect.fail(failure("The recorded file-sync engine is unavailable."));
    const sessions = yield* engine.listSessions({ app: recordedApp });
    for (const session of sessions) {
      if (
        session.app.kind !== "user" ||
        session.app.id !== recordedApp.id ||
        session.app.root !== app.root ||
        !record.sessions.some(
          (entry) =>
            entry.name === `${session.service}/${session.mountKey}` &&
            entry.specDigest === digest(session.spec),
        )
      )
        return yield* Effect.fail(
          failure("An engine-listed session does not match the recorded app and session identity."),
        );
    }
    const volumes = options.volumes ? yield* provider.listVolumes({ app: AppId.make(record.appId) }) : [];
    const targets = (options.volumes ? record.targets : []).map((target) => ({
      target,
      volume: volumes.find((volume) => volume.identity?.nativeName === target.volumeName),
    }));
    for (const { target, volume } of targets) {
      if (volume === undefined) {
        const located = yield* provider.locateVolume({
          app: AppId.make(record.appId),
          store: target.volumeName,
        });
        if (located.nativeName === target.volumeName && located.presence === "absent") continue;
        return yield* Effect.fail(
          failure(`The absence of file-sync target ${target.volumeName} cannot be verified.`),
        );
      }
      if (
        volume.identity?.ownerRoot !== app.root ||
        volume.ref.app !== recordedApp.id ||
        volume.labels?.["dev.lando.provider"] !== record.providerId ||
        volume.labels?.["dev.lando.sync.service"] !== target.service ||
        volume.labels?.["dev.lando.sync.mount-key"] !== target.mountKey
      )
        return yield* Effect.fail(
          failure(`The ownership labels of file-sync target ${target.volumeName} cannot be verified.`),
        );
    }
    const bucket = yield* openJournal(recordedApp).pipe(
      Effect.mapError((cause) => acceleratedStartStopError(recordedApp, cause)),
    );
    return {
      app: recordedApp,
      terminate: Effect.forEach(sessions, (session) => engine.terminateSession(session.ref), {
        discard: true,
      }),
      // Owned and orphan cleanup run first and may already have deleted a listed target, so
      // re-observe it and skip only explicit absence; removeVolume still pins the generation.
      removeTargets: options.volumes
        ? Effect.forEach(
            targets,
            ({ target, volume }) => {
              const identity = volume?.identity;
              if (volume === undefined || identity === undefined) return Effect.void;
              return provider
                .locateVolume({ app: AppId.make(record.appId), store: target.volumeName })
                .pipe(
                  Effect.flatMap((located) =>
                    located.nativeName === target.volumeName && located.presence === "absent"
                      ? Effect.void
                      : provider.removeVolume(volume.ref, identity.generation),
                  ),
                );
            },
            { discard: true },
          )
        : Effect.void,
      complete:
        !options.volumes && record.targets.length > 0
          ? Effect.void
          : bucket
              .transition({
                transitions: pendingStartTransitions,
                operation: "abandon",
                state: (current) =>
                  current === null
                    ? "absent"
                    : digest(current) === digest(record)
                      ? current.phase
                      : "foreign",
                next: () => null,
                illegal: () => failure("The journal changed during missing-root teardown."),
              })
              .pipe(
                Effect.asVoid,
                Effect.mapError(() => failure("Unable to settle the missing-root journal.")),
              ),
    };
  },
);
