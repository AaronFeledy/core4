import { expect, test } from "bun:test";
import { ServiceTypeError } from "@lando/sdk/errors";
import { PortNumber, ServiceName } from "@lando/sdk/schema";
import type { ServiceType, ServiceTypeResolution } from "@lando/sdk/services";
import { Effect, Schema } from "effect";
import { composeExtendedServiceType } from "../../src/services/extends.ts";

const connection = {
  family: "postgres",
  port: PortNumber.make(5432),
  creds: { user: "parent", database: "parent", password: "parent" },
} as const;
const task = { service: "db", cmd: "psql", description: "parent", env: { KEEP: "parent" } };
const resolution: ServiceTypeResolution = {
  base: "l337",
  normalizedConfig: {},
  features: [],
  connection,
  tooling: { psql: task },
};
const parent: ServiceType = {
  id: "parent",
  name: "parent",
  base: "l337",
  schema: Schema.Unknown,
  toolingForConnection: () => ({ psql: task }),
  resolve: () => Effect.succeed(resolution),
};
const resolveChild = async (
  raw: Partial<ServiceTypeResolution> = {},
  factory?: ServiceType["toolingForConnection"],
  root: ServiceType = parent,
) => {
  const child: ServiceType = {
    id: "child",
    name: "child",
    base: "l337",
    schema: Schema.Unknown,
    extends: root.id,
    ...(factory === undefined ? {} : { toolingForConnection: factory }),
    resolve: () => Effect.succeed({ base: "l337", normalizedConfig: {}, features: [], ...raw }),
  };
  const composed = await Effect.runPromise(
    composeExtendedServiceType(child, (id) => (id === root.id ? root : undefined)),
  );
  const value = await Effect.runPromise(
    composed.resolve({
      name: "db",
      service: {},
      appRoot: "/app",
      metadata: { resolvedAt: "2026-01-01T00:00:00Z", source: "test", runtime: 4 },
    }),
  );
  return { composed, value };
};

test("inherits canonical credentials and factory when child omits them", async () => {
  const { value, composed } = await resolveChild();
  expect(value.connection).toEqual(connection);
  expect(value.connectionClientNames).toEqual(["psql"]);
  expect(composed.toolingForConnection?.(ServiceName.make("db"), connection)).toEqual({ psql: task });
});

test.each([
  { label: "identical", tooling: { psql: task } },
  { label: "custom", tooling: { psql: { cmd: "custom" } } },
])(
  "revokes client authority for an explicit $label child task while deep merging content",
  async ({ tooling }) => {
    const { value } = await resolveChild({ tooling });
    expect(value.connectionClientNames).toEqual([]);
    expect(value.tooling?.psql).toEqual({ ...task, ...tooling.psql });
  },
);

test("reauthorizes explicit tasks through inherited factory and deduplicates names", async () => {
  const { value } = await resolveChild({
    tooling: { psql: { cmd: "custom" } },
    connectionClientNames: ["psql", "psql"],
  });
  expect(value.connectionClientNames).toEqual(["psql"]);
});

test("explicit empty names without an own factory retain untouched parent claims", async () => {
  const { value } = await resolveChild({ connectionClientNames: [] });
  expect(value.connectionClientNames).toEqual(["psql"]);
});

test("auto-claims intersect merged task names instead of creating missing tasks", async () => {
  const { value } = await resolveChild({}, () => ({ absent: { cmd: "absent" } }));
  expect(value.connectionClientNames).toEqual([]);
  expect(value.tooling).toEqual(resolution.tooling);
});

test("child connection wins as a whole instead of deep merging parent facts", async () => {
  const childConnection = {
    ...connection,
    port: PortNumber.make(6543),
    creds: { user: "child", database: "child", password: "child" },
  };
  const { value } = await resolveChild({ connection: childConnection });
  expect(value.connection).toEqual(childConnection);
});

test.each([{ names: undefined }, { names: [] }] as const)(
  "empty own factory disables authority with names $names but retains content",
  async ({ names }) => {
    const { value, composed } = await resolveChild(
      names === undefined ? {} : { connectionClientNames: names },
      () => ({}),
    );
    expect(value.connectionClientNames).toEqual([]);
    expect(value.tooling).toEqual(resolution.tooling);
    expect(composed.toolingForConnection?.(ServiceName.make("db"), connection)).toEqual({});
  },
);

test.each([
  { names: undefined, expected: ["other"] },
  { names: [], expected: [] },
])("own factory replaces parent authority with explicit names $names", async ({ names, expected }) => {
  const { value } = await resolveChild(
    {
      tooling: { other: { cmd: "other" } },
      ...(names === undefined ? {} : { connectionClientNames: names }),
    },
    () => ({ other: { cmd: "generated" } }),
  );
  expect(value.connectionClientNames).toEqual(expected);
  expect(value.tooling?.psql).toEqual(task);
});

test("child credentials replace the entire parent canonical pair", async () => {
  const creds = { user: "child", database: "0", password: "child" };
  const { value } = await resolveChild({ nonSqlCreds: creds }, () => ({}));
  expect(value.nonSqlCreds).toEqual(creds);
  expect(value.connection).toBeUndefined();
});

test("child connection replaces inherited non-SQL credentials", async () => {
  const { connection: _connection, ...rest } = resolution;
  const root: ServiceType = {
    ...parent,
    toolingForConnection: () => ({}),
    resolve: () => Effect.succeed({ ...rest, nonSqlCreds: connection.creds }),
  };
  const { value } = await resolveChild({ connection }, parent.toolingForConnection, root);
  expect(value.connection).toEqual(connection);
  expect(value.nonSqlCreds).toBeUndefined();
});

test.each(["parent", "child"] as const)(
  "rejects invalid raw dual-source %s before a later declaration can mask it",
  async (source) => {
    const invalid = { ...resolution, nonSqlCreds: connection.creds };
    const root: ServiceType =
      source === "parent" ? { ...parent, resolve: () => Effect.succeed(invalid) } : parent;
    await expect(
      resolveChild(source === "child" ? invalid : { connection }, undefined, root),
    ).rejects.toBeInstanceOf(ServiceTypeError);
  },
);

test.each([
  { tooling: { missing: { cmd: "missing" } }, connectionClientNames: ["missing"] },
  { connectionClientNames: ["missing"] },
  { nonSqlCreds: connection.creds, connectionClientNames: ["psql"] },
])("rejects unsupported, missing-task or connectionless claims %j", async (raw) => {
  await expect(resolveChild(raw)).rejects.toBeInstanceOf(ServiceTypeError);
});

test("rejects explicit claims against an empty child factory", async () => {
  const result = await Effect.runPromise(
    Effect.tryPromise({
      try: () => resolveChild({ connectionClientNames: ["psql"] }, () => ({})),
      catch: (error) => error,
    }).pipe(Effect.result),
  );
  expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "ServiceTypeError" } });
});

test("rejects a parent's invalid claims before a child can revoke them", async () => {
  const root: ServiceType = {
    ...parent,
    resolve: () => Effect.succeed({ ...resolution, connectionClientNames: ["missing"] }),
  };
  const result = await Effect.runPromise(
    Effect.tryPromise({
      try: () => resolveChild({ tooling: { missing: { cmd: "override" } } }, undefined, root),
      catch: (error) => error,
    }).pipe(Effect.result),
  );
  expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "ServiceTypeError" } });
});

test("keeps revoked claims explicit over another inheritance hop", async () => {
  const { composed } = await resolveChild({ tooling: { psql: task } });
  const leaf: ServiceType = {
    id: "leaf",
    name: "leaf",
    base: "l337",
    schema: Schema.Unknown,
    extends: "child",
    resolve: () => Effect.succeed({ base: "l337", normalizedConfig: {}, features: [] }),
  };
  const result = await Effect.runPromise(
    composeExtendedServiceType(leaf, (id) =>
      id === "child" ? composed : id === "parent" ? parent : undefined,
    ),
  );
  const value = await Effect.runPromise(
    result.resolve({
      name: "db",
      service: {},
      appRoot: "/app",
      metadata: { resolvedAt: "2026-01-01T00:00:00Z", source: "test", runtime: 4 },
    }),
  );
  expect(value.connectionClientNames).toEqual([]);
});

test("nearest explicit factory wins as a whole across multiple raw hops", async () => {
  const middle: ServiceType = {
    ...parent,
    id: "middle",
    extends: "parent",
    toolingForConnection: () => ({ other: { cmd: "middle-generated" } }),
    resolve: () =>
      Effect.succeed({
        base: "l337",
        normalizedConfig: {},
        features: [],
        tooling: { other: { cmd: "middle-content" } },
      }),
  };
  const leaf: ServiceType = {
    id: "leaf",
    name: "leaf",
    base: "l337",
    schema: Schema.Unknown,
    extends: "middle",
    resolve: () => Effect.succeed({ base: "l337", normalizedConfig: {}, features: [] }),
  };
  const composed = await Effect.runPromise(
    composeExtendedServiceType(leaf, (id) =>
      id === "middle" ? middle : id === "parent" ? parent : undefined,
    ),
  );
  const value = await Effect.runPromise(
    composed.resolve({
      name: "db",
      service: {},
      appRoot: "/app",
      metadata: { resolvedAt: "2026-01-01T00:00:00Z", source: "test", runtime: 4 },
    }),
  );
  expect(value.connectionClientNames).toEqual(["other"]);
  expect(composed.toolingForConnection?.(ServiceName.make("db"), connection)).toEqual({
    other: { cmd: "middle-generated" },
  });
  expect(value.tooling).toEqual({ psql: task, other: { cmd: "middle-content" } });
});
