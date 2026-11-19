import { expect } from "bun:test";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { makeLandoPaths } from "@lando/paths";
import { InfoAppResult, StartAppResult } from "@lando/sdk/schema";
import { Option, Schema } from "effect";

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
export const prerequisite = !isScannerLiveEligible()
  ? `Set LANDO_TEST_PODMAN_SOCKET to the answering managed socket ${managedProviderSocketPath}. Preserve the installation's LANDO_USER_* roots (or set LANDO_TEST_USE_REAL_ROOTS=1) before starting Bun.`
  : Bun.which(binary) === null
    ? `Build the compiled CLI or set LANDO_SCENARIO_E2E_BINARY to an executable binary; missing ${binary}.`
    : Bun.which("curl") === null
      ? "Install curl in the live-test environment."
      : undefined;

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

export const run = async (cwd: string, argv: readonly string[], timeout: number) => {
  // Embedded Bun uses BUN_BE_BUN=1; compiled CLI children must dispatch Lando instead.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "BUN_BE_BUN"));
  const proc = Bun.spawn([...argv], {
    cwd,
    env: { ...env, LANDO_PROVIDER: liveProvider, LANDO_TELEMETRY_ENABLED: "false" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout,
    killSignal: "SIGKILL",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  expect(exitCode, JSON.stringify({ cwd, argv, exitCode, stdout, stderr })).toBe(0);
  return stdout;
};

export const cli = (cwd: string, args: readonly string[], timeout = 60_000) =>
  run(cwd, [binary, ...args, "--format=json"], timeout);

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
