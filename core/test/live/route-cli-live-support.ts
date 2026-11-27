import { expect } from "bun:test";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { engineInfoRootless } from "@lando/container-runtime/capabilities";
import { makePodmanApiClient } from "@lando/container-runtime/podman/api-client";
import { resolveLiveProviderSocket } from "@lando/engine/testing/live-provider-socket";
import { makeLandoPaths } from "@lando/paths";
import { introspectProviderCapabilities } from "@lando/provider-lando";
import { podmanCapabilitiesForPlatform } from "@lando/provider-podman";
import { InfoAppResult, StartAppResult } from "@lando/sdk/schema";
import { Effect, Option, Schema } from "effect";

import { isScannerLiveEligible, managedProviderSocketPath } from "./scanner-live-fixture.ts";

/**
 * The provider these live cases run on. The default managed runtime is named
 * explicitly; set `LANDO_TEST_PROVIDER=docker` to run the same matrix on a
 * working system Docker host. A Docker result stays unverified until it runs.
 */
export const liveProvider = process.env.LANDO_TEST_PROVIDER ?? "lando";

export const binary = resolve(
  process.env.LANDO_SCENARIO_E2E_BINARY ?? join(import.meta.dir, "../../dist/lando"),
);
const managedSocketOptIn = `Set LANDO_TEST_PODMAN_SOCKET to the answering managed socket ${managedProviderSocketPath}. Preserve the installation's LANDO_USER_* roots (or set LANDO_TEST_USE_REAL_ROOTS=1) before starting Bun.`;
const compiledCliPrerequisite =
  Bun.which(binary) === null
    ? `Build the compiled CLI or set LANDO_SCENARIO_E2E_BINARY to an executable binary; missing ${binary}.`
    : Bun.which("curl") === null
      ? "Install curl in the live-test environment."
      : undefined;
export const prerequisite = isScannerLiveEligible() ? compiledCliPrerequisite : managedSocketOptIn;

type RoutePodmanTarget = { readonly provider: "lando" | "podman"; readonly socketPath: string };

export const resolveRoutePodmanTarget = (managedOnly = false): RoutePodmanTarget | undefined => {
  const provider = !managedOnly && process.env.LANDO_PROVIDER === "podman" ? "podman" : "lando";
  const socket = resolveLiveProviderSocket();
  if (socket === undefined) return undefined;
  if (provider === "lando" && socket.socketPath !== makeLandoPaths().providerSocketPath) return undefined;
  return { provider, socketPath: socket.socketPath };
};

export const routeCliPrerequisite = (target: RoutePodmanTarget | undefined) =>
  target === undefined
    ? `${managedSocketOptIn} To test against a Podman bridge, run the live selection with the answering socket and no root overrides.`
    : compiledCliPrerequisite;

export const routeProviderEnv = ({ provider, socketPath }: RoutePodmanTarget) => ({
  LANDO_PROVIDER: provider,
  LANDO_TEST_PODMAN_SOCKET: socketPath,
});

const routePodmanApi = ({ provider, socketPath }: RoutePodmanTarget) =>
  makePodmanApiClient(socketPath, {
    env: process.env,
    providerId: provider,
    remediation: "Check the opted-in Podman socket.",
  });

export const inspectRouteContainer = (target: RoutePodmanTarget, container: string) => {
  const { request } = routePodmanApi(target);
  if (request === undefined) throw new Error("The Podman client has no HTTP request transport.");
  return Effect.runPromise(
    request({ method: "GET", path: `/containers/${encodeURIComponent(container)}/json` }).pipe(
      Effect.timeout("10 seconds"),
    ),
  );
};

const containerObservation = Schema.fromJsonString(
  Schema.Struct({ Id: Schema.NonEmptyString, State: Schema.Struct({ Running: Schema.Boolean }) }),
);

export const observeRouteContainer = async (target: RoutePodmanTarget, container: string) => {
  const response = await inspectRouteContainer(target, container);
  expect(response.status, response.body).toBe(200);
  return Schema.decodeUnknownSync(containerObservation)(response.body);
};

const rootlessPodmanInfo = Schema.Struct({
  host: Schema.Struct({ security: Schema.Struct({ rootless: Schema.Literal(true) }) }),
});

export const linuxProjectUserMapping = async (target: RoutePodmanTarget, requireExplicitRootless = false) => {
  if (process.platform !== "linux") return "unsupported";
  const api = routePodmanApi(target);
  // Capability introspection assumes rootless when older engines omit the fact. CI needs proof.
  const mapping =
    target.provider === "podman"
      ? api.info.pipe(
          Effect.map(
            (info) => podmanCapabilitiesForPlatform("linux", [], engineInfoRootless(info)).projectUserMapping,
          ),
        )
      : requireExplicitRootless
        ? api.info.pipe(
            Effect.map((info) => (Schema.is(rootlessPodmanInfo)(info) ? "userns-keep-id" : "unsupported")),
          )
        : introspectProviderCapabilities(api, "linux").pipe(
            Effect.map((capabilities) => capabilities.projectUserMapping),
          );
  return Effect.runPromise(mapping.pipe(Effect.timeout("5 seconds")));
};

// Call only after the managed prerequisite has confirmed the opted-in socket.
export const managedLinuxMapsProjectUser = async () =>
  (await linuxProjectUserMapping({ provider: "lando", socketPath: managedProviderSocketPath })) ===
  "userns-keep-id";

export const infoEnvelope = Schema.fromJsonString(
  Schema.Struct({ ok: Schema.Literal(true), result: InfoAppResult }),
);
const startResult = Schema.Struct({ ok: Schema.Literal(true), result: StartAppResult });
const startEnvelope = Schema.fromJsonString(startResult);
const startFrame = Schema.fromJsonString(
  Schema.Struct({ _tag: Schema.Literal("result"), envelope: startResult }),
);

export const decodeStart = (output: string) => {
  const line = output.trim().split("\n").at(-1) ?? "";
  const framed = Schema.decodeUnknownOption(startFrame)(line);
  return Option.isSome(framed)
    ? framed.value.envelope.result
    : Schema.decodeUnknownSync(startEnvelope)(line).result;
};

export const spawnRouteCommand = async (
  cwd: string,
  argv: readonly string[],
  options: { readonly timeout?: number; readonly env?: Readonly<Record<string, string>> } = {},
) => {
  // Embedded Bun uses BUN_BE_BUN=1; compiled CLI children must dispatch Lando instead.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "BUN_BE_BUN"));
  const proc = Bun.spawn([...argv], {
    cwd,
    env: { ...env, LANDO_TELEMETRY_ENABLED: "false", ...options.env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: options.timeout ?? 120_000,
    killSignal: "SIGKILL",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { cwd, argv, exitCode, stdout, stderr };
};

export const succeeded = (result: Awaited<ReturnType<typeof spawnRouteCommand>>) => {
  expect(result.exitCode, JSON.stringify(result)).toBe(0);
  return result.stdout;
};

export const run = async (cwd: string, argv: readonly string[], timeout: number) =>
  succeeded(await spawnRouteCommand(cwd, argv, { timeout, env: { LANDO_PROVIDER: liveProvider } }));

export const routeCli =
  (executable: string, env: Readonly<Record<string, string>>) =>
  async (cwd: string, args: readonly string[], timeout = 60_000) =>
    succeeded(await spawnRouteCommand(cwd, [executable, ...args, "--format=json"], { timeout, env }));

export const cli = routeCli(binary, { LANDO_PROVIDER: liveProvider });

/**
 * The shared mkcert root certificate setup installed. Real router TLS is
 * validated against this root instead of disabling verification; a host
 * without the installed root is a prerequisite failure, never a silent skip.
 */
export const mkcertRootCertificatePath = async (): Promise<string | undefined> => {
  const paths = makeLandoPaths();
  const mkcert = join(paths.binDir, process.platform === "win32" ? "mkcert.exe" : "mkcert");
  if (!existsSync(mkcert)) return undefined;
  const proc = Bun.spawn([mkcert, "-CAROOT"], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [exitCode, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
  if (exitCode !== 0) return undefined;
  const caroot = stdout.trim();
  return caroot.length === 0 ? undefined : join(caroot, "rootCA.pem");
};
