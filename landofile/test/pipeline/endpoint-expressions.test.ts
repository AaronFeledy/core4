import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServiceName } from "@lando/sdk/schema";
import { Effect } from "effect";
import { lintLandofile } from "../../src/lint.ts";
import { loadLandofileLayers } from "../../src/service.ts";
import { makeTestLandofilePorts, makeTestLandofileStateStore } from "../support.ts";

const withEndpoints = async <T>(endpoints: string, run: (root: string) => Promise<T>) => {
  const root = await mkdtemp(join(tmpdir(), "lando-endpoint-expressions-"));
  try {
    await Bun.write(
      join(root, ".lando.yml"),
      `name: sample\nservices:\n  web:\n    endpoints:${endpoints}\n`,
    );
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const inputs = (root: string) =>
  ({
    ports: makeTestLandofilePorts(root),
    stateStore: makeTestLandofileStateStore(),
    templates: {
      modules: [],
      context: {
        env: { PORT: "80", EP: "http:80", INVALID_EP: "http:0" },
        scope: "app",
        bootstrapLevel: "plugins",
      },
    },
  }) as const;

test("attributes malformed evaluated shorthand to the item expression in load and lint", () =>
  withEndpoints('\n      - tcp:9000\n      - "{{ env.INVALID_EP }}"', async (root) => {
    const file = join(root, ".lando.yml");
    const path = ["services", "web", "endpoints", 1];
    const expected = {
      path,
      source: expect.objectContaining({ file, layer: "canonical", path }),
      message: expect.stringContaining("ui=http:8080"),
    };
    const loaded = await Effect.runPromise(Effect.flip(loadLandofileLayers(root, file, inputs(root))));
    expect(loaded).toMatchObject({
      _tag: "LandofileValidationError",
      issues: [expect.objectContaining(expected)],
    });
    const lint = await Effect.runPromise(lintLandofile({ cwd: root }, inputs(root)));
    expect(lint.violations).toEqual([expect.objectContaining({ ...expected, rule: "landofile.validation" })]);
  }));

test.each([
  '\n      - "{{ env.EP }}"',
  '\n      - "http:{{ env.PORT }}"',
  ' "{{ [env.EP] }}"',
  '\n      - kind: internal\n        protocol: http\n        port: "{{ number(env.PORT) }}"',
  "\n      - \"{{ { kind: 'internal', protocol: 'http', port: number(env.PORT) } }}\"",
])("decodes evaluated endpoint values: %s", async (endpoints) =>
  withEndpoints(endpoints, async (root) => {
    const loaded = await Effect.runPromise(loadLandofileLayers(root, join(root, ".lando.yml"), inputs(root)));
    expect(loaded.document.services?.[ServiceName.make("web")]?.endpoints).toEqual([
      { _tag: "internal", protocol: "http", port: 80 },
    ]);
    expect((await Effect.runPromise(lintLandofile({ cwd: root }, inputs(root)))).violations).toEqual([]);
  }),
);

test.each([
  { overlay: "!reset []", expected: undefined },
  {
    overlay: "!override [admin=http:8080]",
    expected: [{ _tag: "internal", name: "admin", protocol: "http", port: 8080 }],
  },
  {
    overlay: "\n      - name: ui\n        port: !override 8080\n        primary: !reset null",
    expected: [
      { _tag: "internal", name: "ui", protocol: "http", port: 8080 },
      { _tag: "internal", name: "metrics", protocol: "tcp", port: 9000 },
    ],
  },
])("applies endpoint directives before decoding $overlay", ({ overlay, expected }) =>
  withEndpoints(
    "\n      - kind: internal\n        name: ui\n        protocol: http\n        port: 80\n        primary: true\n      - metrics=tcp:9000",
    async (root) => {
      const file = join(root, ".lando.yml");
      await Bun.write(join(root, ".lando.local.yml"), `services:\n  web:\n    endpoints: ${overlay}\n`);
      const loaded = await Effect.runPromise(loadLandofileLayers(root, file, inputs(root)));
      expect(loaded.document.services?.[ServiceName.make("web")]?.endpoints).toEqual(expected);
    },
  ),
);
