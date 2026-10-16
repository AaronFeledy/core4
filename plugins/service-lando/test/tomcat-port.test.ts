import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Schema } from "effect";

import { buildContainerArtifact } from "@lando/container-runtime/image-build";
import { AbsolutePath, AppId, type AppPlan, ServiceConfig } from "@lando/sdk/schema";
import type { ServiceType } from "@lando/sdk/services";
import { TOMCAT_CATALOG } from "../src/services/generated/tomcat-catalog.ts";
import {
  tomcat9ServiceType,
  tomcat10ServiceType,
  tomcat11ServiceType,
  tomcatServiceType,
} from "../src/services/tomcat.ts";
import { composeServicePlan } from "./support/compose-harness.ts";

const planTomcat = (definition: unknown, serviceType: ServiceType = tomcatServiceType) =>
  composeServicePlan({
    serviceType,
    service: Schema.decodeUnknownSync(ServiceConfig)(definition),
    appRoot: "/srv/apps/tomcat",
    metadata: { resolvedAt: "2026-10-15T00:00:00Z", source: "/srv/apps/tomcat/.lando.yml", runtime: 4 },
  });

const BuildSteps = Schema.Struct({
  buildSteps: Schema.Array(Schema.Struct({ id: Schema.String, command: Schema.Unknown })),
});
const listenerStep = (plan: Awaited<ReturnType<typeof planTomcat>>) =>
  Schema.decodeUnknownSync(BuildSteps)(plan.extensions["@lando/core/service-features"]).buildSteps.find(
    ({ id }) => id === "service-lando.tomcat:server-config",
  );

const runListenerStep = async (port?: number, serviceType = tomcatServiceType) => {
  const home = await mkdtemp(join(tmpdir(), "lando-tomcat-port-"));
  try {
    await mkdir(join(home, "conf"));
    const path = join(home, "conf/server.xml");
    await Bun.write(path, "unrelated image config");
    const plan = await planTomcat(
      { type: serviceType.id, ...(port === undefined ? {} : { port }) },
      serviceType,
    );
    const step = listenerStep(plan);
    expect(step).toBeDefined();
    if (step === undefined) throw new Error("Tomcat listener build step missing");
    const process = Bun.spawn([...Schema.decodeUnknownSync(Schema.Array(Schema.String))(step.command)], {
      env: { ...Bun.env, CATALINA_HOME: home },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([process.exited, new Response(process.stderr).text()]);
    return { exitCode, stderr, xml: await Bun.file(path).text(), plan };
  } finally {
    await rm(home, { recursive: true, force: true });
  }
};

describe("Tomcat authored HTTP port", () => {
  test("renders the listener build step through the provider Dockerfile boundary", async () => {
    // Given: the real service plan and an image-build API response.
    const service = await planTomcat({ type: "tomcat", port: 9090 });
    const plan: AppPlan = {
      id: AppId.make("tomcat-build"),
      name: "tomcat-build",
      slug: "tomcat-build",
      root: AbsolutePath.make("/srv/apps/tomcat"),
      provider: service.provider,
      services: { [service.name]: service },
      routes: [],
      networks: [],
      stores: [],
      fileSync: [],
      metadata: service.metadata,
      extensions: {},
    };
    // When: the provider serializes every derived build step into Dockerfile RUN instructions.
    const result = Effect.runPromise(
      buildContainerArtifact(
        { app: plan.id, service: service.name, plan, buildKey: "tomcat-port" },
        {
          providerId: service.provider,
          api: { request: () => Effect.succeed({ status: 200, body: '{"Config":{"User":"root"}}' }) },
        },
      ),
    );
    // Then: the generated command is accepted, rather than rejected for control characters.
    await expect(result).resolves.toMatchObject({ providerId: service.provider });
  });

  test.skipIf(process.platform === "win32").each([undefined, 8080, 9090, 65535])(
    "bakes the owned configuration at port %s",
    async (port) => {
      // Given: an owned catalog image, including the omitted-port path.
      const selectedPort = port ?? 8080;
      // When: the generated build command runs against server.xml.
      const result = await runListenerStep(port);
      // Then: the full reviewed configuration is baked, matching the plan.
      expect(result.exitCode).toBe(0);
      expect(result.xml).toBe(TOMCAT_CATALOG["11"].serverXml.replace("{{HTTP_PORT}}", String(selectedPort)));
      expect(result.plan.endpoints).toContainEqual({
        _tag: "internal",
        port: selectedPort,
        protocol: "http",
        name: "web",
      });
      expect(result.plan.healthcheck?.command).toEqual([
        "bash",
        "-c",
        `exec 3<>/dev/tcp/127.0.0.1/${selectedPort}`,
      ]);
    },
  );

  test.each([
    ["tomcat:9", TOMCAT_CATALOG["9"].image, tomcat9ServiceType],
    ["tomcat:10", TOMCAT_CATALOG["10"].image, tomcat10ServiceType],
    ["tomcat:11", TOMCAT_CATALOG["11"].image, tomcat11ServiceType],
  ] as const)("owns the planner-stamped catalog image for %s", async (type, image, serviceType) => {
    // Given / When: a versioned catalog image stamped into the service by the planner.
    const plan = await planTomcat({ type, image, port: 9090 }, serviceType);
    // Then: the paired configuration still belongs to Lando.
    expect(listenerStep(plan)).toBeDefined();
    const command = Schema.decodeUnknownSync(Schema.Array(Schema.String))(listenerStep(plan)?.command);
    expect(command[4]).toContain('<Connector port="9090" protocol="HTTP/1.1"');
    const active = command[4]?.replace(/<!--[\s\S]*?-->/gu, "");
    expect(active?.includes('maxParameterCount="1000"')).toBe(type !== "tomcat:11");
  });

  test.each([
    { type: "tomcat", image: "tomcat:11-jre21", port: 9090 },
    { type: "tomcat", image: "acme/tomcat:custom", port: 9090 },
    { type: "tomcat", build: { context: "." }, port: 9090 },
  ])("leaves the connector alone for %j", async (definition) => {
    // Given / When: an author-owned image configuration.
    const plan = await planTomcat(definition);
    // Then: no listener mutation is scheduled.
    expect(listenerStep(plan)).toBeUndefined();
  });

  test("preserves authored process fields when it moves the catalog listener", async () => {
    // Given: a catalog service with an explicit launcher and debug command.
    const command = ["catalina.sh", "jpda", "run"];
    const entrypoint = ["/custom-entrypoint"];
    // When: its authored port is planned.
    const plan = await planTomcat({ type: "tomcat", port: 9090, command, entrypoint });
    // Then: the build edit does not replace the author's process.
    expect(listenerStep(plan)).toBeDefined();
    expect(plan.command).toEqual(command);
    expect(plan.entrypoint).toEqual(entrypoint);
  });
});
