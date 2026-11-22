import { expect, test } from "bun:test";
import {
  GlobalConfig,
  LandofileAuthoringFragment,
  LandofileShape,
  validationIssuesFromCause,
} from "@lando/sdk/schema";
import { Result, Schema } from "effect";

const options = { errors: "all", onExcessProperty: "error" } as const;

const issuesFor = (schema: Schema.ConstraintDecoder<unknown>, input: unknown) => {
  const result = Schema.decodeUnknownResult(schema)(input, options);
  if (Result.isSuccess(result)) throw new Error("Expected invalid input");
  return validationIssuesFromCause(result.failure, { input });
};

test.each([
  [
    { services: { web: { workingDirectory: "/srv" } } },
    ["services", "web", "workingDirectory"],
    "working_dir",
  ],
  [{ services: { web: { envFile: [".env"] } } }, ["services", "web", "envFile"], "env_file"],
  [{ services: { web: { dependsOn: ["db"] } } }, ["services", "web", "dependsOn"], "depends_on"],
  [
    {
      services: {
        web: { volumes: [{ type: "bind", source: "./src", target: "/src", createHostPath: false }] },
      },
    },
    ["services", "web", "volumes", 0, "createHostPath"],
    "bind.create_host_path",
  ],
  [
    {
      services: { web: { volumes: [{ type: "volume", source: "data", target: "/data", subpath: "files" }] } },
    },
    ["services", "web", "volumes", 0, "subpath"],
    "volume.subpath",
  ],
  [
    {
      services: {
        web: { ports: [{ target: 80, published: 8080, hostIp: "127.0.0.1" }] },
      },
    },
    ["services", "web", "ports", 0, "hostIp"],
    "host_ip",
  ],
  [
    {
      services: {
        web: { ports: [{ target: 80, published: 8080, appProtocol: "grpc" }] },
      },
    },
    ["services", "web", "ports", 0, "appProtocol"],
    "app_protocol",
  ],
  [
    {
      services: {
        web: {
          volumes: [{ type: "bind", source: "./ro", target: "/ro", readOnly: true }],
        },
      },
    },
    ["services", "web", "volumes", 0, "readOnly"],
    "read_only",
  ],
  [
    {
      services: {
        web: {
          volumes: [
            {
              type: "bind",
              source: "./a",
              target: "/a",
              bind: { createHostPath: false },
            },
          ],
        },
      },
    },
    ["services", "web", "volumes", 0, "bind", "createHostPath"],
    "create_host_path",
  ],
  [
    { services: { web: { build: { dockerfileInline: "FROM alpine" } } } },
    ["services", "web", "build", "dockerfileInline"],
    "dockerfile_inline",
  ],
  [{ services: { web: { db_client: false } } }, ["services", "web", "db_client"], "dbClient"],
  [
    { services: { web: { scanner: { timeout: 5000 } } } },
    ["services", "web", "scanner", "timeout"],
    "timeoutMs",
  ],
  [
    {
      services: {
        web: { healthcheck: { command: ["true"], startInterval: 2 } },
      },
    },
    ["services", "web", "healthcheck", "startInterval"],
    "startIntervalSeconds",
  ],
  [{ env_file: [".env"] }, ["env_file"], "serviceDefaults.env_file"],
] as const)("Landofile projects %j as one key.renamed finding", (body, path, canonical) => {
  const input = { name: "renamed-keys", ...body };
  for (const schema of [LandofileAuthoringFragment, LandofileShape]) {
    const issues = issuesFor(schema, input).filter((issue) => issue.reason === "key.renamed");
    expect(issues).toEqual([
      expect.objectContaining({
        path,
        reason: "key.renamed",
        suggestion: `Rename ${String(path.at(-1))} to ${canonical}.`,
      }),
    ]);
  }
});

test("a dependency object in a list suggests a Compose condition map", () => {
  const input = { services: { web: { depends_on: [{ service: "db", condition: "service_started" }] } } };
  for (const schema of [LandofileAuthoringFragment, LandofileShape]) {
    expect(issuesFor(schema, input).filter((issue) => issue.reason === "key.renamed")).toEqual([
      expect.objectContaining({
        path: ["services", "web", "depends_on", 0],
        suggestion: expect.stringContaining("depends_on condition map"),
      }),
    ]);
  }
});

test("canonical Compose and Lando spellings do not emit key.renamed", () => {
  const input = {
    name: "renamed-keys-ok",
    serviceDefaults: { env_file: [".env"] },
    services: {
      web: {
        image: "alpine",
        working_dir: "/srv",
        env_file: [".env"],
        depends_on: ["db"],
        ports: [{ target: 80, published: 8080, host_ip: "127.0.0.1", app_protocol: "grpc" }],
        volumes: [
          {
            type: "bind",
            source: "./ro",
            target: "/ro",
            read_only: true,
            bind: { create_host_path: true },
          },
        ],
        build: { context: ".", dockerfile_inline: "FROM alpine" },
        dbClient: false,
        scanner: { timeoutMs: 5000 },
        healthcheck: { command: ["true"], startIntervalSeconds: 2 },
      },
      db: { image: "alpine" },
    },
  };
  for (const schema of [LandofileAuthoringFragment, LandofileShape]) {
    const result = Schema.decodeUnknownResult(schema)(input, options);
    if (Result.isFailure(result)) {
      const renamed = validationIssuesFromCause(result.failure, { input }).filter(
        (issue) => issue.reason === "key.renamed",
      );
      expect(renamed).toEqual([]);
    }
  }
});

test.each([
  [{ appEnv: { TEAM: "platform" } }, ["appEnv"], "serviceDefaults.environment"],
  [{ appLabels: { team: "web" } }, ["appLabels"], "serviceDefaults.labels"],
  [{ scanner: { timeout: 5000 } }, ["scanner", "timeout"], "timeoutMs"],
] as const)("GlobalConfig projects %j as one key.renamed finding", (input, path, canonical) => {
  expect(issuesFor(GlobalConfig, input)).toEqual([
    expect.objectContaining({
      path,
      reason: "key.renamed",
      suggestion: `Rename ${String(path.at(-1))} to ${canonical}.`,
    }),
  ]);
});

test("GlobalConfig accepts serviceDefaults and scanner.timeoutMs", () => {
  const result = Schema.decodeUnknownResult(GlobalConfig)(
    {
      serviceDefaults: { environment: { TEAM: "platform" }, labels: { team: "web" } },
      scanner: { timeoutMs: 5000 },
    },
    options,
  );
  expect(Result.isSuccess(result)).toBe(true);
});
