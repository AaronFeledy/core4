import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineHttpApi, EngineHttpRequest } from "@lando/container-runtime/engine-api";
import {
  makeOwnedResourcesCleanup,
  makeResourceOwnershipStore,
} from "@lando/container-runtime/provider-assembly";
import { makePluginStateStore } from "@lando/engine/plugins/context-state";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  ProviderId,
  ServiceName,
  appIdentityKey,
} from "@lando/sdk/schema";
import { makeStateStore } from "@lando/state-store/service";
import { DateTime, Effect } from "effect";
import { ownerOnlyFileAccess } from "./private-file-access.ts";

export const withInventory = async <A>(use: (fixture: ReturnType<typeof fixtureAt>) => Promise<A>) => {
  const directory = await mkdtemp(join(tmpdir(), "ownership-test-"));
  try {
    return await use(fixtureAt(directory));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

const fixtureAt = (directory: string) => {
  const root = AbsolutePath.make(directory);
  const stateRoot = AbsolutePath.make(join(directory, "plugin-state"));
  const state = makePluginStateStore(
    makeStateStore({ privateFileAccess: ownerOnlyFileAccess }),
    stateRoot,
    ownerOnlyFileAccess,
  );
  const store = makeResourceOwnershipStore("docker", state);
  const plan: AppPlan = {
    valueModel: 1,
    id: AppId.make("owned"),
    slug: "owned",
    name: "owned",
    root,
    identity: { appRoot: root, ownerKey: appIdentityKey("owner", root) },
    provider: ProviderId.make("docker"),
    services: {},
    networks: [],
    stores: [],
    routes: [],
    fileSync: [],
    extensions: {},
    metadata: { source: "ownership-test", runtime: 4, resolvedAt: DateTime.makeUnsafe(0) },
  };
  const calls: EngineHttpRequest[] = [];
  const observations = new Map<string, object>();
  let deleteStatus = 204;
  const api: EngineHttpApi = {
    request: (request) =>
      Effect.sync(() => {
        calls.push(request);
        if (request.method === "DELETE") return { status: deleteStatus, body: "" };
        const observation = observations.get(request.path);
        return observation === undefined
          ? { status: 404, body: "" }
          : { status: 200, body: JSON.stringify(observation) };
      }),
  };
  const cleanup = makeOwnedResourcesCleanup({
    store,
    api,
    ctx: { providerId: "docker", remediation: "Retry cleanup." },
  });
  const path = join(stateRoot, "resource-ownership", `${plan.identity?.ownerKey}.json`);
  const network = (appId = plan.id) => ({
    Id: `network-${appId}`,
    Labels: {
      "dev.lando.app": appId,
      "dev.lando.app-root": root,
      "dev.lando.owner": plan.identity?.ownerKey ?? "",
      "dev.lando.provider": "docker",
    },
  });
  return {
    root,
    state,
    store,
    plan,
    calls,
    observations,
    cleanup,
    path,
    network,
    setDeleteStatus: (status: number) => {
      deleteStatus = status;
    },
  };
};

export const webFor = (plan: AppPlan): AppPlan => ({
  ...plan,
  services: {
    [ServiceName.make("web")]: {
      name: ServiceName.make("web"),
      type: "node",
      provider: plan.provider,
      primary: true,
      artifact: { kind: "ref", ref: "node:22" },
      command: [],
      environment: { PRIVATE: "never-persist-this" },
      mounts: [],
      storage: [],
      endpoints: [],
      routes: [],
      dependsOn: [],
      hostAliases: [],
      metadata: plan.metadata,
      extensions: {},
    },
  },
});
