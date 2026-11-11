import { describe, expect, test } from "bun:test";
import { createServer as createHttpServer } from "node:http";
import { makeDockerApiClient } from "@lando/provider-docker";
import { AbsolutePath, AppId, type AppPlan } from "@lando/sdk/schema";
import { RuntimeProvider } from "@lando/sdk/services";
import { runProviderContract } from "@lando/sdk/test";
import { Effect } from "effect";
import { metadata, providerId, serviceName } from "./support/contract-plan.ts";
import { makeProviderLayer } from "./support/contract-provider-layer.ts";

const makeAliasProbePlan = (): AppPlan => ({
  valueModel: 1,
  id: AppId.make("windows-host-alias-docker"),
  name: "Windows Host Alias Docker",
  slug: "windows-host-alias-docker",
  root: AbsolutePath.make("/tmp/lando-windows-host-alias-docker"),
  provider: providerId,
  services: {
    [serviceName]: {
      name: serviceName,
      type: "node",
      provider: providerId,
      primary: true,
      artifact: { kind: "ref", ref: "node:22-alpine" },
      command: ["node", "-e", "setInterval(() => {}, 1000)"],
      environment: {},
      mounts: [],
      endpoints: [],
      routes: [],
      dependsOn: [],
      hostAliases: [],
      metadata,
      extensions: {},
    },
  },
  routes: [],
  stores: [],
  fileSync: [],
  metadata,
  extensions: {},
});

const startLoopbackAuthServer = async (expectedToken: string) => {
  let observedAuthorization = "";
  const server = createHttpServer((request, response) => {
    observedAuthorization = request.headers.authorization ?? "";
    response.writeHead(observedAuthorization === `Bearer ${expectedToken}` ? 200 : 401);
    response.end(observedAuthorization === `Bearer ${expectedToken}` ? "alias-ok" : "alias-denied");
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") reject(new Error("expected TCP listener"));
      else resolve(address.port);
    });
  });
  return {
    port,
    authorization: () => observedAuthorization,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};

const aliasProbeScript = `
const response = await fetch(process.env.LANDO_ALIAS_PROBE_URL, {
  headers: { authorization: \`Bearer \${process.env.LANDO_ALIAS_PROBE_TOKEN}\` },
});
const body = await response.text();
if (response.status !== 200 || body !== "alias-ok") {
  console.error(\`unexpected alias response \${response.status}: \${body}\`);
  process.exit(1);
}
console.log(body);
`;

describe("provider-docker RuntimeProvider contract", () => {
  test.skipIf(!process.env.LANDO_TEST_DOCKER_SOCKET && !process.env.DOCKER_HOST)(
    "runs the provider contract suite against a live Docker Engine socket",
    async () => {
      const dockerHost = process.env.LANDO_TEST_DOCKER_SOCKET ?? process.env.DOCKER_HOST;
      expect(dockerHost).toBeTruthy();

      const provider = await Effect.runPromise(
        RuntimeProvider.pipe(
          Effect.provide(
            makeProviderLayer({ platform: "linux", dockerApi: makeDockerApiClient(dockerHost ?? "") }),
          ),
        ),
      );

      await Effect.runPromise(runProviderContract(provider));
    },
    60_000,
  );

  test.skipIf(
    process.platform !== "win32" ||
      (!process.env.LANDO_TEST_WINDOWS_DOCKER_SOCKET && !process.env.DOCKER_HOST),
  )(
    "runs the provider contract suite against a live Windows Docker Desktop socket",
    async () => {
      const dockerHost = process.env.LANDO_TEST_WINDOWS_DOCKER_SOCKET ?? process.env.DOCKER_HOST;
      expect(dockerHost).toBeTruthy();

      const provider = await Effect.runPromise(
        RuntimeProvider.pipe(
          Effect.provide(
            makeProviderLayer({
              platform: "win32",
              dockerApi: makeDockerApiClient(dockerHost ?? ""),
            }),
          ),
        ),
      );

      expect(provider.capabilities.bindMountPerformance).toBe("slow");
      await Effect.runPromise(runProviderContract(provider));
    },
    60_000,
  );

  test.skipIf(
    process.platform !== "win32" ||
      (!process.env.LANDO_TEST_WINDOWS_DOCKER_SOCKET && !process.env.DOCKER_HOST),
  )(
    "live: Windows Docker Desktop container reaches host loopback through host.docker.internal",
    async () => {
      const dockerHost = process.env.LANDO_TEST_WINDOWS_DOCKER_SOCKET ?? process.env.DOCKER_HOST;
      expect(dockerHost).toBeTruthy();
      const token = "docker-alias-token";
      const server = await startLoopbackAuthServer(token);
      const provider = await Effect.runPromise(
        RuntimeProvider.pipe(
          Effect.provide(
            makeProviderLayer({
              platform: "win32",
              dockerApi: makeDockerApiClient(dockerHost ?? ""),
            }),
          ),
        ),
      );
      const aliasPlan = makeAliasProbePlan();

      try {
        await Effect.runPromise(Effect.scoped(provider.apply(aliasPlan, { reconcile: true })));
        const result = await Effect.runPromise(
          provider.exec(
            { app: aliasPlan.id, service: serviceName },
            {
              command: ["node", "-e", aliasProbeScript],
              env: {
                LANDO_ALIAS_PROBE_URL: `http://host.docker.internal:${server.port}/probe`,
                LANDO_ALIAS_PROBE_TOKEN: token,
              },
            },
          ),
        );

        expect(result).toEqual({ exitCode: 0, stdout: "alias-ok\n", stderr: "" });
        expect(server.authorization()).toBe(`Bearer ${token}`);
      } finally {
        await Effect.runPromise(Effect.result(provider.destroy({ app: aliasPlan.id }, { volumes: true })));
        await server.close();
      }
    },
    120_000,
  );
});
