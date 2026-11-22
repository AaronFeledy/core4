import { expect, test } from "bun:test";
import { realpath } from "node:fs/promises";
import { invokeOperation } from "@lando/core/cli/operations";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import { AbsolutePath, ServiceName, appIdentityKey } from "@lando/sdk/schema";
import { AppPlanner, LandofileService, RuntimeProviderRegistry } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Cause, Effect, Layer } from "effect";
import { type OpenAppOptions, openApp } from "../../../src/cli/commands/open.ts";
import { collectOpenConnections } from "../../../src/cli/commands/open-connections.ts";
import { runOpenForHostProxy } from "../../../src/cli/host-proxy/dispatch.ts";
import {
  commandServices,
  makePlan,
  route,
  silentEventLayer,
} from "../../_support/host-proxy-open-fixtures.ts";

const fixture = async (failedService = "mailpit") => {
  const appRoot = AbsolutePath.make(await realpath(process.cwd()));
  const plan = {
    ...makePlan(
      [
        route({ hostname: "web.myapp.lndo.site", scheme: "https", service: "web" }),
        route({ hostname: "mailpit.myapp.lndo.site", scheme: "https", service: "mailpit" }),
      ],
      ["web", "mailpit"],
    ),
    root: appRoot,
    identity: { appRoot, ownerKey: appIdentityKey("owner", appRoot) },
  };
  const inspected: string[] = [];
  const failure = new ProviderUnavailableError({
    providerId: "test",
    operation: "inspect",
    message: "inspection failed",
    remediation: "Repair runtime.",
  });
  const provider = {
    ...TestRuntimeProvider,
    inspect: (target: Parameters<typeof TestRuntimeProvider.inspect>[0]) => {
      inspected.push(String(target.service));
      if (target.service === failedService)
        return Effect.failCause(
          Cause.combine(Cause.fail(failure), Cause.die(new Error("inspection cleanup failed"))),
        );
      return Effect.succeed({
        app: target.app,
        service: target.service,
        providerId: plan.provider,
        status: "running" as const,
        publications: { status: "present" as const, bindings: [] },
      });
    },
  };
  const services = commandServices(silentEventLayer(), 4433, provider);
  const publicServices = Layer.mergeAll(
    services,
    Layer.succeed(AppPlanner, AppPlanner.of({ plan: () => Effect.die("must use applied plan") })),
    Layer.succeed(LandofileService, LandofileService.of({ discover: Effect.die("must use applied plan") })),
    Layer.succeed(
      RuntimeProviderRegistry,
      RuntimeProviderRegistry.of({
        readAppliedPlanStrict: () => Effect.succeed(undefined),
        appliedStateInventory: () => Effect.succeed({ plans: [], unreadable: [] }),
        list: Effect.succeed([plan.provider]),
        capabilities: Effect.succeed(provider.capabilities),
        resolveAppliedPlan: () => Effect.succeed(plan),
        appliedPlansFor: () => Effect.succeed([plan]),
        resolveTeardownEvidence: () => Effect.succeed({ kind: "applied" as const, plan }),
        select: () => Effect.succeed(provider),
      }),
    ),
  );
  return { plan, inspected, services, publicServices, failure };
};

const selections: readonly OpenAppOptions[] = [
  {},
  { service: "web" },
  { service: "web", all: true },
  { route: "web.myapp.lndo.site", service: "mailpit" },
];

test.each([...selections])("public open isolates selected observations: %j", async (selection) => {
  // Given a healthy selected service and a sibling whose inspection fails.
  const { inspected, publicServices } = await fixture();
  // When the public operation resolves the applied app.
  const result = await Effect.runPromise(
    invokeOperation(openApp({ ...selection, print: true })).pipe(Effect.provide(publicServices)),
  );
  // Then only the selected service contributes actual observations.
  expect(result).toMatchObject({
    ok: true,
    value: { targets: [{ service: "web", url: "https://web.myapp.lndo.site:4433" }] },
  });
  expect(inspected).toEqual(["web"]);
});

test.each([...selections])("host-proxy open isolates selected observations: %j", async (selection) => {
  // Given
  const { plan, inspected, services } = await fixture();
  const argv = ["open", "--print"];
  if (selection.service !== undefined) argv.push("--service", selection.service);
  if (selection.route !== undefined) argv.push("--route", selection.route);
  if (selection.all === true) argv.push("--all");
  // When
  const result = await Effect.runPromise(
    runOpenForHostProxy(plan, { commandId: "app:open", argv, cwd: plan.root, tty: false, env: {} }).pipe(
      Effect.provide(services),
    ),
  );
  // Then
  expect(result).toMatchObject({
    exitCode: 0,
    envelope: {
      ok: true,
      result: { targets: [{ service: "web", url: "https://web.myapp.lndo.site:4433" }] },
    },
  });
  expect(inspected).toEqual(["web"]);
});

test.each([{ service: "missing" }, { route: "missing.test", service: "web" }])(
  "missing open target avoids unrelated inspection: %j",
  async (selection) => {
    // Given
    const { inspected, publicServices } = await fixture();
    // When
    const result = await Effect.runPromise(
      invokeOperation(openApp({ ...selection, print: true })).pipe(Effect.provide(publicServices)),
    );
    // Then
    expect(result).toMatchObject({ ok: false, error: { _tag: "OpenTargetUnresolvedError" } });
    expect(inspected).toEqual([]);
  },
);

test.each([{}, { all: true }, { service: "web" }])(
  "required inspection failure remains visible: %j",
  async (selection) => {
    // Given
    const { publicServices, failure } = await fixture("web");
    // When
    const result = await Effect.runPromise(
      invokeOperation(openApp({ ...selection, print: true }), {
        isError: (error) => error instanceof ProviderUnavailableError,
        renderError: (error) => error.message,
      }).pipe(Effect.provide(publicServices)),
    );
    // Then
    expect(result).toMatchObject({
      ok: false,
      output: failure.message,
      additionalErrors: [{ role: "peer", error: { message: "inspection cleanup failed" } }],
    });
    if (result.ok) throw new Error("expected inspection failure");
    expect(result.error).toBe(failure);
  },
);

test.each(["--service", "--route"])("host-proxy missing %s avoids unrelated inspection", async (flag) => {
  // Given
  const { plan, inspected, services } = await fixture();
  // When
  const result = await Effect.runPromise(
    runOpenForHostProxy(plan, {
      commandId: "app:open",
      argv: ["open", "--print", flag, "missing"],
      cwd: plan.root,
      tty: false,
      env: {},
    }).pipe(Effect.provide(services)),
  );
  // Then
  expect(result).toMatchObject({ exitCode: 1, envelope: { error: { _tag: "OpenTargetUnresolvedError" } } });
  expect(inspected).toEqual([]);
});

test("host-proxy selected failure retains its cleanup defect", async () => {
  // Given
  const { plan, services } = await fixture("web");
  // When
  const result = await Effect.runPromise(
    runOpenForHostProxy(plan, {
      commandId: "app:open",
      argv: ["open", "--service", "web", "--print"],
      cwd: plan.root,
      tty: false,
      env: {},
    }).pipe(Effect.provide(services)),
  );
  // Then
  expect(result).toMatchObject({
    exitCode: 1,
    envelope: {
      error: {
        _tag: "ProviderUnavailableError",
        additionalErrors: [
          { _tag: "LandoInternalError", role: "peer", message: "inspection cleanup failed" },
        ],
      },
    },
  });
});

test.each([{}, { all: true }])("open skips ineligible sibling observations: %j", async (selection) => {
  // Given
  const { plan, publicServices } = await fixture();
  const services = Object.fromEntries(
    Object.entries(plan.services).map(([name, service]) => [
      name,
      name === "mailpit" ? { ...service, endpoints: [] } : service,
    ]),
  );
  // When
  const result = await Effect.runPromise(
    collectOpenConnections(
      { ...plan, services, routes: plan.routes.filter((route) => route.service === "web") },
      selection,
    ).pipe(Effect.provide(publicServices)),
  );
  // Then
  expect(result.map((row) => row.name)).toEqual(["web"]);
});

test("scoped observations retain completion intent from the full plan", async () => {
  // Given a selected one-shot whose dependent is outside the observation scope.
  const { plan } = await fixture();
  const services = Object.fromEntries(
    Object.entries(plan.services).map(([name, service]) => [
      name,
      name === "mailpit"
        ? {
            ...service,
            dependsOn: [
              {
                service: ServiceName.make("web"),
                condition: "service_completed_successfully" as const,
                required: true,
              },
            ],
          }
        : service,
    ]),
  );
  const provider = {
    ...TestRuntimeProvider,
    inspect: (target: Parameters<typeof TestRuntimeProvider.inspect>[0]) =>
      Effect.succeed({
        app: target.app,
        service: target.service,
        providerId: plan.provider,
        status: "exited" as const,
        exitCode: 0,
        publications: { status: "present" as const, bindings: [] },
      }),
  };
  // When
  const result = await Effect.runPromise(
    collectOpenConnections({ ...plan, services }, { service: "web" }).pipe(
      Effect.provide(commandServices(silentEventLayer(), 4433, provider)),
    ),
  );
  // Then
  expect(result).toMatchObject([{ name: "web", state: "completed" }]);
  expect(result[0]?.connections.every((connection) => connection.state !== "active")).toBe(true);
});

test("does not skip a service whose only route targets its generated HTTPS listener", async () => {
  // Given: the first service keeps an HTTP primary plus the generated HTTPS
  // listener, and its only route targets the HTTPS listener.
  const { plan, publicServices, inspected } = await fixture("nobody");
  const web = plan.services[ServiceName.make("web")];
  const mailpit = plan.services[ServiceName.make("mailpit")];
  if (web === undefined || mailpit === undefined) throw new Error("fixture services missing");
  const scoped = {
    ...plan,
    services: {
      [ServiceName.make("web")]: {
        ...web,
        endpoints: [
          {
            kind: "internal" as const,
            protocol: "http" as const,
            port: 80,
            name: "web",
            primary: true as const,
          },
          { kind: "internal" as const, protocol: "https" as const, port: 443, name: "web-https" },
        ],
        certs: { cn: "web.nobody.internal", sans: ["web.nobody.internal"], caId: "mkcert" },
      },
      [ServiceName.make("mailpit")]: mailpit,
    },
    routes: [
      {
        hostname: "web.myapp.lndo.site",
        priority: 2,
        scheme: "https" as const,
        service: ServiceName.make("web"),
        backend: { service: ServiceName.make("web"), protocol: "https" as const, port: 443 },
      },
      {
        hostname: "mailpit.myapp.lndo.site",
        priority: 2,
        scheme: "https" as const,
        service: ServiceName.make("mailpit"),
        backend: { service: ServiceName.make("mailpit"), protocol: "http" as const, port: 80 },
      },
    ],
  };
  // When
  const rows = await Effect.runPromise(
    collectOpenConnections(scoped, {}).pipe(Effect.provide(publicServices)),
  );
  // Then: the primary service is inspected for its generated HTTPS route
  // instead of being skipped for not targeting the plain primary listener.
  expect(inspected[0]).toBe("web");
  expect(rows.some((row) => String(row.name) === "web")).toBe(true);
});
