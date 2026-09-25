import { homedir } from "node:os";
import { type SshAgentTransportError, SshAgentUnavailableError } from "@lando/sdk/errors";
import { MessageWarnEvent } from "@lando/sdk/events";
import {
  type AppId,
  type AppPlan,
  type AppRef,
  type HostPlatform,
  type ProviderCapabilities,
  SSH_AGENT_SOCKET_NAME,
} from "@lando/sdk/schema";
import { EventService, FileSystem, PathsService, ProcessRunner, SshService } from "@lando/sdk/services";
import { makeTaskTree, runWithTaskTree } from "@lando/sdk/task-progress";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { DateTime, Effect, Option, Ref, Scope } from "effect";
import { probeSshAgent } from "../subsystems/ssh-agent/agent-probe.ts";
import { startDetachedAgentRelayWorker } from "../subsystems/ssh-agent/detached-worker.ts";
import {
  type HostAgentDiscoveryOptions,
  discoverHostSshAgent,
} from "../subsystems/ssh-agent/host-agent-discovery.ts";
import {
  sshAgentEligibleServices,
  stripSshAgentOverlay,
  withSshAgentOverlay,
} from "../subsystems/ssh-agent/overlay.ts";
import type { AgentRelayUpstream } from "../subsystems/ssh-agent/relay.ts";
import type { AgentRelaySession } from "../subsystems/ssh-agent/session.ts";
import type { SshAgentIntent } from "../subsystems/ssh/intent.ts";
import { startSshAgentTreeId } from "./start-progress.ts";

type Capabilities = Pick<ProviderCapabilities, "agentSocket">;
type AgentError = SshAgentUnavailableError | SshAgentTransportError;
type DiscoveryOptions = Partial<Pick<HostAgentDiscoveryOptions, "env" | "home" | "exists" | "runGpgconf">>;
type SessionOptions = DiscoveryOptions & { readonly platform?: HostPlatform };

export const validateAgentSocketCapability = (capabilities: Capabilities, intent: SshAgentIntent) =>
  capabilities.agentSocket === undefined
    ? Effect.fail(
        new SshAgentUnavailableError({
          message: "The provider cannot forward an SSH agent.",
          mode: intent.mode,
          reason: "capability-missing",
          remediation:
            "Select a provider that advertises agentSocket delivery, or use best-effort sidecar mode.",
        }),
      )
    : Effect.succeed(capabilities.agentSocket.delivery);

export const resolveSshAgentUpstream = (
  input: SessionOptions & {
    readonly appId: AppId;
    readonly intent: SshAgentIntent;
  },
): Effect.Effect<AgentRelayUpstream, SshAgentUnavailableError> =>
  Effect.gen(function* () {
    const unavailable = (reason: "sidecar-not-running" | "socket-missing") =>
      new SshAgentUnavailableError({
        message: "The selected SSH agent is unavailable.",
        mode: input.intent.mode,
        reason,
        remediation:
          input.intent.mode === "sidecar"
            ? "Run `lando setup` to install and start the SSH agent sidecar, then restart this app."
            : "Start your host SSH agent and set sshAgent.socket or SSH_AUTH_SOCK to its socket path.",
      });
    const upstream: AgentRelayUpstream = yield* Effect.gen(function* () {
      switch (input.intent.mode) {
        case "sidecar": {
          const ssh = yield* Effect.serviceOption(SshService);
          if (Option.isNone(ssh)) return yield* Effect.fail(unavailable("sidecar-not-running"));
          const socket = yield* ssh.value
            .getAgentSocket(input.appId)
            .pipe(Effect.mapError(() => unavailable("sidecar-not-running")));
          return { _tag: "unix" as const, path: socket.socketPath };
        }
        case "host": {
          const fs = yield* Effect.serviceOption(FileSystem);
          const runner = yield* Effect.serviceOption(ProcessRunner);
          return yield* discoverHostSshAgent({
            platform: input.platform ?? process.platform,
            env: input.env ?? process.env,
            home: input.home ?? homedir(),
            ...(input.intent.socket === undefined ? {} : { explicitSocket: input.intent.socket }),
            exists:
              input.exists ??
              ((path) =>
                Option.isSome(fs) ? Effect.runPromise(fs.value.exists(path)) : Promise.resolve(false)),
            runGpgconf:
              input.runGpgconf ??
              (() =>
                Option.isSome(runner)
                  ? Effect.runPromise(
                      runner.value
                        .run({ cmd: "gpgconf", args: ["--list-dirs", "agent-ssh-socket"], timeoutMs: 5_000 })
                        .pipe(
                          Effect.map((result) => (result.exitCode === 0 ? result.stdout.trim() : undefined)),
                          Effect.catchAll(() => Effect.succeed(undefined)),
                        ),
                    )
                  : Promise.resolve(undefined)),
          });
        }
        default:
          return input.intent.mode satisfies never;
      }
    });
    yield* Effect.tryPromise({
      try: () => probeSshAgent(upstream, { timeoutMs: 2_000 }),
      catch: () => unavailable(input.intent.mode === "sidecar" ? "sidecar-not-running" : "socket-missing"),
    });
    return upstream;
  });

export const startSshAgentSession = (
  plan: AppPlan,
  app: AppRef,
  capabilities: Capabilities,
  intent: SshAgentIntent,
  options: SessionOptions = {},
) =>
  Effect.gen(function* () {
    if (app.kind === "global" || plan.id === "global" || sshAgentEligibleServices(plan).length === 0)
      return undefined;
    const delivery = yield* validateAgentSocketCapability(capabilities, intent);
    const paths = yield* PathsService;
    const upstream = yield* resolveSshAgentUpstream({
      ...options,
      appId: plan.id,
      intent,
      platform: options.platform ?? paths.platform,
    });
    const privateFileAccess = yield* PrivateFileAccessService;
    const events = yield* EventService;
    const acquired = yield* Ref.make<AgentRelaySession | undefined>(undefined);
    return yield* runWithTaskTree(
      makeTaskTree(events, {
        parentId: startSshAgentTreeId(String(plan.id)),
        label: `SSH agent ${plan.name}`,
        children: [{ id: "session", label: "Start SSH agent session" }],
        prefixChildIds: true,
      }),
      (tree) =>
        Effect.gen(function* () {
          yield* tree.startTask("session");
          const session = yield* startDetachedAgentRelayWorker({
            app,
            plan,
            upstream,
            delivery,
            kind: "ssh",
            socketName: SSH_AGENT_SOCKET_NAME,
            paths: { ...paths.roots, platform: options.platform ?? paths.platform },
            privateFileAccess,
          });
          yield* Ref.set(acquired, session);
          yield* tree.completeTask("session");
          return session;
        }),
      { success: "SSH agent ready", failure: "SSH agent unavailable", interrupt: "SSH agent interrupted" },
    ).pipe(
      Effect.onError(() =>
        Ref.get(acquired).pipe(
          Effect.flatMap((session) =>
            session === undefined ? Effect.void : Effect.promise(() => session.close()),
          ),
        ),
      ),
    );
  });

export const withStartedSshAgent = <A, E, R>(
  plan: AppPlan,
  app: AppRef,
  capabilities: Capabilities,
  intent: SshAgentIntent,
  options: SessionOptions & {
    readonly managed?: { readonly scope: Scope.Scope };
    readonly use: (plan: AppPlan) => Effect.Effect<A, E, R>;
    readonly startSession?: () => Effect.Effect<AgentRelaySession | undefined, AgentError>;
  },
) =>
  Effect.gen(function* () {
    if (app.kind === "global" || plan.id === "global" || sshAgentEligibleServices(plan).length === 0)
      return yield* options.use(plan);
    const keep = yield* Ref.make(false);
    const acquire = (
      options.startSession?.() ?? startSshAgentSession(plan, app, capabilities, intent, options)
    ).pipe(
      Effect.catchAll((error) => {
        switch (intent.mode) {
          case "host":
            return Effect.fail(error);
          case "sidecar":
            return Effect.gen(function* () {
              const events = yield* EventService;
              yield* events
                .publish(
                  MessageWarnEvent.make({
                    body: `SSH agent forwarding is unavailable (${error._tag}: ${error._tag === "SshAgentUnavailableError" ? error.reason : error.stage}); starting without it. ${error.remediation}`,
                    timestamp: DateTime.unsafeMake(new Date().toISOString()),
                  }),
                )
                .pipe(Effect.catchAll(() => Effect.void));
              return undefined;
            });
          default:
            return intent.mode satisfies never;
        }
      }),
    );
    return yield* Effect.acquireUseRelease(
      acquire,
      (session) =>
        options
          .use(session === undefined ? stripSshAgentOverlay(plan) : withSshAgentOverlay(plan, session))
          .pipe(
            Effect.tap(() =>
              Effect.gen(function* () {
                if (session !== undefined && options.managed !== undefined) {
                  yield* Effect.addFinalizer(() => Effect.promise(() => session.close())).pipe(
                    Effect.provideService(Scope.Scope, options.managed.scope),
                  );
                }
                yield* Ref.set(keep, true);
              }),
            ),
          ),
      (session) =>
        Ref.get(keep).pipe(
          Effect.flatMap((retained) =>
            retained || session === undefined ? Effect.void : Effect.promise(() => session.close()),
          ),
        ),
    );
  });
