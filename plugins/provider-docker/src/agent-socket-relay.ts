import { volumeCreationFact, volumeCreationLabels } from "@lando/container-runtime/data-plane";
import { dockerPullDialect } from "@lando/container-runtime/dialect";
import type { EngineApiClient, EngineHttpRequest } from "@lando/container-runtime/engine-api";
import { pullImage } from "@lando/container-runtime/image-pull";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import { runProbe } from "@lando/sdk/probe";
import { type AgentSocketBridgeInput, type AgentSocketBridgeResult, ProviderId } from "@lando/sdk/schema";
import { Duration, Effect, Match, Schema, type Scope } from "effect";

export const AGENT_RELAY_IMAGE =
  "alpine/socat@sha256:24220ef2c80a2a421ea08e4624488e985330c421b6aa3329bae14b0933a1d403";

const failure = (message: string) =>
  new ProviderUnavailableError({
    providerId: "docker",
    operation: "openAgentSocketBridge",
    message,
    remediation:
      "Provide the canonical app root and an authenticated loopback TCP broker; run `lando doctor --provider=docker` and retry.",
  });
const Identifier = Schema.parseJson(Schema.Struct({ Id: Schema.NonEmptyString }));
const ExecStatus = Schema.parseJson(
  Schema.Struct({ Running: Schema.Boolean, ExitCode: Schema.NullOr(Schema.Int) }),
);

export const makeDockerDesktopAgentSocketBridge =
  (options: {
    readonly api: EngineApiClient;
    readonly hostGateway: string;
    readonly relayImage: string;
  }) =>
  (
    input: AgentSocketBridgeInput,
  ): Effect.Effect<AgentSocketBridgeResult, ProviderUnavailableError, Scope.Scope> =>
    Effect.gen(function* () {
      const upstream = yield* Match.value(input.upstream).pipe(
        Match.tag("unix", () =>
          Effect.fail(failure("Docker Desktop requires an authenticated loopback TCP upstream.")),
        ),
        Match.tag("loopback-tcp", (tcp) => Effect.succeed(tcp)),
        Match.exhaustive,
      );
      if (!upstream.token || upstream.token.includes("\0")) {
        return yield* Effect.fail(failure("Docker Desktop requires a broker authentication token."));
      }
      if (
        !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u.test(input.socketName) ||
        !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u.test(input.appId) ||
        !/^[a-zA-Z0-9.-]+$/u.test(options.hostGateway)
      ) {
        return yield* Effect.fail(failure("Invalid agent relay resource name or host gateway."));
      }
      const apiRequest = options.api.request;
      if (apiRequest === undefined)
        return yield* Effect.fail(failure("Docker API requests are unavailable."));
      const request = (req: EngineHttpRequest) =>
        apiRequest(req).pipe(
          Effect.timeoutFail({
            duration: Duration.seconds(15),
            onTimeout: () => failure("Docker agent relay request timed out."),
          }),
          Effect.mapError(() => failure("Docker agent relay API request failed.")),
        );
      const checked = (req: EngineHttpRequest) =>
        request(req).pipe(
          Effect.flatMap((response) =>
            response.status >= 200 && response.status < 300
              ? Effect.succeed(response)
              : Effect.fail(failure("Docker rejected an agent relay request.")),
          ),
        );
      const volume = `lando-agent-${input.kind}-${input.appId}`;
      const labels = {
        ...volumeCreationLabels(
          { id: input.appId, root: input.appRoot, provider: ProviderId.make("docker"), extensions: {} },
          { name: volume, scope: "app", kind: "data" },
        ),
        "dev.lando.agent-session": input.sessionId,
      };
      const socket = `/run/lando/agent/${input.socketName}`;
      yield* Effect.acquireRelease(
        checked({ method: "POST", path: "/volumes/create", body: { Name: volume, Labels: labels } }).pipe(
          Effect.flatMap((response) =>
            volumeCreationFact({ body: response.body, name: volume, labels }).length === 1
              ? Effect.void
              : Effect.fail(
                  failure("The agent relay volume already exists or ownership could not be proven."),
                ),
          ),
        ),
        () =>
          checked({ method: "DELETE", path: `/volumes/${encodeURIComponent(volume)}` }).pipe(Effect.orDie),
      );
      const createRequest: EngineHttpRequest = {
        method: "POST",
        path: `/containers/create?name=${encodeURIComponent(`lando-agent-relay-${input.kind}-${input.appId}`)}`,
        body: {
          Image: options.relayImage,
          Entrypoint: ["socat"],
          Env: [`LANDO_AGENT_TOKEN=${upstream.token}`],
          Labels: labels,
          Cmd: [
            `UNIX-LISTEN:${socket},fork,unlink-early,mode=666`,
            `SYSTEM:{ printf %s "$LANDO_AGENT_TOKEN"; cat; } | socat - TCP:${options.hostGateway}:${upstream.port}`,
          ],
          HostConfig: {
            Binds: [`${volume}:/run/lando/agent`],
            ExtraHosts: [`${options.hostGateway}:host-gateway`],
            LogConfig: { Type: "none" },
          },
        },
      };
      const container = yield* Effect.acquireRelease(
        Effect.gen(function* () {
          const initial = yield* request(createRequest);
          if (initial.status === 404) {
            yield* pullImage(options.api, options.relayImage, {
              ctx: { providerId: "docker", remediation: "Pull the agent relay image and retry." },
              dialect: dockerPullDialect,
            }).pipe(Effect.mapError(() => failure("Could not pull the Docker agent relay image.")));
          }
          const response = initial.status === 404 ? yield* checked(createRequest) : initial;
          if (response.status !== 201)
            return yield* Effect.fail(failure("Could not create the Docker agent relay container."));
          return yield* Schema.decodeUnknown(Identifier)(response.body).pipe(
            Effect.map((value) => encodeURIComponent(value.Id)),
            Effect.mapError(() => failure("Docker returned an invalid relay container identifier.")),
          );
        }),
        (id) =>
          request({ method: "POST", path: `/containers/${id}/stop?t=1` }).pipe(
            Effect.flatMap((response) =>
              response.status === 204 || response.status === 304 || response.status === 404
                ? Effect.void
                : Effect.fail(failure("Could not stop the Docker agent relay container.")),
            ),
            Effect.orDie,
            Effect.ensuring(
              checked({ method: "DELETE", path: `/containers/${id}?force=true` }).pipe(Effect.orDie),
            ),
          ),
      );
      yield* checked({ method: "POST", path: `/containers/${container}/start` });
      const ready = yield* runProbe(
        {
          id: "docker-agent-socket",
          policy: { maxAttempts: 50, delay: Duration.millis(100), timeout: Duration.seconds(10) },
        },
        Effect.gen(function* () {
          const created = yield* checked({
            method: "POST",
            path: `/containers/${container}/exec`,
            body: { Cmd: ["test", "-S", socket], AttachStdout: false, AttachStderr: false },
          });
          const exec = yield* Schema.decodeUnknown(Identifier)(created.body);
          const execId = encodeURIComponent(exec.Id);
          yield* checked({
            method: "POST",
            path: `/exec/${execId}/start`,
            body: { Detach: false, Tty: false },
          });
          const response = yield* checked({ method: "GET", path: `/exec/${execId}/json` });
          const status = yield* Schema.decodeUnknown(ExecStatus)(response.body);
          if (status.Running || status.ExitCode !== 0)
            return yield* Effect.fail(failure("Agent relay socket is not ready."));
        }),
      ).pipe(Effect.mapError(() => failure("Docker agent relay readiness probe failed.")));
      if (ready.outcome !== "green")
        return yield* Effect.fail(failure("Docker agent relay socket did not become ready."));
      return { _tag: "volume", volume };
    });
