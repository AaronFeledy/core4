import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeLandoPaths } from "@lando/paths";
import { PluginManifest, PluginName } from "@lando/sdk/schema";
import { PathsService, PluginRegistry, type ServiceType, StateStore } from "@lando/sdk/services";
import { makeStateStore } from "@lando/state-store/service";
import { Effect, Layer, Schema } from "effect";
import { appConfigLint } from "../../src/operations/app-config-lint.ts";
import * as PluginRegistryLayer from "../../src/plugins/registry.ts";
import { lintLandofileSnapshot } from "../../src/services/landofile-live.ts";
import { internalToolingTasksOf } from "../provenance-support.ts";

const serviceType: ServiceType = {
  id: "reserved-tooling-test",
  name: "reserved-tooling-test",
  base: "l337",
  schema: Schema.Unknown,
  resolve: (input) =>
    Effect.succeed({
      base: "l337" as const,
      normalizedConfig: input.service,
      features: [],
      tooling: { run: { cmd: "echo service-run", service: ":host" } },
    }),
};

const registryLayer = Layer.effect(
  PluginRegistry,
  Effect.map(PluginRegistry, (registry) =>
    PluginRegistry.of({
      ...registry,
      list: Effect.succeed([
        Schema.decodeUnknownSync(PluginManifest)({
          name: PluginName.make("@lando/reserved-tooling-test"),
          version: "1.0.0",
          api: 4,
          contributes: { serviceTypes: [serviceType.id] },
        }),
      ]),
      loadServiceType: (id) =>
        id === serviceType.id ? Effect.succeed(serviceType) : registry.loadServiceType(id),
    }),
  ),
).pipe(Layer.provide(PluginRegistryLayer.layer));

test.each([
  {
    content: "tooling:\n  t:\n    cmd: echo hi\n    deps: [other]\n    sources: [src]\n",
    findings: [
      {
        rule: "landofile.load",
        reason: "NotImplementedError",
        path: ["tooling", "t", "deps"],
        line: 5,
        column: 5,
      },
      {
        rule: "landofile.load",
        reason: "NotImplementedError",
        path: ["tooling", "t", "sources"],
        line: 6,
        column: 5,
      },
    ],
  },
  {
    content: "toolingIncludes:\n  frag:\n    file: tasks.yml\n    vars:\n      WHO:\n        sh: echo inc\n",
    findings: [
      { rule: "landofile.validation", path: ["toolingIncludes", "frag", "vars", "WHO"], line: 6, column: 7 },
    ],
  },
])(
  "returns located tooling load findings through appConfigLint (#2211, #2212): $content",
  async ({ content, findings }) => {
    const root = await mkdtemp(join(tmpdir(), "lando-lint-refused-"));
    try {
      await writeFile(join(root, ".lando.yml"), `name: refused\n${content}`);
      const result = await Effect.runPromise(
        appConfigLint({ cwd: root }).pipe(Effect.provide(registryLayer)),
      );
      expect(result.valid).toBe(false);
      expect(result.violations).toEqual(
        findings.map((finding) =>
          expect.objectContaining({
            ...finding,
            source: { file: join(root, ".lando.yml"), layer: "canonical", path: finding.path },
          }),
        ),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("lint reports dynamic var reference rules without making them planning checks", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-lint-dynamic-"));
  try {
    await writeFile(
      join(root, ".lando.yml"),
      [
        "name: dynamic",
        "tooling:",
        "  inspect:",
        "    service: ':host'",
        "    cmd: echo body",
        "    dir: '{{ vars.V }}'",
        "    vars:",
        "      A: '{{ vars.V }}'",
        "      V:",
        "        sh: echo computed",
        "",
      ].join("\n"),
    );
    const result = await Effect.runPromise(appConfigLint({ cwd: root }).pipe(Effect.provide(registryLayer)));
    expect(result.valid).toBe(false);
    expect(
      result.violations.filter((issue) => issue.rule === "landofile.tooling").map((issue) => issue.path),
    ).toEqual([
      ["tooling", "inspect", "dir"],
      ["tooling", "inspect", "vars", "A"],
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each([
  {
    label: "authored task",
    tooling: "tooling:\n  run:\n    cmd: echo authored\n    service: ':host'\n",
    message:
      "Tooling task run can't use the name run, which belongs to the built-in apps:scratch:run command.",
    suggestion: "Rename tooling task run; run belongs to apps:scratch:run.",
    sourcePath: ["tooling", "run"],
  },
  {
    label: "service-type task",
    tooling: "",
    message:
      "Service type reserved-tooling-test task run can't use the name run, which belongs to the built-in apps:scratch:run command.",
    suggestion:
      "Set tooling.run: false in the Landofile to drop service type reserved-tooling-test's task, or redefine it under another name.",
    sourcePath: ["services", "web", "type"],
  },
])(
  "reports reserved $label with its introducing source",
  async ({ tooling, message, suggestion, sourcePath }) => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "lando-lint-tooling-"));
    try {
      await writeFile(
        join(root, ".lando.yml"),
        `name: tooling\nservices:\n  web:\n    type: ${serviceType.id}\n    image: alpine:3.22\n    home: false\n${tooling}`,
      );
      // When
      const result = await Effect.runPromise(
        appConfigLint({ cwd: root }).pipe(Effect.provide(registryLayer)),
      );
      // Then
      expect(result.valid).toBe(false);
      expect(result.violations).toEqual([
        expect.objectContaining({
          rule: "landofile.tooling",
          path: ["tooling", "run"],
          message,
          suggestion,
          source: expect.objectContaining({
            file: join(root, ".lando.yml"),
            layer: "canonical",
            path: sourcePath,
          }),
        }),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.each(["false", "\n    disabled: true"])(
  "overlay %s drops a service type's reserved task",
  async (task) => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "lando-lint-tooling-disabled-"));
    try {
      await writeFile(
        join(root, ".lando.yml"),
        `name: tooling\nservices:\n  web:\n    type: ${serviceType.id}\n    image: alpine:3.22\n    home: false\n`,
      );
      await writeFile(join(root, ".lando.local.yml"), `tooling:\n  run: ${task}\n`);
      // When
      const result = await Effect.runPromise(
        appConfigLint({ cwd: root }).pipe(Effect.provide(registryLayer)),
      );
      // Then
      expect(result).toMatchObject({ valid: true, violations: [] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("lint accepts all tooling task shorthands", async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "lando-lint-tooling-shorthand-"));
  try {
    await writeFile(
      join(root, ".lando.yml"),
      "name: shorthand\ntooling:\n  foo: false\n  bar:\n    cmd: disabled\n  baz: echo hi\n",
    );
    // When
    const result = await Effect.runPromise(appConfigLint({ cwd: root }).pipe(Effect.provide(registryLayer)));
    // Then
    expect(result).toMatchObject({ valid: true, violations: [] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each([true, false])("reserved scratch include task with internal=%s", async (internal) => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "lando-lint-tooling-include-"));
  try {
    await writeFile(
      join(root, ".lando.yml"),
      `name: tooling\ntoolingIncludes:\n  scratch:\n    file: ./tasks.yml\n    internal: ${internal}\n`,
    );
    await writeFile(
      join(root, "tasks.yml"),
      "tooling:\n  check:\n    cmd: echo check\n    service: ':host'\n",
    );
    const layers = Layer.mergeAll(
      PluginRegistryLayer.layer,
      Layer.succeed(PathsService, makeLandoPaths({ userCacheRoot: join(root, "cache") })),
      Layer.succeed(
        StateStore,
        makeStateStore({
          privateFileAccess: { enforce: async () => undefined, verify: async () => undefined },
        }),
      ),
    );
    // When
    const result = await Effect.runPromise(appConfigLint({ cwd: root }).pipe(Effect.provide(layers)));
    const snapshot = await Effect.runPromise(
      lintLandofileSnapshot({ cwd: root }).pipe(Effect.provide(layers)),
    );
    // Then
    expect(snapshot.resolved?.document.tooling).toHaveProperty(["scratch:check"]);
    expect(internalToolingTasksOf(snapshot.resolved ?? {}).includes("scratch:check")).toBe(internal);
    expect(result.valid).toBe(internal);
    expect(result.violations.map(({ rule, path, source }) => ({ rule, path, source }))).toEqual(
      internal
        ? []
        : [
            {
              rule: "landofile.tooling",
              path: ["tooling", "scratch:check"],
              source: { file: join(root, "tasks.yml"), layer: "canonical", path: ["tooling", "check"] },
            },
          ],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("flags host tooling Bun Shell dialect on cmd path", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-lint-host-shell-tooling-"));
  try {
    await writeFile(
      join(root, ".lando.yml"),
      'name: hostshell\ntooling:\n  bad:\n    service: ":host"\n    cmd: "echo $${NAME}"\n  ok:\n    service: ":host"\n    cmd: "echo $NAME 1>&2"\n  container:\n    service: web\n    cmd: "echo $${NAME}"\n',
    );
    const result = await Effect.runPromise(
      appConfigLint({ cwd: root }).pipe(Effect.provide(PluginRegistryLayer.layer)),
    );
    expect(result.valid).toBe(false);
    const hostShell = result.violations.filter((v) => v.rule === "landofile.host-shell");
    expect(hostShell.map((v) => v.path)).toEqual([["tooling", "bad", "cmd"]]);
    expect(hostShell[0]?.message).toContain("Column ");
    expect(hostShell[0]?.suggestion).toBeTruthy();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("skips host tooling cmd that still has pending {{ args.* }} sites", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-lint-host-shell-pending-"));
  try {
    await writeFile(
      join(root, ".lando.yml"),
      'name: hostshell\ntooling:\n  greet:\n    service: ":host"\n    args:\n      name:\n        order: 0\n        required: true\n    cmd: "echo {{ args.name }} $${BROKEN}"\n',
    );
    const result = await Effect.runPromise(
      appConfigLint({ cwd: root }).pipe(Effect.provide(PluginRegistryLayer.layer)),
    );
    expect(result.violations.filter((v) => v.rule === "landofile.host-shell")).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("skips argv host tooling commands", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-lint-host-shell-argv-"));
  try {
    await writeFile(
      join(root, ".lando.yml"),
      'name: hostshell\ntooling:\n  argv:\n    service: ":host"\n    cmd: ["echo", "$${NAME}"]\n',
    );
    const result = await Effect.runPromise(
      appConfigLint({ cwd: root }).pipe(Effect.provide(PluginRegistryLayer.layer)),
    );
    expect(result.violations.filter((v) => v.rule === "landofile.host-shell")).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lint reports route-fact reads that cannot resolve at invocation as errors", async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "lando-lint-service-url-"));
  try {
    await writeFile(
      join(root, ".lando.yml"),
      [
        "name: urls",
        "services:",
        "  web:",
        "    type: compose",
        "    image: nginx:1.27",
        "    endpoints: ['http:80']",
        "    routes: ['*.wild.test']",
        "  api:",
        "    type: compose",
        "    image: nginx:1.27",
        "    endpoints: ['http:80']",
        "    routes: [api.test]",
        "tooling:",
        "  ping:",
        "    service: ':host'",
        "    cmd: curl {{ services.web.hostname }} {{ services.ghost.publicPort }} {{ services.api.scheme }}",
        "events:",
        "  pre-start:",
        "    - curl {{ services.api.url }}",
        "  post-start:",
        "    - curl {{ services.api.url }}",
        "",
      ].join("\n"),
    );
    // When
    const result = await Effect.runPromise(appConfigLint({ cwd: root }).pipe(Effect.provide(registryLayer)));
    // Then
    expect(
      result.violations
        .filter((issue) => issue.rule === "landofile.tooling")
        .map((issue) => [issue.path.join("."), issue.reason, issue.severity]),
    ).toEqual([
      ["events.pre-start.0", "event-phase", "error"],
      ["tooling.ping.cmd", "no-route", "error"],
      ["tooling.ping.cmd", "unknown-service", "error"],
    ]);
    expect(result.violations).toContainEqual(
      expect.objectContaining({
        reason: "unknown-service",
        message: expect.stringContaining("services.ghost.publicPort is unavailable:"),
      }),
    );
    expect(result.valid).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lint only warns about a route-fact read when routing is disabled", async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "lando-lint-service-url-disabled-"));
  try {
    await writeFile(
      join(root, ".lando.yml"),
      [
        "name: urls",
        "router:",
        "  enabled: false",
        "services:",
        "  web:",
        "    type: compose",
        "    image: nginx:1.27",
        "    endpoints: ['http:80']",
        "tooling:",
        "  ping:",
        "    service: ':host'",
        "    cmd: curl {{ services.web.origin }}",
        "",
      ].join("\n"),
    );
    // When
    const result = await Effect.runPromise(appConfigLint({ cwd: root }).pipe(Effect.provide(registryLayer)));
    // Then
    expect(
      result.violations
        .filter((issue) => issue.rule === "landofile.tooling")
        .map((issue) => [issue.path.join("."), issue.reason, issue.severity]),
    ).toEqual([["tooling.ping.cmd", "routing-disabled", "warning"]]);
    expect(result.valid).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lint tells a generated default route from a service with no HTTP listener and skips unresolved services", async () => {
  // Given three services without authored routes: one serves HTTP, one serves only TCP, and one
  // has a type lint cannot resolve
  const root = await mkdtemp(join(tmpdir(), "lando-lint-service-url-default-"));
  try {
    await writeFile(
      join(root, ".lando.yml"),
      [
        "name: urls",
        "services:",
        "  web:",
        "    type: compose",
        "    image: nginx:1.27",
        "    endpoints: ['http:80']",
        "  cache:",
        "    type: compose",
        "    image: redis:7",
        "    endpoints: ['tcp:6379']",
        "  mystery:",
        "    type: not-a-registered-type",
        "tooling:",
        "  ping:",
        "    service: ':host'",
        "    cmd: curl {{ services.web.url }} {{ services.cache.scheme }} {{ services.mystery.url }}",
        "",
      ].join("\n"),
    );
    // When
    const result = await Effect.runPromise(appConfigLint({ cwd: root }).pipe(Effect.provide(registryLayer)));
    // Then only the TCP-only service is reported
    expect(
      result.violations
        .filter((issue) => issue.rule === "landofile.tooling")
        .map((issue) => [issue.path.join("."), issue.reason, issue.message]),
    ).toEqual([
      ["tooling.ping.cmd", "no-route", expect.stringContaining("services.cache.scheme is unavailable:")],
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each(["url", "hostname", "origin", "publicPort", "scheme"])(
  "lint refuses a placement field that follows a var reading %s",
  async (fact) => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "lando-lint-service-url-var-"));
    try {
      await writeFile(
        join(root, ".lando.yml"),
        [
          "name: urls",
          "tooling:",
          "  ping:",
          "    service: ':host'",
          "    cmd: echo body",
          "    dir: '{{ vars.home }}'",
          "    vars:",
          "      home: '{{ vars.site }}'",
          `      site: '{{ services.web.${fact} }}'`,
          "",
        ].join("\n"),
      );
      // When
      const result = await Effect.runPromise(
        appConfigLint({ cwd: root }).pipe(Effect.provide(registryLayer)),
      );
      // Then
      expect(result.violations).toContainEqual(
        expect.objectContaining({
          rule: "landofile.tooling",
          reason: "service-url-placement",
          path: ["tooling", "ping", "dir"],
        }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
