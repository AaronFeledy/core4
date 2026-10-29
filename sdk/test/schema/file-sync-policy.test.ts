import { expect, test } from "bun:test";
import {
  AbsolutePath,
  AppId,
  AppMountInput,
  type FileSyncCoveragePlan,
  FileSyncSessionSpec,
  GlobalConfig,
  PortablePath,
  ServiceName,
  fileSyncVolumeName,
  hasStructuralFileSyncCoverage,
  plannedFileSyncSessions,
} from "@lando/sdk/schema";
import { Schema } from "effect";

test("preserves an explicit acceleration opt-out through strict round trips", () => {
  const decode = Schema.decodeUnknownSync(AppMountInput, { onExcessProperty: "error" });
  const mount = decode({ target: "/app", accelerate: false });
  expect(decode(Schema.encodeSync(AppMountInput)(mount))).toEqual({
    target: "/app",
    accelerate: false,
  });
});

test("rejects an app-local engine selection", () => {
  expect(() =>
    Schema.decodeUnknownSync(AppMountInput, { onExcessProperty: "error" })({
      target: "/app",
      engineId: "alternative",
    }),
  ).toThrow();
});

test("exposes the global no-session policy", () => {
  const config = Schema.decodeUnknownSync(GlobalConfig, { onExcessProperty: "error" })({
    defaultFileSyncEngine: "passthrough",
  });
  expect(Reflect.get(config, "defaultFileSyncEngine")).toBe("passthrough");
});

const appId = AppId.make("coverage-app");
const root = AbsolutePath.make("/repo");
const volume = fileSyncVolumeName("coverage-app", "web", "app-mount");

const baseMounts = [
  {
    type: "bind" as const,
    role: "app" as const,
    source: root,
    target: PortablePath.make("/app"),
    readOnly: false,
    realization: "accelerated" as const,
    excludes: ["node_modules", "vendor"],
    includes: ["vendor"],
    mountKey: "app-mount",
  },
  {
    type: "volume" as const,
    store: "dependencies",
    target: PortablePath.make("/app/node_modules"),
    readOnly: false,
  },
];

const sessionFor = (
  excludes: readonly string[],
  overrides: Partial<{
    source: string;
    root: string;
    id: string;
    mountKey: string;
    mode: string;
    targetName: string;
    permissions: { owner: string };
  }> = {},
) =>
  Schema.decodeUnknownSync(FileSyncSessionSpec)({
    app: {
      kind: "user" as const,
      id: overrides.id ?? appId,
      root: overrides.root ?? root,
    },
    service: ServiceName.make("web"),
    mountKey: overrides.mountKey ?? "app-mount",
    source: overrides.source ?? root,
    target: {
      _tag: "volume" as const,
      name: overrides.targetName ?? volume,
      path: PortablePath.make("/app"),
    },
    mode: overrides.mode ?? ("two-way-safe" as const),
    excludes: [...excludes],
    ...(overrides.permissions === undefined ? {} : { permissions: overrides.permissions }),
  });

const coveragePlan = (input: {
  readonly excludes?: readonly string[];
  readonly sessionOverrides?: Parameters<typeof sessionFor>[1];
  readonly extraEntries?: FileSyncCoveragePlan["fileSync"];
}): FileSyncCoveragePlan => {
  const derived = plannedFileSyncSessions({
    name: "coverage-app",
    services: { web: { mounts: baseMounts } },
  });
  if (derived?.[0] === undefined) throw new Error("expected planned session");
  const excludes = input.excludes ?? derived[0].excludes;
  const session = sessionFor(excludes, input.sessionOverrides);
  return {
    id: appId,
    name: "coverage-app",
    root,
    services: { web: { mounts: baseMounts } },
    fileSync: [
      {
        session,
      },
      ...(input.extraEntries ?? []),
    ],
  };
};

test("requires exact transport patterns for historical coverage", () => {
  const derived = plannedFileSyncSessions({
    name: "coverage-app",
    services: { web: { mounts: baseMounts } },
  });
  expect(derived?.[0]?.excludes).toEqual(["node_modules", ".git"]);

  expect(hasStructuralFileSyncCoverage(coveragePlan({ excludes: [] }))).toBe(false);
  expect(hasStructuralFileSyncCoverage(coveragePlan({}))).toBe(true);
});

test("rejects independent session field and cardinality tampering", () => {
  const valid = coveragePlan({});
  const first = valid.fileSync[0];
  if (first === undefined) throw new Error("expected session");
  const derived = plannedFileSyncSessions(valid);
  if (derived?.[0] === undefined) throw new Error("expected derived session");

  const reject = (
    plan: FileSyncCoveragePlan,
    options?: Parameters<typeof hasStructuralFileSyncCoverage>[1],
  ) => expect(hasStructuralFileSyncCoverage(plan, options)).toBe(false);

  reject(coveragePlan({ excludes: ["node_modules"] }));
  reject(coveragePlan({ excludes: [...derived[0].excludes].reverse() }));
  reject(coveragePlan({ excludes: [] }));
  reject(coveragePlan({ sessionOverrides: { source: "/other" } }));
  reject(coveragePlan({ sessionOverrides: { targetName: "wrong" } }));
  reject(coveragePlan({ sessionOverrides: { mode: "one-way-safe" } }));
  reject(coveragePlan({ sessionOverrides: { permissions: { owner: "node" } } }));
  reject(coveragePlan({ sessionOverrides: { id: "other" } }));
  reject(valid, {
    sessions: [...valid.fileSync.map(({ session }) => session), first.session],
  });
  reject(valid, { sessions: [] });
  reject({
    ...valid,
    fileSync: [first, { session: { ...first.session } }],
  });
  reject(coveragePlan({ sessionOverrides: { mountKey: "orphan-mount" } }));
});
