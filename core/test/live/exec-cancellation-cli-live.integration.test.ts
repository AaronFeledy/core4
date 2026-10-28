import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { deserialize } from "node:v8";
import { serviceContainerName } from "@lando/container-runtime/plan";
import { APP_PLAN_CACHE_HEADER_BYTES } from "@lando/engine/cache/app-plan";
import { makeLandoPaths } from "@lando/paths";
import { CurrentExecutableAppPlan, StreamFrame } from "@lando/sdk/schema";
import { Schema } from "effect";

// Explicit local-daemon opt-in only; never inherit a managed runtime or user app.
const socket = process.env.LANDO_TEST_DOCKER_SOCKET;
const enabled = socket === "/var/run/docker.sock";
const source = [process.execPath, resolve(import.meta.dir, "../../bin/lando.ts")];
const compiled = process.env.LANDO_SCENARIO_E2E_BINARY;
const variants = [
  { name: "source", command: source },
  { name: "compiled", command: compiled === undefined ? undefined : [compiled] },
];

const docker = async (args: readonly string[]) => {
  const proc = Bun.spawn(["docker", "--host", "unix:///var/run/docker.sock", ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 15_000,
  });
  const [code, out, err] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`Docker fixture (${code}): ${err}`);
  return out.trim();
};

const inspectExec = async (id: string) => {
  const response = await fetch(`http://localhost/exec/${id}/json`, { unix: "/var/run/docker.sock" });
  if (!response.ok) throw new Error(`Exec inspection failed: ${response.status}`);
  return (await response.json()) as {
    Running: boolean;
    ProcessConfig: { entrypoint: string; arguments: string[] };
  };
};

for (const variant of variants.flatMap((entry) =>
  (["SIGINT", "SIGTERM"] as const).map((signal) => ({ ...entry, signal })),
))
  for (const user of ["0:0", "1000:1000"]) {
    const signal = variant.signal;
    test.skipIf(!enabled || variant.command === undefined)(
      `${variant.name} piped CLI ${signal} reaches payload and joins escaped descendants (${user})`,
      async () => {
        if (variant.command === undefined) throw new Error("Missing compiled CLI");
        const command = variant.command;
        const root = await mkdtemp(join(tmpdir(), "lando-cli-cancel-"));
        const name = `cli-cancel-${crypto.randomUUID()}`;
        const env = {
          ...Object.fromEntries(
            Object.entries(process.env).filter(
              ([key]) =>
                !key.startsWith("LANDO_") &&
                !key.startsWith("DOCKER_") &&
                key !== "BUN_BE_BUN" &&
                key !== "SSH_AUTH_SOCK" &&
                key !== "GPG_AGENT_INFO",
            ),
          ),
          LANDO_USER_CONF_ROOT: join(root, "conf"),
          LANDO_USER_DATA_ROOT: join(root, "data"),
          LANDO_USER_CACHE_ROOT: join(root, "cache"),
          LANDO_SYSTEM_PLUGIN_ROOT: join(root, "system-plugins"),
          LANDO_PROVIDER: "docker",
          DOCKER_HOST: "unix:///var/run/docker.sock",
          LANDO_AGENT_ENV: "0",
          LANDO_TELEMETRY_ENABLED: "false",
        };
        const cli = (args: string[]) =>
          Bun.spawn([...command, ...args], {
            cwd: root,
            env,
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
            timeout: 60_000,
            killSignal: "SIGKILL",
          });
        const complete = async (proc: ReturnType<typeof cli>) => {
          const [exitCode, stdout, stderr] = await Promise.all([
            proc.exited,
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
          ]);
          return { exitCode, stdout, stderr };
        };
        let id: string | undefined;
        let active: ReturnType<typeof cli> | undefined;
        try {
          await Bun.write(
            join(root, ".lando.yml"),
            [
              `name: ${name}`,
              "runtime: 4",
              "provider: docker",
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
              "    image: alpine:3.20",
              "    home: false",
              "    appMount: false",
              "    command:",
              "      - sleep",
              "      - '300'",
              "",
            ].join("\n"),
          );
          const planned = await complete(cli(["app:cache:refresh", "--format=json"]));
          expect(planned.exitCode, planned.stdout + planned.stderr).toBe(0);
          const cache = await readFile(makeLandoPaths({ env }).appPlanCacheFile(name, root));
          const payload = deserialize(cache.subarray(APP_PLAN_CACHE_HEADER_BYTES)) as { plan: unknown };
          const plan = Schema.decodeUnknownSync(CurrentExecutableAppPlan)(payload.plan);
          expect(Object.values(plan.services).flatMap((service) => service.mounts)).toEqual([]);
          id = await docker([
            "create",
            "--network",
            "none",
            "--name",
            serviceContainerName(plan, "web"),
            "alpine:3.20",
            "sleep",
            "300",
          ]);
          await docker(["start", id]);
          const containerId = id;
          const inside = (args: string[]) => docker(["exec", "--user", user, containerId, ...args]);
          const natural = await complete(
            cli(["exec", "--user", user, "web", "--", "sh", "-c", "printf natural; exit 23"]),
          );
          expect(natural.exitCode, natural.stdout + natural.stderr).toBe(23);
          expect(natural.stdout).toBe("natural");
          await inside(["sh", "-c", "sleep 317 </dev/null >/dev/null 2>&1 & echo $! >/tmp/cli-sentinel"]);
          const script = [
            "echo $$ >/tmp/cli-payload",
            "trap 'echo TERM >/tmp/cli-signal' TERM",
            "trap 'echo INT >/tmp/cli-int' INT",
            "setsid sh -c 'trap \"\" TERM INT; sh -c \"$1\"' sh 'nc -lk -p 31337 -e cat </dev/null >/dev/null 2>&1 & echo $! >/tmp/cli-escaped'",
            "while ! nc -z 127.0.0.1 31337; do sleep 0.05; done",
            "echo CLI_PAYLOAD_READY",
            "while :; do sleep 313; done",
          ].join("; ");
          active = cli(["exec", "--format=json", "--user", user, "web", "--", "sh", "-c", script]);
          const running = active;
          let stdout = "";
          let stderr = "";
          let pending = "";
          let payloadOutput = "";
          const frames: StreamFrame[] = [];
          const decodeFrame = Schema.decodeUnknownSync(Schema.fromJsonString(StreamFrame));
          const ready = Promise.withResolvers<void>();
          const drain = async (stream: ReadableStream<Uint8Array>, error: boolean) => {
            for await (const bytes of stream) {
              const chunk = new TextDecoder().decode(bytes);
              if (error) stderr += chunk;
              else {
                stdout += chunk;
                pending += chunk;
                let newline = pending.indexOf("\n");
                while (newline !== -1) {
                  const frame = decodeFrame(pending.slice(0, newline));
                  frames.push(frame);
                  if (frame._tag === "stdout") {
                    payloadOutput += frame.chunk;
                    if (payloadOutput.includes("CLI_PAYLOAD_READY")) ready.resolve();
                  }
                  pending = pending.slice(newline + 1);
                  newline = pending.indexOf("\n");
                }
              }
            }
          };
          const drains = Promise.all([drain(running.stdout, false), drain(running.stderr, true)]);
          await Promise.race([
            ready.promise,
            running.exited.then(() => {
              throw new Error(`CLI exited before readiness: ${stdout}${stderr}`);
            }),
          ]);
          const execIds = JSON.parse(
            await docker(["inspect", "--format", "{{json .ExecIDs}}", id]),
          ) as string[];
          const execs = await Promise.all(
            execIds.map(async (execId) => ({ id: execId, ...(await inspectExec(execId)) })),
          );
          const owned = execs.filter((exec) =>
            [exec.ProcessConfig.entrypoint, ...exec.ProcessConfig.arguments].some(
              (arg) => arg === "exec-supervisor" || arg === "exec-control",
            ),
          );
          expect(owned).toHaveLength(2);
          expect(owned.every((exec) => exec.Running)).toBe(true);
          const identities = await inside([
            "sh",
            "-ec",
            'for file in /tmp/cli-payload /tmp/cli-escaped /tmp/cli-sentinel; do pid=$(cat "$file"); case "$pid" in ""|*[!0-9]*) echo "Invalid PID in $file: $pid" >&2; exit 1;; esac; if ! cat "/proc/$pid/stat"; then echo "Missing process recorded in $file: $pid" >&2; exit 1; fi; done',
          ]);
          const beforeIdentities = identities
            .trim()
            .split("\n")
            .map((line) => line.split(/\s+/u));
          expect(beforeIdentities).toHaveLength(3);
          const start = performance.now();
          running.kill(signal); // Exactly one OS signal, only after the real port is ready.
          const exitCode = await running.exited;
          const elapsed = performance.now() - start;
          await drains;
          expect(elapsed).toBeLessThan(8_000); // A lease-expiry-only cleanup does not qualify.
          expect(exitCode, stdout + stderr).not.toBe(0);
          expect(stdout + stderr).not.toMatch(/cleanup|ExecSupervisionError|ServiceExecError|lease expired/i);
          expect(pending).toBe("");
          for (const frame of frames) {
            if (frame._tag === "result") {
              expect(frame.envelope.ok).toBe(false);
              expect(frame.envelope.result).toBeUndefined();
              expect(frame.envelope.error).toBeDefined();
            }
          }
          expect(running.signalCode === signal || exitCode === (signal === "SIGINT" ? 130 : 143)).toBe(true);
          const terminal = frames.filter((frame) => frame._tag === "result");
          expect(terminal).toHaveLength(1);
          expect(terminal[0]).toMatchObject({
            envelope: { ok: false, error: { _tag: "CommandInterruptedError", signal } },
          });
          expect(stdout + stderr).not.toMatch(
            /LandoInternalError|All fibers interrupted|--debug|reporting this failure/i,
          );
          const marker = signal === "SIGINT" ? "/tmp/cli-int" : "/tmp/cli-signal";
          const absent = signal === "SIGINT" ? "/tmp/cli-signal" : "/tmp/cli-int";
          expect(await inside(["cat", marker])).toBe(signal === "SIGINT" ? "INT" : "TERM");
          expect(await inside(["sh", "-c", `test ! -e ${absent} && echo absent`])).toBe("absent");
          for (const exec of owned) expect((await inspectExec(exec.id)).Running).toBe(false);
          const sentinelAfter = (await inside(["sh", "-c", "cat /proc/$(cat /tmp/cli-sentinel)/stat"])).split(
            /\s+/u,
          );
          expect(sentinelAfter[0]).toBe(beforeIdentities[2]?.[0]);
          expect(sentinelAfter[21]).toBe(beforeIdentities[2]?.[21]);
          expect(["Z", "X"]).not.toContain(sentinelAfter[2]);
          // Observe before any emergency fixture removal. These are immediate post-CLI-return checks.
          expect(
            await inside([
              "sh",
              "-c",
              "kill -0 $(cat /tmp/cli-sentinel) || exit 1; for file in /tmp/cli-payload /tmp/cli-escaped; do test ! -e /proc/$(cat $file) || exit 2; done; ps -o args | grep -E 'exec-supervisor|exec-control|^sleep 313$' | grep -v grep || true",
            ]),
          ).toBe("");
          expect(
            await inside([
              "sh",
              "-c",
              "nc -l -p 31337 >/dev/null 2>&1 & pid=$!; sleep 0.1; kill -0 $pid || exit 1; kill $pid; wait $pid; echo rebound",
            ]),
          ).toBe("rebound");
          console.log(
            "CLI_CANCELLATION_PROOF",
            JSON.stringify({
              variant: variant.name,
              user,
              id,
              exitCode,
              signal: running.signalCode,
              elapsed,
              ownedExecIds: owned.map((exec) => exec.id),
              terminalFrames: frames.filter((frame) => frame._tag === "result"),
              stderr,
              identities,
            }),
          );
        } finally {
          if (active !== undefined && active.exitCode === null) {
            active.kill("SIGKILL");
            await active.exited;
          }
          if (id !== undefined) await docker(["rm", "--force", id]);
          await rm(root, { recursive: true, force: true });
        }
      },
      120_000,
    );
  }
