import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ConfigSourceInputs,
  mergeGlobalConfigSources,
  readGlobalConfigSources,
} from "../src/config-sources.ts";
import { envOverlayWithVariables } from "../src/overlay.ts";
import { makeLandoPaths } from "../src/paths.ts";

const roots: string[] = [];
const fixture = (): ConfigSourceInputs => {
  const root = mkdtempSync(join(tmpdir(), "lando-config-sources-"));
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

test("orders defaults, main file, lexical yml drop-ins, env and host", () => {
  // Given distinct provider choices at every precedence level and a non-yml file.
  const input = fixture();
  const root = input.rootOverrides?.userConfRoot ?? "";
  writeFileSync(join(root, "config.yml"), "defaultProviderId: file\n");
  writeFileSync(join(root, "config.d", "20-last.yml"), "defaultProviderId: last\n");
  writeFileSync(join(root, "config.d", "10-first.yml"), "defaultProviderId: first\n");
  writeFileSync(join(root, "config.d", "99-ignore.yaml"), "defaultProviderId: ignored\n");
  // When acquiring the full stack.
  const stack = readGlobalConfigSources({
    ...input,
    env: { LANDO_CONFIG__DEFAULT_PROVIDER_ID: "env" },
    host: { defaultProviderId: "host" },
  });
  // Then the stack preserves precedence and each prefix selects its last contribution.
  expect(stack.map((layer) => layer.layer)).toEqual([
    "default",
    "config-file",
    "config-drop-in",
    "config-drop-in",
    "env",
    "host",
  ]);
  expect(
    [1, 2, 3, 4, 5, 6].map(
      (length) => mergeGlobalConfigSources(stack.slice(0, length)).tree.defaultProviderId,
    ),
  ).toEqual([undefined, "file", "first", "last", "env", "host"]);
});

test("captures syntax errors independently without discarding the remaining layers", () => {
  // Given malformed documents at both file tiers and a valid later drop-in.
  const input = fixture();
  const root = input.rootOverrides?.userConfRoot ?? "";
  writeFileSync(join(root, "config.yml"), "router: [\n");
  writeFileSync(join(root, "config.d", "10-bad.yml"), "router: [\n");
  writeFileSync(join(root, "config.d", "20-good.yml"), "renderer: plain\n");
  // When acquiring, not decoding, the source stack.
  const stack = readGlobalConfigSources(input);
  // Then both failing files retain their own error and the good layer is still acquired.
  expect(
    stack.filter((layer) => "error" in layer).map((layer) => ("file" in layer ? layer.file : "")),
  ).toEqual([join(root, "config.yml"), join(root, "config.d", "10-bad.yml")]);
  expect(mergeGlobalConfigSources(stack).tree.renderer).toBe("plain");
});

test("keeps roots and effective config aligned without relocating discovery", () => {
  // Given file roots overridden by a lexical drop-in that attempts relocation.
  const input = fixture();
  const root = input.rootOverrides?.userConfRoot ?? "";
  writeFileSync(join(root, "config.yml"), "userDataRoot: /file/data\n");
  writeFileSync(
    join(root, "config.d", "roots.yml"),
    "userConfRoot: /ignored/conf\nuserDataRoot: /drop/data\n",
  );
  // When resolving both consumers from the same inputs.
  const merged = mergeGlobalConfigSources(readGlobalConfigSources(input)).tree;
  const paths = makeLandoPaths({ ...input.rootOverrides, env: input.env, sources: input.sources });
  // Then file discovery is fixed and the other roots honor drop-ins.
  expect(paths.roots.userConfRoot).toBe(root);
  expect(paths.roots.userDataRoot).toBe("/drop/data");
  for (const [key, value] of Object.entries(paths.roots)) expect(merged[key]).toBe(value);
});

test("hermetic policy skips files and LANDO root and config environment variables", () => {
  // Given invalid user files and hostile root variables, with explicit platform identity.
  const input = fixture();
  const root = input.rootOverrides?.userConfRoot ?? "";
  writeFileSync(join(root, "config.yml"), "router: [\n");
  const env = { LANDO_USER_DATA_ROOT: "/env/data", LANDO_CONFIG__USER_CACHE_ROOT: "/env/cache" };
  const sources = { user: false, env: false };
  // When acquiring and resolving with both external sources disabled.
  const stack = readGlobalConfigSources({ ...input, env, sources });
  const paths = makeLandoPaths({ ...input.rootOverrides, env, sources });
  // Then only default/host layers exist and both consumers choose platform defaults.
  expect(stack.map((layer) => layer.layer)).toEqual(["default", "host"]);
  expect(paths.roots.userDataRoot).toBe(join(root, ".local/share/lando"));
  for (const [key, value] of Object.entries(paths.roots))
    expect(mergeGlobalConfigSources(stack).tree[key]).toBe(value);
});

test.each([
  { user: false, env: true, expected: "/env/data" },
  { user: true, env: false, expected: "/file/data" },
])("source switches operate independently when user=$user and env=$env", ({ user, env, expected }) => {
  // Given conflicting user and environment roots.
  const input = fixture();
  writeFileSync(join(input.rootOverrides?.userConfRoot ?? "", "config.yml"), "userDataRoot: /file/data\n");
  // When exactly one external source is enabled.
  const stack = readGlobalConfigSources({
    ...input,
    env: { LANDO_USER_DATA_ROOT: "/env/data" },
    sources: { user, env },
  });
  // Then only that source supplies the effective root.
  expect(mergeGlobalConfigSources(stack).tree.userDataRoot).toBe(expected);
});

test.each([
  ["LANDO_CONFIG__ROUTER__HTTP_PORT", ["router", "httpPort"]],
  ["LANDO_ROUTER_HTTP_PORT", ["router", "httpPort"]],
  ["LANDO_USER_DATA_ROOT", ["userDataRoot"]],
])("records the exact spelling of %s", (name, path) => {
  // Given a supplied variable, including a friendly or root alias.
  const env = { [String(name)]: "1234" };
  // When projecting the environment.
  const overlay = envOverlayWithVariables(env);
  // Then segment-array identities map back to the supplied name.
  expect(overlay.variables.get(JSON.stringify(path))).toBe(name);
});

test("friendly aliases replace generic ancestry without stale variable descendants", () => {
  // Given a generic map replaced whole by a friendly alias.
  const env = {
    LANDO_CONFIG__APP_LABELS: '{"com.example.owner":"old"}',
    LANDO_APP_LABELS: '{"new":"value"}',
  };
  // When applying aliases.
  const overlay = envOverlayWithVariables(env);
  // Then both effective content and provenance belong solely to the friendly alias.
  expect(overlay.tree.appLabels).toEqual({ new: "value" });
  expect([...overlay.variables.values()]).toEqual(["LANDO_APP_LABELS"]);
});

test("replacement clears descendant origins while map merge preserves siblings", () => {
  // Given a file map, a replacing scalar, and a new host map.
  const stack = [
    { layer: "config-file", file: "/config.yml", tree: { router: { httpsPort: 8443 } } },
    { layer: "config-drop-in", file: "/config.d/replace.yml", tree: { router: false } },
    { layer: "host", tree: { router: { httpPort: 8080 } } },
  ] as const;
  // When folding all layers.
  const merged = mergeGlobalConfigSources(stack);
  // Then a removed descendant inherits the replacement ancestor, never the old file.
  expect(merged.tree.router).toEqual({ httpPort: 8080 });
  expect(merged.originAt(["router", "httpsPort"]).layer.layer).toBe("host");
});

test.each(["root aliases", "generic overlays"])("empty %s preserve lower-precedence file roots", (kind) => {
  // Given authored roots and empty environment assignments for all non-discovery roots.
  const input = fixture();
  const root = input.rootOverrides?.userConfRoot ?? "";
  writeFileSync(
    join(root, "config.yml"),
    "userDataRoot: /file/data\nuserCacheRoot: /file/cache\nsystemPluginRoot: /file/system\n",
  );
  const env =
    kind === "root aliases"
      ? { LANDO_USER_DATA_ROOT: "", LANDO_USER_CACHE_ROOT: "", LANDO_SYSTEM_PLUGIN_ROOT: "" }
      : {
          LANDO_CONFIG__USER_DATA_ROOT: "",
          LANDO_CONFIG__USER_CACHE_ROOT: "",
          LANDO_CONFIG__SYSTEM_PLUGIN_ROOT: "",
        };
  // When resolving the shared stack and paths.
  const merged = mergeGlobalConfigSources(readGlobalConfigSources({ ...input, env })).tree;
  const paths = makeLandoPaths({ ...input.rootOverrides, env });
  // Then empty assignments are unset rather than erasing authored roots.
  expect(paths.roots).toEqual({
    userConfRoot: root,
    userDataRoot: "/file/data",
    userCacheRoot: "/file/cache",
    systemPluginRoot: "/file/system",
  });
  for (const [key, value] of Object.entries(paths.roots)) expect(merged[key]).toBe(value);
});

test.each(["host", "runtime option", "generic overlay"])(
  "empty %s discovery root falls through to root env",
  (kind) => {
    // Given a real env-selected config directory and an empty higher-precedence selector.
    const input = fixture();
    const root = input.rootOverrides?.userConfRoot ?? "";
    writeFileSync(join(root, "config.yml"), "userDataRoot: /env-discovered/data\n");
    const env = {
      LANDO_USER_CONF_ROOT: root,
      ...(kind === "generic overlay" ? { LANDO_CONFIG__USER_CONF_ROOT: "" } : {}),
    };
    const rootOverrides = {
      platform: "linux",
      home: root,
      ...(kind === "runtime option" ? { userConfRoot: "" } : {}),
    };
    const host = kind === "host" ? { userConfRoot: "" } : {};
    // When discovering files and resolving the effective roots.
    const stack = readGlobalConfigSources({ ...input, rootOverrides, host, env });
    const paths = makeLandoPaths({ ...rootOverrides, host, env });
    // Then both consumers discover the env-selected file and retain its data root.
    expect(paths.roots.userConfRoot).toBe(root);
    expect(paths.roots.userDataRoot).toBe("/env-discovered/data");
    expect(mergeGlobalConfigSources(stack).tree.userConfRoot).toBe(root);
  },
);
