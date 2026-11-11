import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Global the fixture subscribers append `<app>/<event tag>` deliveries to. */
export const DELIVERIES_KEY = "__landoMcpAppFixtureDeliveries";

export const fixtureDeliveries = (): ReadonlyArray<string> => {
  const value: unknown = Reflect.get(globalThis, DELIVERIES_KEY);
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
};

export interface FixtureApp {
  readonly root: string;
  readonly entry: string;
  /** Where the lazily imported command module goes; absent until a test writes it. */
  readonly lazyModule: string;
  readonly registry: string;
}

interface FixtureAppOptions {
  /** Commands the app-local plugin contributes; the shared id takes app-specific flags. */
  readonly commands: ReadonlyArray<string>;
  /** Service type id the plugin contributes and the Landofile uses. */
  readonly serviceType: string;
  /** A command whose spec the entry imports lazily from `./lazy.ts`. */
  readonly lazyCommand?: string;
}

const entrySource = (letter: string, options: FixtureAppOptions) => `import { Effect, Schema } from "effect";
const flags = { "${letter}flag": { type: "string" } };
export const commands = new Map([
  ...${JSON.stringify(options.commands)}.map((id) => [id, async () => ({
    id,
    namespace: id.split(":")[0],
    bootstrap: "app",
    resultSchema: Schema.Struct({ app: Schema.String, id: Schema.String }),
    ...(id === "fixture:shared" ? { flags } : {}),
    run: () => Effect.succeed({ app: "${letter}", id }),
  })]),
  ...${JSON.stringify(options.lazyCommand === undefined ? [] : [options.lazyCommand])}.map((id) => [
    id,
    async () => (await import("./lazy.ts")).spec,
  ]),
]);
export const serviceTypes = new Map([["${options.serviceType}", {
  id: "${options.serviceType}",
  name: "${options.serviceType}",
  base: "lando",
  schema: Schema.Unknown,
  resolve: ({ service }) => Effect.succeed({ base: "lando", normalizedConfig: service, features: [] }),
}]]);
`;

const subscriberSource = (letter: string) => `import { Effect } from "effect";
export default () => (event) =>
  Effect.sync(() => {
    globalThis["${DELIVERIES_KEY}"] = [...(globalThis["${DELIVERIES_KEY}"] ?? []), "${letter}/" + event._tag];
  });
`;

/** Write an app whose `.lando/plugins` registry selects one plugin named `@example/app-<letter>`. */
export const writeFixtureApp = async (
  parent: string,
  letter: string,
  options: FixtureAppOptions,
): Promise<FixtureApp> => {
  const root = join(parent, letter);
  const plugin = join(root, ".lando", "plugins", `app-${letter}`);
  await mkdir(plugin, { recursive: true });
  const name = `@example/app-${letter}`;
  const manifest = {
    name,
    version: "1.0.0",
    api: 4,
    entry: "index.ts",
    contributes: {
      commands: [
        ...options.commands,
        ...(options.lazyCommand === undefined ? [] : [options.lazyCommand]),
      ].map((id) => ({ id, summary: `Fixture ${id}` })),
      serviceTypes: [options.serviceType],
    },
    // Observes the shared command, so only plugins that define it subscribe.
    ...(options.commands.includes("fixture:shared")
      ? {
          subscribers: [
            { id: "observe", selectors: [{ event: "cli-fixture:shared-run" }], module: "./subscriber.ts" },
          ],
        }
      : {}),
  };
  await writeFile(join(plugin, "package.json"), JSON.stringify({ landoPlugin: manifest }));
  await writeFile(join(plugin, "index.ts"), entrySource(letter, options));
  await writeFile(join(plugin, "subscriber.ts"), subscriberSource(letter));
  const registry = join(root, ".lando", "plugins", "registry.json");
  await writeFile(registry, JSON.stringify({ [name]: { name, version: "1.0.0", path: plugin } }));
  await writeFile(
    join(root, ".lando.yml"),
    `name: app-${letter}\nservices:\n  web:\n    type: ${options.serviceType}\n    image: alpine\n`,
  );
  return { root, entry: join(plugin, "index.ts"), lazyModule: join(plugin, "lazy.ts"), registry };
};

export const fixtureRoot = async (label: string): Promise<string> =>
  realpath(await mkdtemp(join(tmpdir(), `lando-mcp-${label}-`)));

/** Source of a lazily imported command module for `writeFixtureApp`'s `lazyCommand`. */
export const lazyCommandSource = (id: string) => `import { Effect, Schema } from "effect";
export const spec = {
  id: "${id}",
  namespace: "${id.split(":")[0]}",
  bootstrap: "app",
  resultSchema: Schema.Struct({ id: Schema.String }),
  run: () => Effect.succeed({ id: "${id}" }),
};
`;
