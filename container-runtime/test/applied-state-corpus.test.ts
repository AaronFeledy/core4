// Historical bytes written by origin/main 140f4828f (v3) and the pinned old writer (v7).
// Never regenerate these fixture files from the code under test.
// Each future state-version bump adds a new snapshot alongside this corpus.
import { expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { APPLIED_STATE_VERSION, makeAppliedPlanStore } from "@lando/container-runtime/applied-state";
import { AbsolutePath, AppId, ServiceName } from "@lando/sdk/schema";
import { makePluginStateStore } from "@lando/state-store/plugin";
import { makeStateStore } from "@lando/state-store/service";
import { Effect } from "effect";

const v3Fixtures = join(import.meta.dir, "fixtures/applied-state-v3");
const v7Fixtures = join(import.meta.dir, "fixtures/applied-state-v7");
const access = { enforce: async () => undefined, verify: async () => undefined };

const openState = (root: string) =>
  makePluginStateStore(makeStateStore({ privateFileAccess: access }), AbsolutePath.make(root), access);

const expectMigratedNetworkVocabulary = (plan: {
  readonly services: Readonly<Record<string, { readonly endpoints: readonly unknown[] }>>;
  readonly routes: readonly { readonly filters?: readonly unknown[]; readonly hostname: string }[];
  readonly extensions?: Readonly<Record<string, unknown>>;
}) => {
  const web = plan.services[ServiceName.make("web")];
  expect(web?.endpoints).toEqual([
    {
      kind: "internal",
      protocol: "http",
      port: 8080,
      name: "Web.ui",
      scan: { path: "/health" },
    },
    {
      kind: "published",
      protocol: "http",
      port: 8080,
      publication: { hostPort: 18080 },
    },
    {
      kind: "internal",
      protocol: "unix",
      socketPath: "/run/demo.sock",
    },
  ]);
  expect(plan.routes[0]?.filters).toEqual([
    { kind: "stripPrefix", prefix: "/old" },
    { kind: "addPrefix", prefix: "/new" },
    {
      kind: "requestHeader",
      name: "merge-request",
      header: "X-Request",
      value: 'yes: "quoted"\nnext',
    },
    {
      kind: "responseHeader",
      name: "merge-response",
      header: "X-Response",
      value: "false",
    },
    {
      kind: "redirect",
      to: "https://example.com/new?q=one#two",
      permanent: true,
    },
  ]);
  expect(plan.routes.slice(1).every((route) => route.filters === undefined)).toBe(true);
  // Opaque extension payload keeps its own historical keys; migration never rewrites it.
  expect(plan.extensions?.opaque).toEqual({ _tag: "internal", type: "redirect" });
};

// The historical plugin contributed both aliases via ServiceFeatureContext.addHostAlias.
// Main's authored hostnames validator rejected these spellings, but its plan schema did not.
for (const file of new Bun.Glob("**/*.json").scanSync(v3Fixtures)) {
  test(`reads historical v3 ${file} through the applied-state store`, async () => {
    const root = await mkdtemp(join(tmpdir(), "lando-state-corpus-"));
    const record = file.endsWith("applied-plans.json");
    const target = join(root, record ? "applied-plans.json" : "applied-plans/historical.json");
    try {
      await mkdir(dirname(target), { recursive: true });
      await copyFile(join(v3Fixtures, file), target);
      const state = openState(root);
      const store = record
        ? makeAppliedPlanStore({ providerId: "podman", layout: "record" })
        : makeAppliedPlanStore({ providerId: "docker", layout: "per-app" });

      const read = await Effect.runPromise(store.inspectAppliedPlan(state, AppId.make("historical")));

      expect(read.status).toBe("readable");
      if (read.status !== "readable") throw new Error(`Historical state is ${read.status}`);
      expect(Object.keys(read.plan.services)).toEqual(["web", "worker"]);
      expect(read.plan.root).toBe(AbsolutePath.make("/srv/apps/historical"));
      expect(read.plan.routes.map(({ hostname, scheme }) => ({ hostname, scheme }))).toEqual([
        { hostname: "exact.lndo.site", scheme: "https" },
        { hostname: "*.x.lndo.site", scheme: "https" },
        { hostname: "*-x.lndo.site", scheme: "https" },
        { hostname: "wild.*.x.lndo.site", scheme: "http" },
      ]);
      for (const service of Object.values(read.plan.services)) {
        expect(service.hostAliases).toEqual([
          { hostname: "valid_alias", ip: "127.0.0.2" },
          { hostname: "host.lando.internal", ip: "host-gateway" },
        ]);
      }
      expect(read.plan.services[ServiceName.make("web")]?.certs).toEqual({
        cn: "web.historical.internal",
        sans: [
          "web",
          "web.historical.internal",
          "exact.lndo.site",
          "*.x.lndo.site",
          "*.lndo.site",
          "localhost",
          "127.0.0.1",
        ],
        caId: "test",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

const v7Cases = [
  {
    name: "lando/applied-plans/historical.json",
    source: join(v7Fixtures, "lando/applied-plans/historical.json"),
    target: "applied-plans/historical.json",
    providerId: "lando" as const,
    layout: "per-app" as const,
    appId: "historical",
  },
  {
    name: "podman/applied-plans.json",
    source: join(v7Fixtures, "podman/applied-plans.json"),
    target: "applied-plans.json",
    providerId: "podman" as const,
    layout: "record" as const,
    appId: "historical",
  },
] as const;

for (const fixture of v7Cases) {
  test(`reads old-writer v7 ${fixture.name} without rewriting the fixture bytes`, async () => {
    const root = await mkdtemp(join(tmpdir(), "lando-state-v7-"));
    const target = join(root, fixture.target);
    try {
      await mkdir(dirname(target), { recursive: true });
      await copyFile(fixture.source, target);
      const before = await readFile(target);
      const state = openState(root);
      const store =
        fixture.layout === "record" ? makeAppliedPlanStore(fixture) : makeAppliedPlanStore(fixture);

      const read = await Effect.runPromise(store.inspectAppliedPlan(state, AppId.make(fixture.appId)));

      expect(read.status).toBe("readable");
      if (read.status !== "readable") throw new Error(`v7 state is ${read.status}`);
      expect(Object.keys(read.plan.services)).toEqual(["web", "worker"]);
      expect(read.plan.root).toBe(AbsolutePath.make(`/srv/apps/${fixture.appId}`));
      expectMigratedNetworkVocabulary(read.plan);
      // Read-time migration is in-memory only: the durable envelope stays v7 with old keys.
      expect(Buffer.compare(await readFile(target), before)).toBe(0);
      const onDisk = JSON.parse(before.toString("utf8")) as { version: number; data: unknown };
      expect(onDisk.version).toBe(7);
      expect(JSON.stringify(onDisk)).toContain('"_tag"');
      expect(JSON.stringify(onDisk)).toContain('"type":"stripPrefix"');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`ordinary persist of v7 ${fixture.name} writes one v8 envelope with kind keys`, async () => {
    const root = await mkdtemp(join(tmpdir(), "lando-state-v7-write-"));
    const target = join(root, fixture.target);
    try {
      await mkdir(dirname(target), { recursive: true });
      await copyFile(fixture.source, target);
      const state = openState(root);
      const store =
        fixture.layout === "record" ? makeAppliedPlanStore(fixture) : makeAppliedPlanStore(fixture);
      const read = await Effect.runPromise(store.inspectAppliedPlan(state, AppId.make(fixture.appId)));
      expect(read.status).toBe("readable");
      if (read.status !== "readable") throw new Error(`v7 state is ${read.status}`);

      await Effect.runPromise(store.persistAppliedPlan(state, read.plan));

      const envelope = JSON.parse(await readFile(target, "utf8")) as {
        version: number;
        data: Record<string, unknown> | { endpoints?: unknown; routes?: unknown };
      };
      expect(envelope.version).toBe(APPLIED_STATE_VERSION);
      expect(APPLIED_STATE_VERSION).toBe(8);
      const plan =
        fixture.layout === "record"
          ? (
              envelope.data as Record<
                string,
                {
                  services: Record<string, { endpoints: { kind?: string; _tag?: string }[] }>;
                  routes: { filters?: { kind?: string; type?: string }[] }[];
                  extensions?: { opaque?: unknown };
                }
              >
            )[fixture.appId]
          : (envelope.data as {
              services: Record<string, { endpoints: { kind?: string; _tag?: string }[] }>;
              routes: { filters?: { kind?: string; type?: string }[] }[];
              extensions?: { opaque?: unknown };
            });
      if (plan === undefined) throw new Error("missing persisted plan");
      const endpoints = plan.services.web?.endpoints ?? [];
      expect(endpoints.map((endpoint) => endpoint.kind)).toEqual(["internal", "published", "internal"]);
      expect(endpoints.every((endpoint) => endpoint._tag === undefined)).toBe(true);
      const filters = plan.routes[0]?.filters ?? [];
      expect(filters.map((filter) => filter.kind)).toEqual([
        "stripPrefix",
        "addPrefix",
        "requestHeader",
        "responseHeader",
        "redirect",
      ]);
      expect(filters.every((filter) => filter.type === undefined)).toBe(true);
      // Opaque extension payload keeps its own historical keys after an ordinary rewrite.
      expect(plan.extensions?.opaque).toEqual({ _tag: "internal", type: "redirect" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("podman record remove migrates survivors into one v8 map", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-state-v7-survivor-"));
  const target = join(root, "applied-plans.json");
  try {
    await mkdir(root, { recursive: true });
    await copyFile(join(v7Fixtures, "podman/applied-plans.json"), target);
    const state = openState(root);
    const store = makeAppliedPlanStore({ providerId: "podman", layout: "record" });

    await Effect.runPromise(store.removeAppliedPlan(state, AppId.make("historical")));

    const envelope = JSON.parse(await readFile(target, "utf8")) as {
      version: number;
      data: Record<
        string,
        {
          id: string;
          root: string;
          services: Record<string, { endpoints: { kind?: string; _tag?: string }[] }>;
          routes: { filters?: { kind?: string; type?: string }[] }[];
          extensions?: { opaque?: unknown };
        }
      >;
    };
    expect(envelope.version).toBe(8);
    expect(Object.keys(envelope.data)).toEqual(["survivor"]);
    expect(envelope.data.survivor?.id).toBe("survivor");
    expect(envelope.data.survivor?.root).toBe("/srv/apps/survivor");
    const survivor = envelope.data.survivor;
    if (survivor === undefined) throw new Error("Missing survivor in rewritten map");
    const endpoints = survivor.services.web?.endpoints ?? [];
    expect(endpoints.map((endpoint) => endpoint.kind)).toEqual(["internal", "published", "internal"]);
    expect(endpoints.every((endpoint) => endpoint._tag === undefined)).toBe(true);
    expect(survivor.routes[0]?.filters?.map((filter) => filter.kind)).toEqual([
      "stripPrefix",
      "addPrefix",
      "requestHeader",
      "responseHeader",
      "redirect",
    ]);
    expect(survivor.extensions?.opaque).toEqual({ _tag: "internal", type: "redirect" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each([
  {
    name: "mixed endpoint leaf on a second app",
    mutate: (data: Record<string, unknown>) => {
      const survivor = structuredClone(data.survivor) as {
        services: { web: { endpoints: Record<string, unknown>[] } };
      };
      const endpoint = survivor.services.web.endpoints[0];
      if (endpoint === undefined) throw new Error("missing endpoint");
      survivor.services.web.endpoints[0] = { ...endpoint, kind: "internal" };
      return { ...data, survivor };
    },
  },
  {
    name: "future envelope version",
    version: 99,
  },
  {
    name: "non-record second entry",
    mutate: (data: Record<string, unknown>) => ({ ...data, survivor: "nope" }),
  },
  {
    name: "map key / plan.id mismatch",
    mutate: (data: Record<string, unknown>) => {
      const survivor = structuredClone(data.survivor) as { id: string };
      survivor.id = "other";
      return { ...data, survivor };
    },
  },
] as const)("invalid podman map ($name) stays byte-identical under mutation", async (scenario) => {
  const root = await mkdtemp(join(tmpdir(), "lando-state-v7-invalid-"));
  const target = join(root, "applied-plans.json");
  try {
    const source = JSON.parse(await readFile(join(v7Fixtures, "podman/applied-plans.json"), "utf8")) as {
      version: number;
      data: Record<string, unknown>;
    };
    const payload = {
      version: "version" in scenario && scenario.version !== undefined ? scenario.version : source.version,
      data:
        "mutate" in scenario && scenario.mutate !== undefined ? scenario.mutate(source.data) : source.data,
    };
    await writeFile(target, `${JSON.stringify(payload, null, 2)}\n`);
    const before = await readFile(target);
    const state = openState(root);
    const store = makeAppliedPlanStore({ providerId: "podman", layout: "record" });

    const inspect = await Effect.runPromise(store.inspectAppliedPlan(state, AppId.make("historical")));
    expect(inspect.status).toBe("unreadable");

    const removeFailure = await Effect.runPromise(
      Effect.flip(store.removeAppliedPlan(state, AppId.make("historical"))),
    );
    expect(removeFailure).toMatchObject({
      _tag: "ProviderUnavailableError",
      operation: "applied-state.remove",
    });

    expect(Buffer.compare(await readFile(target), before)).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("current v8 decode rejects old discriminators and never migrates", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-state-v8-old-keys-"));
  const target = join(root, "applied-plans/historical.json");
  try {
    const source = JSON.parse(
      await readFile(join(v7Fixtures, "lando/applied-plans/historical.json"), "utf8"),
    ) as { version: number; data: unknown };
    // Stamp the current version while leaving the old endpoint/filter keys intact.
    await mkdir(dirname(target), { recursive: true });
    await writeFile(
      target,
      `${JSON.stringify({ version: APPLIED_STATE_VERSION, data: source.data }, null, 2)}\n`,
    );
    const before = await readFile(target);
    const state = openState(root);
    const store = makeAppliedPlanStore({ providerId: "lando", layout: "per-app" });

    const read = await Effect.runPromise(store.inspectAppliedPlan(state, AppId.make("historical")));
    expect(read.status).toBe("unreadable");
    expect(Buffer.compare(await readFile(target), before)).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
