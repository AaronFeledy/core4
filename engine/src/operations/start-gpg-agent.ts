import { join } from "node:path";
import {
  GpgAgentTransportError,
  GpgAgentUnavailableError,
  type SshAgentTransportError,
} from "@lando/sdk/errors";
import {
  type AppPlan,
  type AppRef,
  GPG_AGENT_SOCKET_NAME,
  type ProviderCapabilities,
} from "@lando/sdk/schema";
import { PathsService, ProcessRunner, type RuntimeProviderShape } from "@lando/sdk/services";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { Effect, Option, Ref, Scope } from "effect";
import { type GpgAgentDiscoveryOptions, discoverHostGpgAgent } from "../subsystems/gpg-agent/discovery.ts";
import type { GpgAgentIntent } from "../subsystems/gpg-agent/intent.ts";
import { exportPublicKeyring } from "../subsystems/gpg-agent/keyring.ts";
import { gpgAgentEligibleServices, withGpgAgentOverlay } from "../subsystems/gpg-agent/overlay.ts";
import {
  type DetachedAgentRelayWorkerOptions,
  startDetachedAgentRelayWorker,
} from "../subsystems/ssh-agent/detached-worker.ts";
import type { AgentRelaySession } from "../subsystems/ssh-agent/session.ts";

type Capabilities = Pick<ProviderCapabilities, "agentSocket">;
type AgentError = GpgAgentUnavailableError | GpgAgentTransportError;

const gpgTransportError = (cause: SshAgentTransportError) =>
  new GpgAgentTransportError({
    message: cause.message,
    stage: cause.stage,
    remediation: cause.remediation,
    cause,
  });

interface GpgAgentSession {
  readonly session: AgentRelaySession;
  readonly keyringDir: string;
}

export interface GpgAgentSessionOptions {
  readonly spawnWorker?: DetachedAgentRelayWorkerOptions["spawnWorker"];
  readonly discovery?: Pick<GpgAgentDiscoveryOptions, "inspectPath" | "probeRestricted">;
}

const missingGnuPg = () =>
  new GpgAgentUnavailableError({
    message: "GnuPG is not available to forward the agent.",
    reason: "gpg-missing",
    remediation:
      "Install GnuPG, run `gpgconf --launch gpg-agent`, and set gpgAgent.socket to the restricted extra socket if needed.",
  });

export const validateGpgAgentSocketCapability = (capabilities: Capabilities) =>
  capabilities.agentSocket === undefined
    ? Effect.fail(
        new GpgAgentUnavailableError({
          message: "The provider cannot forward a GPG agent.",
          reason: "capability-missing",
          remediation: "Select a provider that advertises agentSocket delivery, or disable gpgAgent.forward.",
        }),
      )
    : Effect.succeed(capabilities.agentSocket.delivery);

export const startGpgAgentSession = (
  plan: AppPlan,
  app: AppRef,
  capabilities: Capabilities,
  intent: GpgAgentIntent,
  options: GpgAgentSessionOptions = {},
) =>
  Effect.gen(function* () {
    const delivery = yield* validateGpgAgentSocketCapability(capabilities);
    const paths = yield* PathsService;
    const runnerOption = yield* Effect.serviceOption(ProcessRunner);
    if (Option.isNone(runnerOption)) return yield* Effect.fail(missingGnuPg());
    const runner = runnerOption.value;
    const upstream = yield* discoverHostGpgAgent({
      runner,
      ...(intent.socket === undefined ? {} : { explicitSocket: intent.socket }),
      launch: true,
      ...options.discovery,
    });
    const privateFileAccess = yield* PrivateFileAccessService;
    const session = yield* startDetachedAgentRelayWorker({
      app,
      plan,
      upstream: { _tag: "unix", path: upstream.path },
      delivery,
      kind: "gpg",
      socketName: GPG_AGENT_SOCKET_NAME,
      paths: { ...paths.roots, platform: paths.platform },
      privateFileAccess,
      ...(options.spawnWorker === undefined ? {} : { spawnWorker: options.spawnWorker }),
    }).pipe(Effect.mapError(gpgTransportError));
    // Starting the worker resets its state directory, so the keyring is published only once the worker owns it.
    const keyringDir = join(paths.agentRelayRunDir("gpg", plan.id, plan.root), "keyring");
    yield* exportPublicKeyring({ runner, destDir: keyringDir }).pipe(
      Effect.onError(() => Effect.promise(() => session.close())),
    );
    return { session, keyringDir } satisfies GpgAgentSession;
  });

/** Seeds each opted-in service's GNUPGHOME from the mounted public keyring and links the relayed agent socket. */
const prepareGpgHome = (plan: AppPlan, exec: RuntimeProviderShape["exec"]) =>
  Effect.forEach(
    gpgAgentEligibleServices(plan),
    (service) => {
      const failure = () =>
        new GpgAgentTransportError({
          message: `Unable to prepare the GPG home for service ${service.name}.`,
          stage: "worker",
          remediation:
            "Install gpg in the service image, ensure the service user can write GNUPGHOME, and retry start.",
        });
      return exec(
        {
          app: plan.id,
          service: service.name,
          ...(service.user === undefined ? {} : { user: service.user }),
        },
        {
          command: [
            "sh",
            "-c",
            'set -e; command -v gpg >/dev/null 2>&1 || { echo "lando.gpg-agent needs gpg in the service image" >&2; exit 1; }; mkdir -p -m 700 "$GNUPGHOME"; cp "$LANDO_GPG_KEYRING/pubring.gpg" "$GNUPGHOME/pubring.gpg"; gpg --batch --import-ownertrust "$LANDO_GPG_KEYRING/otrust.txt"; ln -sf "$LANDO_GPG_AGENT_SOCKET" "$GNUPGHOME/S.gpg-agent"',
          ],
        },
      ).pipe(
        Effect.mapError(failure),
        Effect.flatMap((result) => (result.exitCode === 0 ? Effect.void : Effect.fail(failure()))),
      );
    },
    { discard: true },
  );

export const withStartedGpgAgent = <A, E, R>(
  plan: AppPlan,
  app: AppRef,
  capabilities: Capabilities,
  intent: GpgAgentIntent,
  options: {
    readonly exec: RuntimeProviderShape["exec"];
    readonly managed?: { readonly scope: Scope.Scope };
    /**
     * `prepareGpgHome` must run right after the provider applies the overlaid plan, inside the
     * caller's apply compensation, so a failed GNUPGHOME seed tears the started app down.
     */
    readonly use: (
      plan: AppPlan,
      prepareGpgHome: Effect.Effect<void, GpgAgentTransportError>,
    ) => Effect.Effect<A, E, R>;
    readonly startSession?: () => Effect.Effect<GpgAgentSession, AgentError>;
  },
): Effect.Effect<A, E | AgentError, R | PathsService | PrivateFileAccessService> =>
  Effect.gen(function* () {
    if (
      app.kind === "global" ||
      plan.id === "global" ||
      intent.forward === false ||
      gpgAgentEligibleServices(plan).length === 0
    ) {
      return yield* options.use(plan, Effect.void);
    }
    const keep = yield* Ref.make(false);
    const acquire = options.startSession?.() ?? startGpgAgentSession(plan, app, capabilities, intent);
    return yield* Effect.acquireUseRelease(
      acquire,
      (agent) =>
        options
          .use(withGpgAgentOverlay(plan, agent.session, agent.keyringDir), prepareGpgHome(plan, options.exec))
          .pipe(
            Effect.tap(() =>
              Effect.gen(function* () {
                if (options.managed !== undefined) {
                  yield* Effect.addFinalizer(() => Effect.promise(() => agent.session.close())).pipe(
                    Effect.provideService(Scope.Scope, options.managed.scope),
                  );
                }
                yield* Ref.set(keep, true);
              }),
            ),
          ),
      (agent) =>
        Ref.get(keep).pipe(
          Effect.flatMap((retained) =>
            retained ? Effect.void : Effect.promise(() => agent.session.close()),
          ),
        ),
    );
  });
