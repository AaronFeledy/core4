import { expect, test } from "bun:test";
import { JsonSchema, Schema, SchemaIssue, SchemaRepresentation } from "effect";

import {
  AppMountInput,
  BindMountPlan,
  LandofileAuthoringShape,
  MountPlan,
  ServiceConfig,
  TmpfsMountPlan,
  VolumeMountPlan,
  bindSyncIgnores,
  duplicateMountTarget,
  effectiveExcludes,
  fileSyncVolumeName,
  getJsonSchema,
  orderMounts,
  plannedFileSyncSessions,
  serviceAppMount,
} from "@lando/sdk/schema";

const appBind = (
  excludes: readonly string[] = [],
  includes: readonly string[] = [],
  extras: Partial<{
    realization: "passthrough" | "accelerated";
    mountKey: string;
    role: "app";
  }> = {},
) =>
  Schema.decodeUnknownSync(BindMountPlan)({
    type: "bind",
    source: "/repo",
    target: "/app",
    readOnly: false,
    realization: extras.realization ?? "accelerated",
    role: extras.role ?? "app",
    excludes,
    includes,
    ...(extras.mountKey === undefined ? {} : { mountKey: extras.mountKey }),
  });

test("BindMountPlan / VolumeMountPlan / TmpfsMountPlan decode and reject cross-kind fields", () => {
  expect(
    Schema.decodeUnknownSync(BindMountPlan)({
      type: "bind",
      source: "/host",
      target: "/app",
      readOnly: false,
      realization: "accelerated",
      role: "app",
      excludes: ["vendor"],
      includes: [".git"],
      mountKey: "app-mount",
    }),
  ).toMatchObject({ type: "bind", role: "app", mountKey: "app-mount" });

  expect(
    Schema.decodeUnknownSync(VolumeMountPlan)({
      type: "volume",
      store: "myapp-web-data",
      target: "/data",
      readOnly: true,
      subpath: "db",
    }),
  ).toMatchObject({ type: "volume", store: "myapp-web-data", subpath: "db" });

  expect(
    Schema.decodeUnknownSync(TmpfsMountPlan)({
      type: "tmpfs",
      target: "/scratch",
      readOnly: false,
      options: "size=64m,mode=1777",
    }),
  ).toMatchObject({ type: "tmpfs", options: "size=64m,mode=1777" });

  const asMount = Schema.decodeUnknownSync(MountPlan);
  expect(asMount({ type: "volume", store: "s", target: "/v", readOnly: false }).type).toBe("volume");
  expect(asMount({ type: "tmpfs", target: "/t", readOnly: false }).type).toBe("tmpfs");
  expect(() =>
    Schema.decodeUnknownSync(BindMountPlan)({
      type: "volume",
      store: "s",
      target: "/v",
      readOnly: false,
    }),
  ).toThrow();
  expect(() =>
    Schema.decodeUnknownSync(VolumeMountPlan)({
      type: "bind",
      source: "/h",
      target: "/a",
      readOnly: false,
      realization: "passthrough",
    }),
  ).toThrow();
  expect(() =>
    Schema.decodeUnknownSync(TmpfsMountPlan, { onExcessProperty: "error" })({
      type: "tmpfs",
      target: "/t",
      readOnly: false,
      realization: "passthrough",
    }),
  ).toThrow();
  expect(() =>
    Schema.decodeUnknownSync(VolumeMountPlan)({
      type: "volume",
      target: "/v",
      readOnly: false,
    }),
  ).toThrow();
});

test("serviceAppMount returns the role:app bind only", () => {
  const app = appBind(["vendor"]);
  const other = Schema.decodeUnknownSync(BindMountPlan)({
    type: "bind",
    source: "/host/cfg",
    target: "/app/config",
    readOnly: false,
    realization: "passthrough",
  });
  const volume = Schema.decodeUnknownSync(VolumeMountPlan)({
    type: "volume",
    store: "shadow",
    target: "/app/vendor",
    readOnly: false,
  });
  expect(serviceAppMount({ mounts: [other, volume, app] })).toEqual(app);
  expect(serviceAppMount({ mounts: [other, volume] })).toBeUndefined();
});

test("effectiveExcludes drops exact includes and bang entries", () => {
  expect(
    effectiveExcludes({
      excludes: ["vendor", "vendor/", "node_modules", "vendor", "!secret"],
      includes: ["vendor"],
    }),
  ).toEqual(["vendor/", "node_modules"]);
});

test("cancels exact excludes when includes names the whole entry", () => {
  // Given overlapping excludes and an exact include on the app bind.
  const bind = appBind(["vendor", "vendor/", "node_modules", "vendor"], ["vendor"]);
  const service = { mounts: [bind] };
  // When deriving sync ignores.
  const ignores = bindSyncIgnores(service, bind);
  // Then only the exact entry is removed, with stable insertion order and deduplication.
  expect(ignores).toEqual(["vendor/", "node_modules", ".git"]);
});

test.each([
  { input: "/site", expected: { target: "/site" } },
  { input: "disabled", expected: { target: "disabled" } },
  { input: false, expected: false },
  {
    input: { target: "/app", readOnly: true, excludes: ["vendor"], includes: ["vendor/keep"] },
    expected: { target: "/app", readOnly: true, excludes: ["vendor"], includes: ["vendor/keep"] },
  },
])("AppMountInput normalizes and repeatedly decodes $input", ({ input, expected }) => {
  for (const options of [{}, { onExcessProperty: "error" as const }]) {
    const decode = Schema.decodeUnknownSync(AppMountInput, options);
    const decoded = decode(input);
    expect(decoded).toEqual(expected);
    expect(decode(decoded)).toEqual(expected);
    expect(Schema.decodeUnknownSync(ServiceConfig, options)({ appMount: input }).appMount).toEqual(expected);
  }
});

test.each([
  { type: "bind", target: "/x" },
  { source: "/host", target: "/x" },
])("AppMountInput rejects unsupported generic mount input %j", (input) => {
  for (const options of [{}, { onExcessProperty: "error" as const }]) {
    expect(() => Schema.decodeUnknownSync(AppMountInput, options)(input)).toThrow();
  }
});

test("published AppMountInput rejects generic mount keys while accepting destination strings", async () => {
  const document = getJsonSchema("AppMountInput");
  expect(
    await Bun.file(new URL("../../../dist/schemas/app-mount-input.json", import.meta.url)).json(),
  ).toEqual(document);
  const projected = SchemaRepresentation.fromJsonSchemaDocument(JsonSchema.fromSchemaDraft2020_12(document));
  const decode = Schema.decodeUnknownSync(Schema.make<Schema.Codec<unknown>>(projected.ast), {
    onExcessProperty: "error",
  });
  expect(decode("disabled")).toBe("disabled");
  expect(decode({ target: "/x" })).toEqual({ target: "/x" });
  for (const input of [
    { target: "/x", type: "bind" },
    { target: "/x", source: "/host" },
  ])
    expect(() => decode(input)).toThrow();
});

test("derives relative ignores from every mount beneath the bind target", () => {
  // Given overlapping shadows, authored storage volumes, cache storage, nested binds, and tmpfs.
  const bind = appBind(["node_modules", "tmp"]);
  const mounts = Schema.decodeUnknownSync(Schema.Array(MountPlan))([
    bind,
    { type: "volume", store: "shadow", target: "/app/node_modules", readOnly: false },
    { type: "volume", store: "uploads", target: "/app/public/uploads", readOnly: false },
    { type: "volume", store: "cache", target: "/app/.cache", readOnly: false },
    { type: "volume", store: "outside", target: "/application/data", readOnly: false },
    { type: "volume", store: "root", target: "/app", readOnly: false },
    { type: "volume", store: "logs", target: "/app/logs", readOnly: false },
    { type: "tmpfs", target: "/app/tmp", readOnly: false },
    { type: "tmpfs", target: "/app/scratch", readOnly: false },
    { type: "volume", store: "vendor", target: "/app/vendor", readOnly: false },
    { type: "bind", source: "/host", target: "/app/config", readOnly: false, realization: "passthrough" },
  ]);
  // When deriving sync ignores from the single mount list.
  const ignores = bindSyncIgnores({ mounts }, bind);
  // Then excludes precede new overlay paths (including nested binds) and Git comes last.
  expect(ignores).toEqual([
    "node_modules",
    "tmp",
    "public/uploads",
    ".cache",
    "logs",
    "scratch",
    "vendor",
    "config",
    ".git",
  ]);
});

test("matches exclude policy when a volume overlay owns the same subtree", () => {
  // Given equivalent ownership expressed as an exclude or a volume under the app target.
  const excludedBind = appBind(["node_modules"]);
  const storedBind = appBind();
  const excluded = { mounts: [excludedBind] };
  const stored = {
    mounts: Schema.decodeUnknownSync(Schema.Array(MountPlan))([
      storedBind,
      { type: "volume", store: "nm", target: "/app/node_modules", readOnly: false },
    ]),
  };
  // When deriving both lists.
  const ignores = bindSyncIgnores(stored, storedBind);
  // Then both produce the same sync behavior.
  expect(ignores).toEqual(bindSyncIgnores(excluded, excludedBind));
});

test.each([false, true])("syncs Git only when explicitly included (%s)", (included) => {
  // Given a fixed Git rule and optional include.
  const bind = appBind([], included ? [".git"] : []);
  const service = { mounts: [bind] };
  // When deriving sync ignores.
  const ignores = bindSyncIgnores(service, bind);
  // Then includes alone cancels the fixed ignore.
  expect(ignores).toEqual(included ? [] : [".git"]);
});

test("has no app bind when the service has no role:app mount", () => {
  // Given storage without an app mount.
  const service = {
    mounts: Schema.decodeUnknownSync(Schema.Array(MountPlan))([
      { type: "volume", store: "nm", target: "/app/node_modules", readOnly: false },
    ]),
  };
  // When looking up the app mount.
  // Then no app synchronization policy is created.
  expect(serviceAppMount(service)).toBeUndefined();
});

test("orderMounts sorts shallow to deep then by target", () => {
  const mounts = Schema.decodeUnknownSync(Schema.Array(MountPlan))([
    { type: "tmpfs", target: "/app/vendor/acme", readOnly: false },
    { type: "volume", store: "v", target: "/app/vendor", readOnly: false },
    {
      type: "bind",
      source: "/repo",
      target: "/app",
      readOnly: false,
      realization: "passthrough",
      role: "app",
    },
    { type: "tmpfs", target: "/run", readOnly: false },
    { type: "bind", source: "/h", target: "/app/config", readOnly: false, realization: "passthrough" },
  ]);
  expect(orderMounts(mounts).map((mount) => String(mount.target))).toEqual([
    "/app",
    "/run",
    "/app/config",
    "/app/vendor",
    "/app/vendor/acme",
  ]);
});

test("duplicateMountTarget reports the first repeated container path", () => {
  const mounts = Schema.decodeUnknownSync(Schema.Array(MountPlan))([
    { type: "bind", source: "/a", target: "/app", readOnly: false, realization: "passthrough" },
    { type: "tmpfs", target: "/scratch", readOnly: false },
    { type: "volume", store: "x", target: "/app", readOnly: false },
  ]);
  expect(duplicateMountTarget(mounts)).toBe("/app");
  expect(
    duplicateMountTarget(
      Schema.decodeUnknownSync(Schema.Array(MountPlan))([
        { type: "bind", source: "/a", target: "/app", readOnly: false, realization: "passthrough" },
        { type: "tmpfs", target: "/scratch", readOnly: false },
      ]),
    ),
  ).toBeUndefined();
});

test("plannedFileSyncSessions derives one session per accelerated bind", () => {
  const app = appBind(["vendor"], [], { mountKey: "app-mount" });
  const extra = Schema.decodeUnknownSync(BindMountPlan)({
    type: "bind",
    source: "/repo/pkg",
    target: "/app/pkg",
    readOnly: false,
    realization: "accelerated",
    mountKey: "mount-deadbeef",
  });
  const passthrough = Schema.decodeUnknownSync(BindMountPlan)({
    type: "bind",
    source: "/host",
    target: "/app/config",
    readOnly: false,
    realization: "passthrough",
  });
  const plan = {
    name: "My App",
    services: {
      web: {
        mounts: Schema.decodeUnknownSync(Schema.Array(MountPlan))([
          app,
          extra,
          passthrough,
          { type: "volume", store: "shadow", target: "/app/vendor", readOnly: false },
        ]),
      },
    },
  };
  expect(plannedFileSyncSessions(plan)).toEqual([
    {
      service: "web",
      mountKey: "app-mount",
      source: "/repo",
      targetPath: app.target,
      volumeName: fileSyncVolumeName("My App", "web", "app-mount"),
      excludes: bindSyncIgnores(plan.services.web, app),
    },
    {
      service: "web",
      mountKey: "mount-deadbeef",
      source: "/repo/pkg",
      targetPath: extra.target,
      volumeName: fileSyncVolumeName("My App", "web", "mount-deadbeef"),
      excludes: bindSyncIgnores(plan.services.web, extra),
    },
  ]);
  expect(fileSyncVolumeName("My App", "web", "app-mount")).toBe("My-App-web-app-mount");
});

test("plannedFileSyncSessions yields undefined when an accelerated bind omits mountKey", () => {
  const missingKey = appBind([], [], { realization: "accelerated" });
  const plan = {
    name: "demo",
    services: { web: { mounts: [missingKey] } },
  };
  expect(plannedFileSyncSessions(plan)).toBeUndefined();
});

test.each(["excludes", "includes"] as const)("rejects negated %s at the entry path", (field) => {
  // Given a negated entry at the authoring boundary.
  const input = {
    runtime: 4,
    name: "demo",
    services: { web: { appMount: { target: "/app", [field]: ["!vendor"] } } },
  };
  // When decoding literal authoring input.
  const result = Schema.decodeUnknownResult(LandofileAuthoringShape)(input);
  // Then lint can report the precise entry and actionable includes guidance.
  expect(result._tag).toBe("Failure");
  if (result._tag !== "Failure") throw new Error("Expected invalid app-mount entry");
  const issues = SchemaIssue.makeFormatterStandardSchemaV1()(result.failure.issue).issues;
  expect(issues).toContainEqual({
    path: ["services", "web", "appMount", field, 0],
    message: "Use includes: [vendor] to keep vendor; `!` entries are not supported.",
  });
});

test("preserves plain policy across strict repeated decoding", () => {
  // Given authored exclude and include policy.
  const input = { appMount: { target: "/app", excludes: ["vendor"], includes: [".git"] } };
  const decode = Schema.decodeUnknownSync(ServiceConfig, { onExcessProperty: "error" });
  // When the layered pipeline decodes twice.
  const config = decode(decode(input));
  // Then the canonical policy remains intact.
  expect(config.appMount).toEqual(input.appMount);
});
