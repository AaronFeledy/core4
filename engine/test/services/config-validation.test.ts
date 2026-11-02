import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError } from "@lando/sdk/errors";
import { ConfigService } from "@lando/sdk/services";
import { Effect } from "effect";
import { decodeGlobalConfigFile, decodeGlobalConfigSources } from "../../src/config/global-config.ts";
import { layer } from "../../src/services/config";

let root = "";
const previous = new Map<string, string>();
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lando-config-validation-"));
  for (const [name, value] of Object.entries(process.env)) {
    if (name.startsWith("LANDO_") && value !== undefined) {
      previous.set(name, value);
      delete process.env[name];
    }
  }
  process.env.LANDO_USER_CONF_ROOT = root;
  process.env.LANDO_USER_DATA_ROOT = join(root, "data");
  process.env.LANDO_USER_CACHE_ROOT = join(root, "cache");
});
afterEach(async () => {
  for (const name of Object.keys(process.env)) if (name.startsWith("LANDO_")) delete process.env[name];
  for (const [name, value] of previous) process.env[name] = value;
  previous.clear();
  await rm(root, { recursive: true, force: true });
});

const load = () =>
  Effect.runPromise(
    Effect.result(Effect.flatMap(ConfigService, (service) => service.load).pipe(Effect.provide(layer))),
  );

test("attributes dotted label keys to their environment override", async () => {
  // Given a valid file and an invalid map value whose key contains dots.
  await writeFile(join(root, "config.yml"), "router:\n  httpPort: 8080\n");
  process.env.LANDO_APP_LABELS = '{"com.example.owner":{"bad":true}}';
  // When the merged configuration is loaded.
  const result = await load();
  // Then the original key remains one segment and repair targets the environment.
  expect(result._tag).toBe("Failure");
  if (result._tag !== "Failure") return;
  expect(result.failure.issues?.map((issue) => issue.path)).toEqual([["appLabels", "com.example.owner"]]);
  expect(result.failure.message).not.toContain("Invalid config file");
  expect(result.failure.remediation).toContain("environment override");
  expect(result.failure.remediation).not.toContain("lando config set");
});

test.each([
  {
    host: "hostEvents:\n  pre-start:\n    - echo container\n",
    hostPath: ["hostEvents", "pre-start", 0],
    router: "  httpPort: 99999\n",
    env: false,
  },
  {
    host: "hostEvents:\n  pre-start:\n    - echo container\n",
    hostPath: ["hostEvents", "pre-start", 0],
    router: "  httpPort: 8080\n",
    env: true,
  },
  { host: "hostEvents: 42\n", hostPath: ["hostEvents"], router: "  httpPort: 99999\n", env: false },
])("aggregates $host with router issues when env is $env", async ({ host, hostPath, router, env }) => {
  // Given independently invalid host events and a file or environment port.
  await writeFile(join(root, "config.yml"), `${host}router:\n${router}`);
  if (env) process.env.LANDO_ROUTER_HTTP_PORT = "99999";
  // When all global configuration is validated.
  const result = await load();
  // Then one error reports both sources without duplicate host-event issues.
  expect(result._tag).toBe("Failure");
  if (result._tag !== "Failure") return;
  expect(result.failure).toBeInstanceOf(ConfigError);
  expect(result.failure.issues?.map((issue) => issue.path)).toEqual([hostPath, ["router", "httpPort"]]);
  expect(result.failure.message).toContain(hostPath.length === 1 ? "hostEvents:" : "hostEvents.pre-start[0]");
  expect(result.failure.message).toContain("(and 1 more issues)");
  expect(result.failure.remediation).toContain("Edit hostEvents");
  expect(result.failure.remediation).toContain(env ? "environment override" : "lando config unset");
  if (env) expect(result.failure.remediation).not.toContain("lando config set");
});

test("config file decoding attributes invalid host events to the owning file", () => {
  // Given an invalid host-only event and its owning config path.
  const file = join(root, "config.yml");
  // When the file candidate is decoded.
  const result = decodeGlobalConfigFile({ hostEvents: { "pre-start": ["echo container"] } }, file);
  // Then the tagged error retains its field path and file provenance.
  expect(result._tag).toBe("Failure");
  if (result._tag !== "Failure") return;
  expect(result.failure).toBeInstanceOf(ConfigError);
  expect(result.failure).toMatchObject({
    path: file,
    issues: [
      {
        path: ["hostEvents", "pre-start", 0],
        message: expect.any(String),
        source: { layer: "config-file", file, path: ["hostEvents", "pre-start", 0] },
      },
    ],
  });
});

test("retains specific expected-value diagnostics without rejected values", () => {
  // Given independent type and range errors carrying a secret value.
  const input = { router: { httpPort: 99999 }, appEnv: { TOKEN: ["opaque-canary-schema"] } };
  // When the candidate is decoded.
  const result = decodeGlobalConfigFile(input, join(root, "config.yml"));
  // Then useful schema expectations survive but actual values never do.
  expect(result._tag).toBe("Failure");
  if (result._tag !== "Failure") return;
  expect(result.failure.issues).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        path: ["router", "httpPort"],
        message: expect.stringContaining("between 1 and 65535"),
      }),
      expect.objectContaining({
        path: ["appEnv", "TOKEN"],
        message: expect.stringContaining("Expected string"),
      }),
    ]),
  );
  expect(JSON.stringify(result.failure)).not.toContain("opaque-canary-schema");
  expect(result.failure.remediation).toContain("<value>`. Run");
});

test("attributes unknown notify command ids and suggests the closest registered id", () => {
  // Given a misspelled id in an environment-authored notification allowlist.
  const variable = "LANDO_CONFIG__NOTIFY__COMMANDS";
  // When the complete config decoder validates membership.
  const result = decodeGlobalConfigSources(
    [
      {
        layer: "env",
        tree: { notify: { commands: ["app:strat"] } },
        variables: new Map([[JSON.stringify(["notify", "commands"]), variable]]),
      },
    ],
    { excessKeys: "error", commandIds: new Set(["app:start", "example:release"]) },
  );
  // Then validation reports a sourced array issue with a useful repair suggestion.
  expect(result._tag).toBe("Failure");
  if (result._tag !== "Failure") return;
  expect(result.failure.issues).toMatchObject([
    {
      path: ["notify", "commands", 0],
      source: { layer: "env", variable },
      suggestion: expect.stringContaining("app:start"),
    },
  ]);
});

test("accepts plugin-contributed notify command ids", () => {
  // Given a command catalog that includes an enabled global plugin.
  const commandIds = new Set(["app:start", "example:release"]);
  // When decoding a notification policy targeting that plugin.
  const result = decodeGlobalConfigFile({ notify: { commands: ["example:release"] } }, "/config.yml", {
    commandIds,
  });
  // Then it is valid before subscriber bootstrap.
  expect(result._tag).toBe("Success");
});
