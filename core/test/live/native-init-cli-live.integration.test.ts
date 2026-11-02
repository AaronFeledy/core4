import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { StartAppResult, StopAppResult } from "@lando/sdk/schema";
import { Option, Schema } from "effect";
import { isScannerLiveEligible, managedProviderSocketPath } from "./scanner-live-fixture.ts";

const binary = resolve(process.env.LANDO_SCENARIO_E2E_BINARY ?? join(import.meta.dir, "../../dist/lando"));
const required = process.env.LANDO_GUIDE_E2E === "1" || process.env.LANDO_NATIVE_INIT_E2E === "1";
const prerequisite = !isScannerLiveEligible()
  ? `An explicit answering managed LANDO_TEST_PODMAN_SOCKET=${managedProviderSocketPath} and installation roots are required; this test never runs setup.`
  : Bun.which(binary) === null
    ? `Compiled CLI missing: ${binary}`
    : undefined;
const startEnvelope = Schema.Struct({ ok: Schema.Literal(true), result: StartAppResult });
const startFrame = Schema.fromJsonString(
  Schema.Struct({ _tag: Schema.Literal("result"), envelope: startEnvelope }),
);
const stopEnvelope = Schema.fromJsonString(
  Schema.Struct({ ok: Schema.Literal(true), result: StopAppResult }),
);

test.skipIf(prerequisite !== undefined && !required)(
  `compiled CLI start -> stop reports handler exit and marker${prerequisite === undefined ? "" : ` (SKIP: ${prerequisite})`}`,
  async () => {
    if (prerequisite !== undefined) throw new Error(prerequisite);
    // Given: a unique app whose actual TERM handler writes outside the removed container.
    const root = await mkdtemp(join(tmpdir(), "lando-native-init-cli-"));
    const name = `init-cli-${crypto.randomUUID()}`;
    const marker = `handled-${crypto.randomUUID()}`;
    const proof = join(root, "proof");
    const cli = async (args: readonly string[], timeout = 90_000) => {
      const { BUN_BE_BUN: _bunBeBun, ...env } = process.env;
      const child = Bun.spawn([binary, ...args, "--format=json"], {
        cwd: root,
        env: { ...env, LANDO_PROVIDER: "lando", LANDO_TELEMETRY_ENABLED: "false" },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout,
        killSignal: "SIGKILL",
      });
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(code, JSON.stringify({ args, stdout, stderr })).toBe(0);
      return stdout.trim().split("\n").at(-1) ?? "";
    };
    let started = false;
    try {
      await chmod(root, 0o755);
      await mkdir(proof, { mode: 0o777 });
      await chmod(proof, 0o777);
      await Bun.write(
        join(root, ".lando.yml"),
        [
          `name: ${name}`,
          "runtime: 4",
          "provider: lando",
          "router:",
          "  enabled: false",
          "services:",
          "  handler:",
          "    type: compose",
          "    image: busybox:1.37",
          "    init: true",
          "    appMount: false",
          "    healthcheck: false",
          "    volumes:",
          "      - ./proof:/proof",
          "    entrypoint: []",
          "    command:",
          "      - sh",
          "      - -c",
          `      - 'trap "printf %s ${marker} > /proof/handled; exit 0" TERM; touch /proof/ready; while :; do sleep 1 & wait $!; done'`,
          "",
        ].join("\n"),
      );
      started = true;
      const line = await cli(["start"], 300_000);
      const framed = Schema.decodeUnknownOption(startFrame)(line);
      const result = Option.isSome(framed)
        ? framed.value.envelope.result
        : Schema.decodeUnknownSync(Schema.fromJsonString(startEnvelope))(line).result;
      expect(result.servicesStarted.map((service) => service.name)).toContain("handler");
      const deadline = performance.now() + 30_000;
      while (!(await Bun.file(join(proof, "ready")).exists())) {
        if (performance.now() > deadline) throw new Error("TERM handler never became ready");
        await Bun.sleep(100);
      }
      // When: the real compiled CLI stops and removes its exact owned runtime.
      const began = performance.now();
      const stopped = Schema.decodeUnknownSync(stopEnvelope)(await cli(["stop"])).result;
      // Then: JSON carries observed facts, while the independent marker proves this handler ran.
      expect(stopped.shutdownObservations).toHaveLength(1);
      expect(stopped.shutdownObservations?.[0]).toMatchObject({
        appId: stopped.app,
        providerId: "lando",
        service: "handler",
        status: "exited",
        exitCode: 0,
      });
      expect(stopped.shutdownObservations?.[0]?.containerId?.length).toBeGreaterThan(0);
      expect(await Bun.file(join(proof, "handled")).text()).toBe(marker);
      console.info(
        "NATIVE_INIT_CLI_EVIDENCE",
        JSON.stringify({
          name,
          stopMs: performance.now() - began,
          shutdownObservations: stopped.shutdownObservations,
          marker,
        }),
      );
    } finally {
      try {
        if (started) await cli(["destroy", "--yes", "--volumes"]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  },
  480_000,
);
