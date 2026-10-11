import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { makePluginStateStore } from "@lando/engine/plugins/context-state";
import { makeTestStateStore } from "@lando/engine/testing/state-store";
import { makeDockerApiClient, makeRuntimeProvider } from "@lando/provider-docker";
import { runProbe } from "@lando/sdk/probe";
import { AbsolutePath } from "@lando/sdk/schema";
import { Duration, Effect, Schema } from "effect";
import { planHostProbe, hostProbeService as service } from "./host-reachability-fixture.ts";
import { ownerOnlyFileAccess } from "./private-file-access.ts";

const dockerHost = process.env.LANDO_TEST_DOCKER_SOCKET ?? process.env.DOCKER_HOST;

test.skipIf(dockerHost === undefined)(
  "connects from a planned Docker container to the host over TCP using the alias and LANDO_HOST_IP",
  async () => {
    // Given: a conflicting authored alias, custom addresses, and a unique host listener.
    const token = crypto.randomUUID();
    const name = `host-tcp-${token}`;
    const sharedNetworkName = `host-tcp-shared-${token}`;
    const stateDir = await mkdtemp(join(tmpdir(), "lando-host-tcp-"));
    const listener = Bun.listen({
      hostname: "0.0.0.0",
      port: 0,
      socket: {
        open(socket) {
          socket.end(token);
        },
        data() {},
      },
    });
    try {
      const localResponse = await new Promise<string>((resolve, reject) => {
        const socket = createConnection({ host: "127.0.0.1", port: listener.port });
        let response = "";
        socket.setTimeout(2000, () => socket.destroy(new Error("Local listener control timed out")));
        socket.on("data", (data) => {
          response += data.toString();
        });
        socket.on("end", () => resolve(response));
        socket.on("error", reject);
      });
      expect(localResponse, "local IPv4 listener control").toBe(token);
      const api = makeDockerApiClient(dockerHost);
      const provider = await Effect.runPromise(
        makeRuntimeProvider({
          platform: "linux",
          dockerApi: api,
          appliedPlanState: makePluginStateStore(
            makeTestStateStore().service,
            AbsolutePath.make(stateDir),
            ownerOnlyFileAccess,
          ),
        }),
      );
      const planned = await Effect.runPromise(planHostProbe(name, provider.capabilities));
      const networking = planned.networking;
      if (networking === undefined) throw new Error("planned probe networking missing");
      const request = api.request;
      if (request === undefined) throw new Error("Docker API request transport missing");
      // Only the shared network name is overridden for concurrent-run isolation.
      const plan = {
        ...planned,
        networking: {
          ...networking,
          sharedNetworkMembership: {
            name: sharedNetworkName,
            aliases: networking.sharedNetworkMembership?.aliases ?? {},
          },
        },
      };
      try {
        // When: the real planner output goes through the provider's create path.
        await Effect.runPromise(Effect.scoped(provider.apply(plan, { reconcile: true })));
        const hostsResult = await Effect.runPromise(
          provider.exec(
            { app: plan.id, service, plan },
            {
              command: [
                "node",
                "-e",
                'const rows = require("node:fs").readFileSync("/etc/hosts", "utf8").trim().split("\\n"); const aliases = rows.flatMap(row => { const [ip, ...hosts] = row.split(/\\s+/); return hosts.filter(host => ["host.lando.internal", "custom.internal"].includes(host.toLowerCase())).map(hostname => ({hostname, ip})); }); process.stdout.write(JSON.stringify(aliases));',
              ],
            },
          ),
        );
        expect(hostsResult.exitCode).toBe(0);
        const hosts = Schema.decodeUnknownSync(
          Schema.Array(Schema.Struct({ hostname: Schema.String, ip: Schema.String })),
        )(JSON.parse(hostsResult.stdout));
        const gatewayHosts = hosts.filter(({ hostname }) => hostname.toLowerCase() === "host.lando.internal");
        expect(gatewayHosts.length).toBeGreaterThan(0);
        for (const host of gatewayHosts) {
          expect(host).toEqual({
            hostname: "host.lando.internal",
            ip: expect.not.stringMatching(/^192\.0\.2\.99$|^2001:db8::99$/),
          });
        }
        expect(hosts.filter(({ hostname }) => hostname === "custom.internal")).toEqual([
          { hostname: "custom.internal", ip: "192.0.2.10" },
          { hostname: "custom.internal", ip: "192.0.2.11" },
          { hostname: "custom.internal", ip: "2001:db8::10" },
          { hostname: "custom.internal", ip: "2001:db8::11" },
        ]);
        const outcomes = [];
        for (const host of ['"host.lando.internal"', "process.env.LANDO_HOST_IP"]) {
          const attempts: Array<{
            readonly exitCode: number;
            readonly stdout: string;
            readonly stderr: string;
          }> = [];
          const outcome = await Effect.runPromise(
            runProbe(
              {
                id: host,
                policy: { maxAttempts: 6, delay: Duration.millis(250), timeout: Duration.seconds(12) },
              },
              provider
                .exec(
                  { app: plan.id, service, plan },
                  {
                    command: [
                      "node",
                      "-e",
                      `const host = ${host}; const port = ${listener.port}; const detail = e => ({message: e.message, address: e.address, code: e.code, port: e.port, errors: e.errors?.map(detail)}); const s = require("node:net").connect({host, port}); s.setTimeout(1500, () => s.destroy(Object.assign(new Error("TCP timeout"), {code: "ETIMEDOUT", address: host, port}))); s.on("data", b => process.stdout.write(b)); s.on("error", e => { process.stderr.write(JSON.stringify({host, port, error: detail(e)}), () => process.exit(1)); });`,
                    ],
                  },
                )
                .pipe(
                  Effect.flatMap((result) => {
                    attempts.push(result);
                    return result.exitCode === 0 && result.stdout === token && result.stderr === ""
                      ? Effect.void
                      : Effect.fail(result);
                  }),
                ),
            ),
          );
          outcomes.push({ host, outcome, attempts });
        }
        // Then: both independent probes received the host response; retain every child failure for diagnosis.
        expect(
          outcomes.map(({ outcome }) => outcome.outcome),
          JSON.stringify(outcomes, null, 2),
        ).toEqual(["green", "green"]);
      } finally {
        try {
          await Effect.runPromise(provider.destroy({ app: plan.id, plan }, { volumes: true }));
        } finally {
          const removed = await Effect.runPromise(
            request({ method: "DELETE", path: `/networks/${encodeURIComponent(sharedNetworkName)}` }),
          );
          expect([204, 404]).toContain(removed.status);
        }
      }
    } finally {
      listener.stop(true);
      await rm(stateDir, { recursive: true, force: true });
    }
  },
  120_000,
);
