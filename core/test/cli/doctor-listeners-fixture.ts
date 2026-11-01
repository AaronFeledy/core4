import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  PortNumber,
  ProviderId,
  ServiceName,
  type ServicePlan,
  appIdentityKey,
} from "@lando/sdk/schema";
import { RuntimeProviderRegistry, type RuntimeProviderShape } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { DateTime, Effect, Layer, Stream } from "effect";
import { withCwd } from "../_support/temp-cwd.ts";

export const tableHeader =
  "  sl  local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode\n";
export const tcpTable = (address?: string) =>
  tableHeader +
  (address === undefined
    ? ""
    : `0: ${address}:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000 0 0 1\n`);
export const listenerOutput = (text: string) =>
  Stream.make({ kind: "stdout" as const, chunk: new TextEncoder().encode(text) }, { exitCode: 0 });

export const withListenerApp = async <A>(run: (plan: AppPlan) => Promise<A>): Promise<A> => {
  const root = await mkdtemp(join(tmpdir(), "lando-doctor-listeners-"));
  try {
    const appRoot = AbsolutePath.make(await realpath(root));
    const identity = { appRoot, ownerKey: appIdentityKey("owner", appRoot) };
    const metadata = {
      resolvedAt: DateTime.makeUnsafe("2026-01-01T00:00:00Z"),
      source: "test",
      runtime: 4 as const,
    };
    const service: ServicePlan = {
      name: ServiceName.make("web"),
      type: "python",
      provider: ProviderId.make("docker"),
      primary: true,
      artifact: { kind: "ref", ref: "python:3" },
      environment: {},
      mounts: [],
      endpoints: [{ _tag: "internal", protocol: "tcp", port: 8080, primary: true }],
      routes: [],
      dependsOn: [],
      hostAliases: [],
      extensions: {},
      metadata,
      listenerAuthority: {
        owner: "application",
        daemon: "python",
        port: PortNumber.make(8080),
        variables: ["PORT", "FLASK_RUN_PORT"],
      },
    };
    const plan: AppPlan = {
      valueModel: 1,
      id: AppId.make("listener-demo"),
      name: "listener-demo",
      slug: "listener-demo",
      root: identity.appRoot,
      identity,
      provider: service.provider,
      services: { [service.name]: service },
      routes: [],
      stores: [],
      fileSync: [],
      metadata,
      extensions: {},
    };
    return await withCwd(root, () => run(plan), [root]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

export const listenerProvider = (
  plan: AppPlan,
  overrides: Partial<RuntimeProviderShape> = {},
): RuntimeProviderShape => ({
  ...TestRuntimeProvider,
  id: String(plan.provider),
  displayName: "Applied Docker",
  version: "1.0.0",
  list: () =>
    Effect.succeed(
      Object.values(plan.services).map((service) => ({
        app: plan.id,
        service: service.name,
        providerId: plan.provider,
        status: "running",
        state: "running",
        containerId: `container-${service.name}`,
        publications: { status: "unknown" as const },
      })),
    ),
  execStream: () => listenerOutput(tcpTable("00000000")),
  ...overrides,
});

export const listenerRegistry = (plan: AppPlan | undefined, provider: RuntimeProviderShape) =>
  Layer.succeed(
    RuntimeProviderRegistry,
    RuntimeProviderRegistry.of({
      resolveAppliedPlan: () => Effect.succeed(plan),
      resolveTeardownEvidence: () => Effect.succeed({ kind: "absent" as const }),
      appliedPlansFor: () => Effect.succeed(plan === undefined ? [] : [plan]),
      list: Effect.succeed([ProviderId.make(provider.id)]),
      capabilities: Effect.succeed(provider.capabilities),
      select: (target) =>
        Effect.succeed(
          typeof target === "object" && target.provider === plan?.provider ? provider : TestRuntimeProvider,
        ),
    }),
  );
