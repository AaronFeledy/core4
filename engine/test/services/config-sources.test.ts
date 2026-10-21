import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeLandoPaths } from "@lando/paths";
import {
  type ConfigLayer,
  type ConfigSourceInputs,
  readGlobalConfigSources,
} from "@lando/paths/config-sources";
import type { ConfigError } from "@lando/sdk/errors";
import { ConfigService } from "@lando/sdk/services";
import { Result } from "effect";
import { Effect } from "effect";
import { decodeGlobalConfigSources } from "../../src/config/global-config.ts";
import { layerWith } from "../../src/services/config.ts";

const loadGlobalConfigSync = (inputs: ConfigSourceInputs) =>
  Effect.runSync(
    Effect.flatMap(ConfigService, (service) => service.load).pipe(Effect.provide(layerWith(inputs))),
  );

const roots: string[] = [];
const fixture = (): ConfigSourceInputs => {
  const root = mkdtempSync(join(tmpdir(), "lando-global-decoder-"));
  roots.push(root);
  mkdirSync(join(root, "config.d"));
  return {
    env: {},
    sources: { user: true, env: true },
    rootOverrides: { userConfRoot: root, home: root, platform: "linux" },
  };
};
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const failure = (stack: readonly ConfigLayer[], excessKeys: "warn" | "error" = "warn"): ConfigError => {
  const result = decodeGlobalConfigSources(stack, { excessKeys });
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isSuccess(result)) throw new Error("Expected config failure");
  return result.failure;
};

test("attributes httpsPort to the file when env changes only httpPort", () => {
  // Given independent router fields supplied by different layers.
  const input = fixture();
  const file = join(input.rootOverrides?.userConfRoot ?? "", "config.yml");
  writeFileSync(file, "router:\n  httpsPort: 99999\n");
  // When decoding with a valid environment sibling.
  const error = failure(readGlobalConfigSources({ ...input, env: { LANDO_ROUTER_HTTP_PORT: "8080" } }));
  // Then the failing field points only to its real author and file repair command.
  expect(error.issues).toEqual([
    expect.objectContaining({
      path: ["router", "httpsPort"],
      source: { layer: "config-file", file, path: ["router", "httpsPort"] },
      suggestion: "Run `lando config unset router.httpsPort` or `lando config set router.httpsPort <value>`",
    }),
  ]);
});

test("attributes literal dotted keys without splitting them", () => {
  // Given a host-authored label map with a dotted key and invalid value.
  const stack: readonly ConfigLayer[] = [{ layer: "host", tree: { appLabels: { "com.example.owner": 42 } } }];
  // When decoding the source stack.
  const error = failure(stack);
  // Then both logical path and physical source preserve the key as one segment.
  expect(error.issues?.[0]?.source).toEqual({ layer: "host", path: ["appLabels", "com.example.owner"] });
});

test("missing fields inherit their nearest authored ancestor source path", () => {
  // Given a host event object without either command spelling.
  const stack: readonly ConfigLayer[] = [
    { layer: "host", tree: { hostEvents: { "post-start": [{ service: ":host" }] } } },
  ];
  // When the decoder reports the absent cmd field.
  const error = failure(stack);
  const missing = error.issues?.find((issue) => issue.path.at(-1) === "cmd");
  // Then its logical path names cmd, but its physical origin names the authored object.
  expect(missing?.source).toEqual({ layer: "host", path: ["hostEvents", "post-start", 0] });
});

test("whole appEnv replacement discards invalid file entries and their origins", () => {
  // Given an invalid file map and a valid, disjoint environment replacement.
  const input = fixture();
  writeFileSync(join(input.rootOverrides?.userConfRoot ?? "", "config.yml"), "appEnv:\n  OLD: 42\n");
  // When loading the effective configuration.
  const config = loadGlobalConfigSync({ ...input, env: { LANDO_APP_ENV: '{"NEW":"valid"}' } });
  // Then the invalid removed entry cannot fail validation or survive the merge.
  expect(config.appEnv).toEqual({ NEW: "valid" });
});

test.each(["config.yml", "config.d/broken.yml"])(
  "reports YAML syntax errors for %s without issues",
  (name) => {
    // Given a malformed document at either file tier.
    const input = fixture();
    const file = join(input.rootOverrides?.userConfRoot ?? "", name);
    writeFileSync(file, "router: [\n");
    // When the acquired stack is decoded.
    const error = failure(readGlobalConfigSources(input));
    // Then syntax remediation names that file without inventing schema issues.
    expect(error.path).toBe(file);
    expect(error.issues).toBeUndefined();
    expect(error.remediation).toContain(file);
  },
);

test("strict mode rejects excess keys while normal loading warns with a typo suggestion", () => {
  // Given a misspelled top-level key.
  const stack: readonly ConfigLayer[] = [
    { layer: "config-file", file: "/config.yml", tree: { renderre: "plain" } },
  ];
  // When decoding under both policies.
  const soft = decodeGlobalConfigSources(stack, { excessKeys: "warn" });
  const strict = failure(stack, "error");
  // Then load is usable with warnings, while validation preserves the typo and repair suggestions.
  expect(Result.isSuccess(soft) && soft.success.warnings).toEqual([
    'Unknown config.yml key "renderre". Did you mean "renderer"?',
  ]);
  expect(strict.issues?.[0]?.suggestion).toContain('Did you mean "renderer"?');
  expect(strict.issues?.[0]?.source).toEqual({
    layer: "config-file",
    file: "/config.yml",
    path: ["renderre"],
  });
});

test("strict-only agentEnv policy keeps load permissive and attributes each exact-name issue", () => {
  // Given host-supplied wildcard agent names.
  const stack: readonly ConfigLayer[] = [
    { layer: "host", tree: { agentEnv: { allow: ["CLAUDE_*"], deny: ["CODEX_*"] } } },
  ];
  // When applying the load and strict validation policies.
  const soft = decodeGlobalConfigSources(stack, { excessKeys: "warn" });
  const strict = failure(stack, "error");
  // Then only strict validation fails, with a host origin on each entry.
  expect(Result.isSuccess(soft)).toBe(true);
  expect(strict.issues?.map((issue) => issue.source)).toEqual([
    { layer: "host", path: ["agentEnv", "allow", 0] },
    { layer: "host", path: ["agentEnv", "deny", 0] },
  ]);
});

test("load warns on nested excess keys even without a close spelling", () => {
  // Given a valid router with one misspelling and one wholly unknown key.
  const stack: readonly ConfigLayer[] = [
    { layer: "host", tree: { router: { httpPort: 8081, httpPrt: 8082, notASetting: true } } },
  ];
  // When loading under the warning policy.
  const decoded = decodeGlobalConfigSources(stack, { excessKeys: "warn" });
  // Then valid config survives while both excess keys are reported.
  expect(Result.isSuccess(decoded)).toBe(true);
  if (Result.isFailure(decoded)) throw decoded.failure;
  expect(decoded.success.config.router?.httpPort).toBe(8081);
  expect(decoded.success.warnings).toEqual([
    'Unknown host key "router.httpPrt". Did you mean "httpPort"?',
    'Unknown host key "router.notASetting".',
  ]);
});

test("drop-in values are validated and repaired in the actual drop-in file", () => {
  // Given invalid values in a drop-in.
  const input = fixture();
  const file = join(input.rootOverrides?.userConfRoot ?? "", "config.d", "router.yml");
  writeFileSync(file, "router:\n  httpPort: 99999\n");
  // When decoding all acquired files.
  const error = failure(readGlobalConfigSources(input));
  // Then repair targets the drop-in, never config set on the main file.
  expect(error.issues?.[0]?.source).toEqual({ layer: "config-drop-in", file, path: ["router", "httpPort"] });
  expect(error.issues?.[0]?.suggestion).toBe(`Edit ${file}`);
});

test.each([true, false])("decoded roots agree with PathsService when env sources are %s", (enabled) => {
  // Given drop-in roots, env root overrides, and a fixed discovery root.
  const input = fixture();
  writeFileSync(
    join(input.rootOverrides?.userConfRoot ?? "", "config.d", "roots.yml"),
    "userDataRoot: /drop/data\nuserConfRoot: /ignored\n",
  );
  const env = { LANDO_USER_DATA_ROOT: "/env/data", LANDO_USER_CONF_ROOT: "/env/conf" };
  const sources = { user: enabled, env: enabled };
  // When both consumers acquire with identical inputs.
  const config = loadGlobalConfigSync({ ...input, env, sources });
  const paths = makeLandoPaths({ ...input.rootOverrides, env, sources });
  // Then every root agrees, including hermetic behavior.
  for (const [key, value] of Object.entries(paths.roots)) expect(Reflect.get(config, key)).toBe(value);
});

test("empty root contributions leave config and paths on the same lower-precedence values", () => {
  // Given empty roots in a drop-in, env, and host above a valid main file.
  const input = fixture();
  const root = input.rootOverrides?.userConfRoot ?? "";
  writeFileSync(
    join(root, "config.yml"),
    "userDataRoot: /file/data\nuserCacheRoot: /file/cache\nsystemPluginRoot: /file/system\n",
  );
  writeFileSync(join(root, "config.d", "empty.yml"), 'userDataRoot: ""\n');
  const env = { LANDO_USER_CACHE_ROOT: "", LANDO_CONFIG__SYSTEM_PLUGIN_ROOT: "" };
  const host = { userDataRoot: "" };
  // When the actual schema decoder and path resolver consume those inputs.
  const config = loadGlobalConfigSync({ ...input, env, host });
  const paths = makeLandoPaths({ ...input.rootOverrides, env, host });
  // Then neither consumer erases valid authored roots or falls back prematurely.
  expect(String(config.userDataRoot)).toBe("/file/data");
  expect(String(config.userCacheRoot)).toBe("/file/cache");
  expect(String(config.systemPluginRoot)).toBe("/file/system");
  for (const [key, value] of Object.entries(paths.roots)) expect(Reflect.get(config, key)).toBe(value);
});
