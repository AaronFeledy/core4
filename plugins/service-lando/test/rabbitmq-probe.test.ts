import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { effectiveReadiness } from "@lando/sdk/schema";
import { Effect } from "effect";
import { rabbitmqProbes } from "../src/services/rabbitmq-probes.ts";
import { rabbitmqServiceType } from "../src/services/rabbitmq.ts";
import { composeCatalogConfigPlan } from "./support/catalog-config-app.ts";

test.skipIf(process.platform === "win32").each([
  { role: "healthcheck", listening: true, clientExit: 37, expected: 0, launched: false },
  { role: "readiness", listening: false, clientExit: 0, expected: 1, launched: false },
  { role: "readiness", listening: true, clientExit: 0, expected: 0, launched: true },
  { role: "readiness", listening: true, clientExit: 37, expected: 37, launched: true },
] as const)("$role gates the Erlang client when listening=$listening (exit=$clientExit)", async (input) => {
  // Given: a real TCP listener and an observable Erlang CLI substitute.
  const root = await mkdtemp(join(tmpdir(), "lando-rabbit-probe-"));
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data() {},
      open(socket) {
        socket.end();
      },
    },
  });
  const port = server.port;
  if (!input.listening) server.stop(true);
  try {
    const client = join(root, "rabbitmq-diagnostics");
    await Bun.write(client, '#!/bin/sh\nprintf "%s\\n" "$HOME:$*"\nexit "$CLIENT_EXIT"\n');
    await chmod(client, 0o755);
    const command = rabbitmqProbes(port)[input.role].command;
    if (command === undefined || typeof command === "string") throw new Error("Missing argv probe");
    // When: the probe runs with its supplied target and the service's HOME.
    const child = Bun.spawn([...command], {
      env: {
        ...process.env,
        PATH: `${root}:${process.env.PATH}`,
        HOME: root,
        LANDO_PROBE_HOST: "127.0.0.1",
        LANDO_PROBE_PORT: String(port),
        CLIENT_EXIT: String(input.clientExit),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exit, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    // Then: only readiness after a successful dial invokes the shared-cookie CLI.
    expect(exit).toBe(input.expected);
    expect(stdout).toBe(input.launched ? `${root}:-q ping\n` : "");
  } finally {
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});

test.each([
  { healthcheck: false, readiness: undefined, healthKind: "none", readyKind: "command" },
  { healthcheck: undefined, readiness: false, healthKind: "command", readyKind: "none" },
] as const)("keeps probe opt-outs independent: %j", async (input) => {
  // Given: a non-default AMQP listener and one authored opt-out.
  const plan = await Effect.runPromise(
    composeCatalogConfigPlan({
      serviceType: rabbitmqServiceType,
      slug: "rabbit-probes",
      serviceName: "queue",
      appRoot: "/srv/apps/rabbit-probes",
      source: "rabbitmq-probe.test",
      service: {
        type: "rabbitmq",
        port: 5673,
        ...(input.healthcheck === false ? { healthcheck: false } : {}),
        ...(input.readiness === false ? { readiness: false } : {}),
      },
    }),
  );
  const queue = Object.values(plan.services)[0];
  if (queue === undefined) throw new Error("Missing queue");
  // When: startup selects its effective probe.
  const readiness = effectiveReadiness(queue);
  // Then: disabling either role leaves the other role and its target intact.
  expect(queue.healthcheck?.kind).toBe(input.healthKind);
  expect(readiness?.kind).toBe(input.readyKind);
  const active = input.healthcheck === false ? readiness : queue.healthcheck;
  expect(active?.target).toEqual({ port: 5673, transport: "tcp", names: [], primary: false });
  expect(active?.user).toBeUndefined();
});

test("both probe targets follow the planned AMQP port without overriding identity", () => {
  const probes = rabbitmqProbes(5673);
  for (const probe of Object.values(probes)) {
    expect(probe.target).toEqual({ port: 5673, transport: "tcp", names: [], primary: false });
    expect(probe.user).toBeUndefined();
    expect(probe).toMatchObject({
      intervalSeconds: 10,
      timeoutSeconds: 5,
      retries: 5,
      startPeriodSeconds: 30,
    });
  }
});
