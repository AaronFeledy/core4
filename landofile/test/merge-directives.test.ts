import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServiceName } from "@lando/sdk/schema";
import { Effect } from "effect";
import { lintLandofile } from "../src/lint.ts";
import { loadLandofileFile, loadLandofileLayers } from "../src/service.ts";
import { makeTestLandofilePorts, makeTestLandofileStateStore } from "./support.ts";

test.each(["yaml", "ts"])(
  "layered %s directives replace routes and remove inherited environment keys",
  async (form) => {
    const root = await mkdtemp(join(tmpdir(), "lando-native-directives-"));
    try {
      const canonical = join(root, ".lando.yml");
      await Bun.write(
        canonical,
        "name: directives\nservices:\n  web:\n    image: nginx\n    environment:\n      OLD: old\n      KEEP: yes\n    routes:\n      - old.test\n",
      );
      await Bun.write(
        join(root, form === "yaml" ? ".lando.local.yml" : ".lando.local.ts"),
        form === "yaml"
          ? "services:\n  web:\n    environment:\n      OLD: !reset\n    routes: !override\n      - hostname: new.test\n"
          : `import { override, reset } from ${JSON.stringify(join(import.meta.dir, "../../sdk/src/landofile/merge-directives.ts"))}; export default {services:{web:{environment:{OLD:reset()},routes:override([{hostname:"new.test"}])}}};`,
      );
      const result = await Effect.runPromise(
        loadLandofileLayers(root, canonical, {
          ports: makeTestLandofilePorts(root),
          templates: { modules: [] },
          stateStore: makeTestLandofileStateStore(),
        }),
      );
      expect(result.services?.[ServiceName.make("web")]).toEqual({
        image: "nginx",
        environment: { KEEP: "yes" },
        routes: [{ hostname: "new.test" }],
      });
      const lint = await Effect.runPromise(lintLandofile({ cwd: root }));
      expect(lint.valid).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("nested include operations reach values inherited from a lower outer layer", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-include-directives-"));
  try {
    const canonical = join(root, ".lando.yml");
    await Bun.write(
      canonical,
      "name: directives\nservices:\n  web:\n    environment:\n      OLD: old\n    routes:\n      - old.test\n",
    );
    await Bun.write(
      join(root, ".lando.local.yml"),
      "includes:\n  - fragment.yml\nservices:\n  web:\n    environment: {}\n",
    );
    await Bun.write(
      join(root, "fragment.yml"),
      "includes:\n  - nested.yml\nservices:\n  web:\n    environment:\n      INLINE: winner\n",
    );
    await Bun.write(
      join(root, "nested.yml"),
      "services:\n  web:\n    environment:\n      OLD: !reset\n      INLINE: nested\n    routes: !override\n      - new.test\n",
    );
    const result = await Effect.runPromise(
      loadLandofileLayers(root, canonical, {
        ports: makeTestLandofilePorts(root),
        templates: { modules: [] },
        stateStore: makeTestLandofileStateStore(),
      }),
    );
    expect(result.services?.[ServiceName.make("web")]).toEqual({
      environment: { INLINE: "winner" },
      routes: ["new.test"],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("standalone file loading consumes lowest-layer directives", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-single-directives-"));
  try {
    const file = join(root, ".lando.yml");
    await Bun.write(
      file,
      'name: directives\nservices:\n  web:\n    environment: !override\n      OLD: !reset "{{ missing.value }}"\n      KEEP: yes\n',
    );
    const result = await Effect.runPromise(loadLandofileFile(file));
    expect(result.services?.[ServiceName.make("web")]?.environment).toEqual({ KEEP: "yes" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each(["includes", "toolingIncludes"])(
  "%s override retains only the new tooling namespace",
  async (field) => {
    const root = await mkdtemp(join(tmpdir(), "lando-tooling-override-"));
    try {
      const canonical = join(root, ".lando.yml");
      const declaration = (name: string) =>
        field === "includes"
          ? `\n  - source: ./${name}.yml\n    kind: tooling\n    namespace: ${name}\n`
          : `\n  ${name}:\n    file: ./${name}.yml\n`;
      await Bun.write(join(root, "old.yml"), "tooling:\n  task:\n    cmd: old\n");
      await Bun.write(join(root, "new.yml"), "tooling:\n  task:\n    cmd: new\n");
      await Bun.write(canonical, `name: directives\n${field}:${declaration("old")}`);
      await Bun.write(join(root, ".lando.local.yml"), `${field}: !override${declaration("new")}`);
      const result = await Effect.runPromise(
        loadLandofileLayers(root, canonical, {
          ports: makeTestLandofilePorts(root),
          templates: { modules: [] },
          stateStore: makeTestLandofileStateStore(),
        }),
      );
      expect(Object.keys(result.tooling ?? {})).toEqual(["new:task"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.each(["!override\n  - source: ./tasks.yml\n    kind: tooling\n    namespace: new", "!reset"])(
  "nested include %s survives source rewriting and aggregation",
  async (operation) => {
    const root = await mkdtemp(join(tmpdir(), "lando-nested-tooling-directives-"));
    try {
      const canonical = join(root, ".lando.yml");
      await Bun.write(
        canonical,
        "name: directives\nincludes:\n  - source: ./old.yml\n    kind: tooling\n    namespace: old\n",
      );
      await Bun.write(join(root, "old.yml"), "tooling:\n  task:\n    cmd: old\n");
      await Bun.write(join(root, "nested", "tasks.yml"), "tooling:\n  task:\n    cmd: new\n");
      await Bun.write(join(root, "nested", "fragment.yml"), `includes: ${operation}\n`);
      await Bun.write(join(root, ".lando.local.yml"), "includes:\n  - ./nested/fragment.yml\n");
      const result = await Effect.runPromise(
        loadLandofileLayers(root, canonical, {
          ports: makeTestLandofilePorts(root),
          templates: { modules: [] },
          stateStore: makeTestLandofileStateStore(),
        }),
      );
      expect(Object.keys(result.tooling ?? {})).toEqual(operation.startsWith("!reset") ? [] : ["new:task"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
