import { expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { buildContainerRemoveRequest } from "@lando/container-runtime/engine-api";
import { serviceContainerName } from "@lando/container-runtime/plan";
import { makePodmanApiClient } from "@lando/container-runtime/podman/api-client";
import { exec } from "@lando/container-runtime/podman/exec";
import { resolveLiveProviderSocket } from "@lando/engine/testing/live-provider-socket";
import { runProbe } from "@lando/sdk/probe";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import { DateTime, Duration, Effect, Schema, Stream } from "effect";

/**
 * Proves `lando setup` makes Homebrew's own curl trust the local CA on a Linuxbrew host.
 *
 * Everything runs in one `ghcr.io/homebrew/brew` container reached only through the
 * answering Podman socket. The compiled CLI is bind-mounted from `LANDO_SCENARIO_E2E_BINARY`;
 * the socket may belong to a remote or VM-backed Podman host, so that path must live on a
 * disk the Podman host shares with this one (CI builds it under `$GITHUB_WORKSPACE`).
 */
const socket = resolveLiveProviderSocket();
const binary = process.env.LANDO_SCENARIO_E2E_BINARY;
const skipReason =
  socket === undefined
    ? "LANDO_TEST_PODMAN_SOCKET does not name an answering Podman socket"
    : binary === undefined || binary.length === 0
      ? "LANDO_SCENARIO_E2E_BINARY is unset; build the compiled CLI and point it there"
      : undefined;
if (skipReason !== undefined) console.info(`[homebrew-trust] skipped: ${skipReason}`);

const IMAGE = "ghcr.io/homebrew/brew:latest";
const CONTAINER_LANDO = "/usr/local/bin/lando";
const BREW_BUNDLE = "/home/linuxbrew/.linuxbrew/etc/ca-certificates/cert.pem";
const SETUP = [
  CONTAINER_LANDO,
  "setup",
  "--provider=lando",
  "--skip-provider",
  "--skip-proxy",
  "--skip-shell-integration",
  "--skip-file-sync",
  "--yes",
  "--no-interactive",
  "--format=json",
];
const OPENSSL = "ls -d $(brew --prefix)/opt/openssl@*/bin/openssl | sort -V | tail -n 1";

const TrustStoreRow = Schema.Struct({
  id: Schema.String,
  location: Schema.optionalKey(Schema.String),
  state: Schema.String,
  changed: Schema.Boolean,
});
const SetupEnvelope = Schema.Struct({
  ok: Schema.Boolean,
  result: Schema.Struct({ trustStores: Schema.Array(TrustStoreRow) }),
  warnings: Schema.optionalKey(Schema.Array(Schema.Struct({ code: Schema.String }))),
});
const DoctorCheck = Schema.Struct({ name: Schema.String, status: Schema.String });
const DoctorEnvelope = Schema.Struct({
  result: Schema.Struct({ checks: Schema.Array(DoctorCheck) }),
});
const decodeSetup = Schema.decodeUnknownSync(Schema.fromJsonString(SetupEnvelope));
const decodeDoctor = Schema.decodeUnknownSync(Schema.fromJsonString(DoctorEnvelope));

const metadata = {
  resolvedAt: DateTime.makeUnsafe("2026-01-01T00:00:00Z"),
  source: "homebrew-trust-live",
  runtime: 4,
} as const;
const service: ServicePlan = {
  name: ServiceName.make("brew"),
  type: "brew",
  provider: ProviderId.make("lando"),
  primary: true,
  environment: {},
  mounts: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  extensions: {},
  metadata,
  endpoints: [],
};
const slug = `homebrew-trust-${crypto.randomUUID().slice(0, 8)}`;
const plan: AppPlan = {
  id: AppId.make(slug),
  name: "Homebrew trust live",
  slug,
  valueModel: 1,
  provider: service.provider,
  root: AbsolutePath.make("/tmp/homebrew-trust-live"),
  services: { [service.name]: service },
  routes: [],
  stores: [],
  fileSync: [],
  metadata,
  extensions: {},
};

test.skipIf(skipReason !== undefined)(
  "lando setup makes Homebrew curl trust the local CA and reruns as a no-op",
  async () => {
    if (socket === undefined || binary === undefined) throw new TypeError(skipReason);
    const ctx = { providerId: "lando", remediation: "Check the live test runtime.", env: {} };
    const api = makePodmanApiClient(socket.socketPath, ctx);
    const request = api.request;
    if (request === undefined) throw new TypeError("Missing request API");
    const name = serviceContainerName(plan, service.name);
    const target = { app: plan.id, service: service.name, plan };
    const run = (script: string) =>
      exec(plan, target, { command: ["bash", "-c", script], raw: true }, { api, ctx });
    const expectExit = (script: string) =>
      run(script).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            if (result.exitCode !== 0) console.error(script, result.stdout, result.stderr);
            expect(result.exitCode).toBe(0);
          }),
        ),
      );
    const setup = expectExit(SETUP.join(" ")).pipe(Effect.map((result) => decodeSetup(result.stdout)));
    const homebrewRow = (envelope: typeof SetupEnvelope.Type) =>
      envelope.result.trustStores.find((row) => row.id === "homebrew");

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const inspect = yield* request({
            method: "GET",
            path: `/images/${encodeURIComponent(IMAGE)}/json`,
          });
          if (inspect.status === 404) {
            if (api.stream === undefined) throw new TypeError("Missing pull stream");
            yield* Stream.runDrain(
              api.stream({ method: "POST", path: `/images/create?fromImage=${encodeURIComponent(IMAGE)}` }),
            );
          }
          yield* Effect.acquireRelease(
            request({
              method: "POST",
              path: `/containers/create?name=${name}`,
              body: {
                Image: IMAGE,
                Cmd: ["sleep", "infinity"],
                Env: [
                  "HOMEBREW_NO_AUTO_UPDATE=1",
                  "HOMEBREW_NO_ANALYTICS=1",
                  "HOMEBREW_NO_INSTALL_CLEANUP=1",
                ],
                HostConfig: { Binds: [`${realpathSync(binary)}:${CONTAINER_LANDO}:ro`] },
              },
            }).pipe(Effect.tap((response) => Effect.sync(() => expect(response.status).toBe(201)))),
            () => request(buildContainerRemoveRequest(name)).pipe(Effect.orDie, Effect.asVoid),
          );
          const started = yield* request({ method: "POST", path: `/containers/${name}/start` });
          expect(started.status).toBe(204);

          // ca-certificates arrives with curl, so Homebrew's bundle predates Lando's root.
          yield* expectExit("brew install curl");

          const first = yield* setup;
          expect(first.ok).toBe(true);
          expect(first.warnings?.map((warning) => warning.code) ?? []).not.toContain("CA_TRUST_INCOMPLETE");
          expect(first.result.trustStores.find((row) => row.id === "system")).toMatchObject({
            state: "trusted",
            changed: true,
          });
          expect(homebrewRow(first)).toMatchObject({
            location: BREW_BUNDLE,
            state: "trusted",
            changed: true,
          });

          yield* expectExit(
            "~/.local/share/lando/bin/mkcert -cert-file /tmp/leaf.pem -key-file /tmp/key.pem localhost",
          );
          yield* expectExit(
            `setsid "$(${OPENSSL})" s_server -accept 8443 -www -cert /tmp/leaf.pem -key /tmp/key.pem </dev/null >/tmp/s_server.log 2>&1 &`,
          );
          const ready = yield* runProbe(
            { id: "homebrew-trust-s-server", policy: { maxAttempts: 60, delay: Duration.millis(250) } },
            run("exec 3<>/dev/tcp/127.0.0.1/8443").pipe(
              Effect.flatMap((result) =>
                result.exitCode === 0 ? Effect.succeed(result) : Effect.fail("s_server not listening"),
              ),
            ),
          );
          expect(ready.outcome).toBe("green");
          yield* expectExit('"$(brew --prefix)/bin/curl" -fsS -o /dev/null https://localhost:8443/');

          const second = yield* setup;
          expect(second.ok).toBe(true);
          expect(homebrewRow(second)).toMatchObject({ state: "trusted", changed: false });

          const doctor = yield* run(
            `${CONTAINER_LANDO} doctor --section certificate-authority --format=json`,
          );
          const certs = decodeDoctor(doctor.stdout).result.checks.find((check) => check.name === "certs");
          expect(certs?.status).toBe("pass");
        }),
      ),
    );
  },
  15 * 60_000,
);
