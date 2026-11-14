import { expect } from "bun:test";
import { resolve } from "node:path";
import { InfoAppResult } from "@lando/sdk/schema";
import { Schema } from "effect";

import { ScheduleListResult, ScheduleRunResult as ScheduleRunResultSchema } from "../src/schemas.ts";

/**
 * Debian with named users and a timezone database. Its image declares
 * `STOPSIGNAL SIGWINCH` for Apache, which the scheduler ignores, so this cell
 * also proves a sidecar is not stopped with its parent image's signal.
 */
export const DEBIAN_IMAGE = "php:8.3-apache";
/** No timezone database, so this cell proves the sidecar build installs one. */
export const ALPINE_IMAGE = "alpine:3.22";
export const IMAGES = [DEBIAN_IMAGE, ALPINE_IMAGE] as const;

export interface ProviderCell {
  readonly id: "lando" | "docker";
  readonly label: string;
  readonly available: boolean;
  readonly missing: string;
  readonly env: NodeJS.ProcessEnv;
}

const cli = process.env.LANDO_SCENARIO_E2E_BINARY;
const sourceCli = [process.execPath, resolve(import.meta.dirname, "../../../core/bin/lando.ts")];
const command = cli === undefined ? sourceCli : [cli];

const inheritedEnv = (): NodeJS.ProcessEnv => {
  const { BUN_BE_BUN: _bun, DOCKER_HOST: _docker, LANDO_PROVIDER: _provider, ...rest } = process.env;
  return { ...rest, LANDO_TELEMETRY_ENABLED: "false" };
};

const dockerHost = (socket: string): string => (socket.includes("://") ? socket : `unix://${socket}`);

const podmanSocket = process.env.LANDO_TEST_PODMAN_SOCKET;
const dockerSocket = process.env.LANDO_TEST_DOCKER_SOCKET;

export const cells: ReadonlyArray<ProviderCell> = [
  {
    id: "lando",
    label: "managed lando",
    available: podmanSocket !== undefined && podmanSocket.length > 0,
    missing: "LANDO_TEST_PODMAN_SOCKET",
    env: inheritedEnv(),
  },
  {
    id: "docker",
    label: "docker",
    available: dockerSocket !== undefined && dockerSocket.length > 0,
    missing: "LANDO_TEST_DOCKER_SOCKET",
    env: {
      ...inheritedEnv(),
      LANDO_PROVIDER: "docker",
      ...(dockerSocket === undefined ? {} : { DOCKER_HOST: dockerHost(dockerSocket) }),
    },
  },
];

export interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export const runCli = async (
  cell: ProviderCell,
  cwd: string,
  argv: ReadonlyArray<string>,
  timeoutMs = 120_000,
): Promise<RunResult> => {
  const child = Bun.spawn([...command, ...argv], {
    cwd,
    env: cell.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
};

export const expectSuccess = (result: RunResult, what: string): RunResult => {
  expect(result.exitCode, `${what} failed (${result.exitCode})\n${result.stdout}\n${result.stderr}`).toBe(0);
  return result;
};

export const decodeLastLine = <A>(schema: Schema.Codec<A>, stdout: string, what: string): A => {
  const line = stdout.trim().split("\n").at(-1) ?? "";
  try {
    return Schema.decodeUnknownSync(Schema.fromJsonString(schema))(line);
  } catch (error) {
    throw new Error(`${what} did not return the expected JSON envelope: ${line}\n${String(error)}`);
  }
};

export const InfoEnvelope = Schema.Struct({ ok: Schema.Literal(true), result: InfoAppResult });
export const RunEnvelope = Schema.Struct({
  ok: Schema.Boolean,
  result: ScheduleRunResultSchema,
  error: Schema.optional(Schema.Struct({ exitCode: Schema.optional(Schema.Number) })),
});
export const ListEnvelope = Schema.Struct({ ok: Schema.Literal(true), result: ScheduleListResult });
export const LogsEnvelope = Schema.Struct({
  envelope: Schema.Struct({
    ok: Schema.Literal(true),
    result: Schema.Struct({
      lines: Schema.Array(
        Schema.Struct({ service: Schema.String, stream: Schema.String, line: Schema.String }),
      ),
    }),
  }),
});
export const StopEnvelope = Schema.Struct({
  ok: Schema.Literal(true),
  result: Schema.Struct({
    shutdownObservations: Schema.Array(
      Schema.Struct({ service: Schema.String, exitCode: Schema.optional(Schema.Number) }),
    ),
  }),
});

export const waitForText = async (path: string, timeoutMs: number, what: string): Promise<string> => {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const file = Bun.file(path);
    if (await file.exists()) return await file.text();
    await Bun.sleep(500);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what} at ${path}`);
};

export const reserveLoopbackPort = (): number => {
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = reservation.port;
  reservation.stop(true);
  if (port === undefined) throw new Error("Bun.serve did not assign a loopback port");
  return port;
};

export type ScheduleMode = "full" | "edited" | "none";

const SCHEDULE_ZONE = "America/Chicago";

/** Every abbreviation `date +%Z` can report for that zone as seasons change. */
export const SCHEDULE_ZONE_ABBREVIATIONS: ReadonlyArray<string> = ["CST", "CDT"];

const identityProbe = (prefix: string): string =>
  `id -u; id -g; echo $HOME; pwd; date +%Z; mkdir -p /app; id -u > /app/${prefix}-uid.txt; id -g > /app/${prefix}-gid.txt; echo $HOME > /app/${prefix}-home.txt; pwd > /app/${prefix}-pwd.txt; date +%Z > /app/${prefix}-tz.txt`;

const jobsFor = (mode: ScheduleMode, image: string): ReadonlyArray<string> => {
  if (mode === "none") return [];
  const touched = mode === "edited" ? "/app/restarted.txt" : "/app/scheduled.txt";
  // A block scalar proves a multi-line job runs as one script: the second line
  // produces the file this suite waits for after the restart.
  return [
    "    schedule:",
    "      - name: tick",
    '        every: "@every 1s"',
    "        run: |",
    `          ${identityProbe("scheduled")}`,
    `          touch ${touched}`,
    "      - name: vendor",
    '        every: "@every 1s"',
    '        run: "if [ -f /app/vendor/marker ] && [ ! -f /app/vendor-seen.txt ]; then cp /app/vendor/marker /app/vendor-seen.txt; fi"',
    "      - name: chatty",
    '        every: "@every 1s"',
    '        run: "echo chatty-out; echo chatty-err >&2"',
    // Outlasts its one-second interval. A run that finds the lock started while
    // another was going, which the scheduler must never allow.
    "      - name: slow",
    '        every: "@every 1s"',
    "        run: |",
    "          mkdir /tmp/slow-lock 2>/dev/null || { touch /app/overlapped.txt; exit 0; }",
    "          if [ -f /app/slow-first.txt ]; then touch /app/slow-second.txt; else touch /app/slow-first.txt; fi",
    "          sleep 3",
    "          rmdir /tmp/slow-lock",
    "      - name: second",
    '        every: "@every 1s"',
    '        user: "1002"',
    `        run: "touch /app/other.txt && ${identityProbe("other")}"`,
    ...(image === DEBIAN_IMAGE
      ? [
          "      - name: named",
          '        every: "@every 1s"',
          '        user: "nobody"',
          `        run: "touch /app/nobody.txt && ${identityProbe("nobody")}"`,
        ]
      : []),
    "      - name: yearly",
    '        every: "@yearly"',
    '        run: "echo yearly-ran"',
    "      - name: failing",
    '        every: "@yearly"',
    '        run: "echo failing-stdout; exit 3"',
  ];
};

/** Idles until either image's stop signal arrives, so no authored service waits out the grace period. */
const IDLE_COMMAND = `    command: ["sh", "-c", "trap 'exit 0' TERM WINCH; while :; do sleep 1; done"]`;

export const landofile = (input: {
  readonly appName: string;
  readonly image: string;
  readonly port: number;
  readonly mode: ScheduleMode;
}): string =>
  [
    `name: ${input.appName}`,
    "runtime: 4",
    "agentEnv: false",
    "sshAgent:",
    "  sidecar: false",
    "gpgAgent:",
    "  forward: false",
    "router:",
    "  enabled: false",
    "services:",
    "  web:",
    "    type: compose",
    `    image: ${input.image}`,
    IDLE_COMMAND,
    '    user: "1001"',
    "    home: false",
    "    appMount: /app",
    "    environment:",
    `      TZ: ${SCHEDULE_ZONE}`,
    "    ports:",
    `      - "127.0.0.1:${input.port}:80"`,
    "    dependsOn:",
    "      - db",
    ...jobsFor(input.mode, input.image),
    "  db:",
    "    type: compose",
    `    image: ${input.image}`,
    IDLE_COMMAND,
    "    home: false",
    "    appMount: false",
    "",
  ].join("\n");

export const sidecarNames = (image: string): ReadonlyArray<string> =>
  image === DEBIAN_IMAGE
    ? ["web-schedule", "web-schedule-1002", "web-schedule-nobody"]
    : ["web-schedule", "web-schedule-1002"];

export const infoFor = async (cell: ProviderCell, appRoot: string) => {
  const info = expectSuccess(
    await runCli(cell, appRoot, ["info", "--format=json"]),
    `lando info on ${cell.label}`,
  );
  return decodeLastLine(InfoEnvelope, info.stdout, `lando info on ${cell.label}`).result.services;
};
