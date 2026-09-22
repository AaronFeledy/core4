import { describe, expect, test } from "bun:test";
import { LEGACY_TAGGED, type LegacyTagged } from "@lando/sdk/landofile";
import { LandofileAuthoringFragment, classifyAuthoringSource } from "@lando/sdk/schema";
import { createRedactor } from "@lando/sdk/secrets";
import { Effect, Schema } from "effect";
import { lowerLegacyTag } from "../src/legacy-tags.ts";
import { makeLando3ConfigTranslator } from "../src/translator.ts";
import { isPlainRecord } from "../src/v4-merge.ts";
import { document, documentSet, fakeDecomposers } from "./fixtures/fake-decomposers.ts";

const translateFiles = (files: ReadonlyArray<readonly [string, string]>) => {
  const translator = makeLando3ConfigTranslator({
    decomposers: fakeDecomposers().decomposers,
    redactor: createRedactor("secrets"),
  });
  return Effect.runPromise(
    translator.translate(documentSet(files.map(([path, text]) => document(path, text)))),
  );
};
const translate = (text: string) => translateFiles([[".lando.yml", text]]);
const summary = (result: Awaited<ReturnType<typeof translate>>) =>
  result.diagnostics.map(({ kind, keyPath }) => `${kind} ${keyPath.join(".")}`);
const fragment = (result: Awaited<ReturnType<typeof translate>>) => {
  const [output] = result.outputs;
  if (output === undefined) throw new Error("expected one output");
  Schema.decodeUnknownSync(LandofileAuthoringFragment)(output.fragment, { onExcessProperty: "error" });
  if (!isPlainRecord(output.fragment)) throw new Error("expected a mapping fragment");
  return output.fragment;
};
const section = (result: Awaited<ReturnType<typeof translate>>, key: string): unknown =>
  result.outputs
    .map(({ fragment: output }): unknown => {
      const value: unknown = output;
      return isPlainRecord(value) ? value[key] : undefined;
    })
    .find((value) => value !== undefined);
const span = { start: { line: 1, column: 1, offset: 0 }, end: { line: 1, column: 2, offset: 1 } };
const makeLegacyTagged = (tag: string, value: unknown, at: typeof span): LegacyTagged => ({
  [LEGACY_TAGGED]: true,
  tag,
  value,
  span: at,
});

describe("tooling", () => {
  test("lowers commands, lists, and multi-service entries to tasks and ordered cmds", async () => {
    // Given / When
    const result = await translate(
      [
        "services: {appserver: {type: 'php:8.3'}, node: {type: 'node:22'}}",
        "tooling:",
        "  git: {service: appserver}",
        "  drush: {service: appserver, description: Run drush, cmd: drush --root=/app/web}",
        "  test: {service: appserver, cmd: [php -v, php -m]}",
        "  install:",
        "    cmd:",
        "      - appserver: composer install",
        "      - node: pnpm install",
        "  iamroot: {service: appserver, cmd: id, user: root, dir: /tmp, env: {TIMEOUT: 600, LANDO_X: y}}",
        "  xdebug-off: disabled",
        "  php: false",
      ].join("\n"),
    );
    // Then
    expect(fragment(result).tooling).toEqual({
      git: { service: "appserver", cmd: "git" },
      drush: { service: "appserver", description: "Run drush", cmd: "drush --root=/app/web" },
      test: { service: "appserver", cmds: ["php -v", "php -m"] },
      install: {
        cmds: [
          { cmd: "composer install", service: "appserver" },
          { cmd: "pnpm install", service: "node" },
        ],
      },
      iamroot: { service: "appserver", cmd: "id", dir: "/tmp", env: { TIMEOUT: 600 }, user: "root" },
      "xdebug-off": { disabled: true },
      php: { disabled: true },
    });
    expect(summary(result)).toEqual([
      "generated tooling.git",
      "rewritten tooling.test.cmd",
      "rewritten tooling.install.cmd",
      "rewritten tooling.iamroot.user",
      "dropped tooling.iamroot.env.LANDO_X",
      "rewritten tooling.xdebug-off",
      "rewritten tooling.php",
    ]);
  });

  test("lowers options and positionals to flags and args", async () => {
    // Given / When
    const result = await translate(
      [
        "services: {appserver: {type: 'php:8.3'}}",
        "tooling:",
        "  word:",
        "    service: appserver",
        "    cmd: /app/word.sh",
        "    options:",
        "      word: {passthrough: true, alias: [w, x], describe: The word, interactive: {type: input}}",
        "      env: {choices: [dev, live], default: test, demandOption: true}",
        "      no-wipe: {boolean: true, default: 'no'}",
        "  'drupal-update <core> [module]':",
        "    service: appserver",
        "    cmd: composer update $2",
        "    positionals: {module: {describe: Module, default: views}}",
      ].join("\n"),
    );
    // Then
    expect(fragment(result).tooling).toEqual({
      word: {
        service: "appserver",
        cmd: "/app/word.sh",
        flags: {
          word: { alias: "w", description: "The word" },
          env: { choices: ["dev", "live"], required: true },
          "no-wipe": { boolean: true },
        },
      },
      "drupal-update": {
        service: "appserver",
        cmd: "composer update $2",
        args: {
          core: { order: 0, required: true },
          module: { order: 1, description: "Module", default: "views" },
        },
      },
    });
    expect(summary(result)).toEqual([
      "rewritten tooling.word.options",
      "dropped tooling.word.options.word.alias.1",
      "dropped tooling.word.options.word.interactive",
      "dropped tooling.word.options.env.default",
      "dropped tooling.word.options.no-wipe.default",
      "rewritten tooling.drupal-update <core> [module]",
      "needs-review tooling.drupal-update <core> [module].cmd",
    ]);
  });

  test("reads the service from a declared option and renames a host option", async () => {
    // Given / When
    const result = await translate(
      [
        "tooling:",
        "  whoami: {cmd: whoami, service: ':service', options: {service: {default: appserver, alias: [s]}}}",
        "  what-host: {cmd: env, service: ':host', options: {host: {default: node}}}",
        "  broken: {cmd: env, service: ':missing'}",
      ].join("\n"),
    );
    // Then
    expect(section(result, "tooling")).toEqual({
      whoami: {
        cmd: "whoami",
        service: ":service",
        flags: { service: { alias: "s", default: "appserver" } },
      },
      "what-host": { cmd: "env", service: ":host-service", flags: { "host-service": { default: "node" } } },
    });
    expect(summary(result)).toEqual([
      "rewritten tooling.whoami.service",
      "rewritten tooling.whoami.options",
      "needs-review tooling.what-host.service",
      "rewritten tooling.what-host.options",
      "unsupported tooling.broken.service",
    ]);
  });

  test("diagnoses level, usage, examples, interactive, and background exactly once across layers", async () => {
    // Given / When
    const result = await translateFiles([
      [
        ".lando.base.yml",
        [
          "plugins: {'@lando/php': ^1}",
          "keys: [id_rsa]",
          "tooling:",
          "  bg: {service: node, cmd: sleep infinity &, level: engine, usage: $0 bg, examples: [$0 bg], interactive: true}",
        ].join("\n"),
      ],
      [".lando.yml", "name: app\nservices: {node: {type: 'node:22'}}\n"],
    ]);
    // Then
    expect(summary(result)).toEqual([
      "dropped plugins",
      "dropped keys",
      "dropped tooling.bg.cmd",
      "dropped tooling.bg.level",
      "dropped tooling.bg.usage",
      "dropped tooling.bg.examples",
      "dropped tooling.bg.interactive",
    ]);
    const merged = section(result, "tooling");
    expect(merged).toEqual({ bg: { service: "node", cmd: "sleep infinity" } });
  });

  test("keeps shell text literal under Lando 4 expression syntax", async () => {
    // Given / When
    const result = await translate(
      [
        "tooling:",
        "  fmt: {service: web, cmd: \"docker inspect -f '{{.Id}}' ${NAME} $HOME ${1}\"}",
        "  dflt: {service: web, cmd: 'echo ${1:-core}'}",
        "  glued: {service: web, cmd: 'echo ${NAME}_x'}",
      ].join("\n"),
    );
    // Then
    expect(section(result, "tooling")).toEqual({
      fmt: { service: "web", cmd: "docker inspect -f '{{{{.Id}}' $NAME $HOME $1" },
    });
    expect(summary(result)).toEqual([
      "rewritten tooling.fmt.cmd",
      "needs-review tooling.fmt.cmd",
      "unsupported tooling.dflt.cmd",
      "unsupported tooling.glued.cmd",
    ]);
  });

  test("rejects names and orders Lando 4 cannot register", async () => {
    // Given / When
    const result = await translate(
      "tooling:\n  'x [a] <b>': {service: web, cmd: x}\n  'y z': {service: web, cmd: y}\n  imported: !load task.yml\n",
    );
    // Then
    expect(summary(result)).toEqual([
      "unsupported tooling.x [a] <b>",
      "unsupported tooling.y z",
      "unsupported tooling.imported",
    ]);
  });
});

describe("tags", () => {
  test("rewrites load and import tags to load expressions with the Lando 3 decoder", () => {
    // Given
    const cases = [
      ["!load", "scripts/build.sh", "{{ load('scripts/build.sh') | text }}"],
      ["!import", "scripts/word.sh", "{{ load('scripts/word.sh') | text }}"],
      ["!load", "data.json", "{{ load('data.json') | json }}"],
      ["!load", "data.yml", "{{ load('data.yml') | yaml }}"],
      ["!load", "settings.toml", "{{ load('settings.toml') | text }}"],
      ["!load", "notes.txt @json", "{{ load('notes.txt') | json }}"],
      ["!load", "script@string", "{{ load('script') | text }}"],
      ["!load", "values.yaml@yml", "{{ load('values.yaml') | yaml }}"],
    ] as const;
    for (const [tag, value, expected] of cases) {
      // When
      const lowered = lowerLegacyTag(makeLegacyTagged(tag, value, span));
      // Then
      expect(lowered).toMatchObject({ _tag: "expression", source: expected });
      expect(classifyAuthoringSource(expected)).toBe("expression");
    }
  });

  test("refuses tags that cannot become a text load", () => {
    // Given
    const cases = [
      makeLegacyTagged("!load", "logo.png@binary", span),
      makeLegacyTagged("!load", "/etc/passwd", span),
      makeLegacyTagged("!load", "it's.sh", span),
      makeLegacyTagged("!secret", "token", span),
      makeLegacyTagged("!load", { file: "x" }, span),
    ];
    // When / Then
    for (const tagged of cases) expect(lowerLegacyTag(tagged)._tag).toBe("unsupported");
  });
});

describe("events", () => {
  test("names the default service and preserves step order", async () => {
    // Given / When
    const result = await translate(
      [
        "services:",
        "  web: {type: compose, services: {image: 'nginx:1'}}",
        "  appserver: {type: 'php:8.3'}",
        "  node: {type: 'node:22'}",
        "tooling:",
        "  db-import: {service: node, cmd: import}",
        "events:",
        "  pre-start:",
        "    - mkdir -p /app/private",
        "    - node: !import scripts/paperback.sh",
        "    - appserver: [drush, cr]",
        "  post-db-import:",
        "    - drush updb",
        "  post-restart:",
        "    - appserver: drush cr",
        "  post-stop: []",
      ].join("\n"),
    );
    // Then
    expect(fragment(result).events).toEqual({
      "pre-start": [
        { cmd: "mkdir -p /app/private", service: "appserver" },
        { cmd: "{{ load('scripts/paperback.sh') | text }}", service: "node" },
        { cmd: "drush cr", service: "appserver" },
      ],
      "post-db-import": [{ cmd: "drush updb", service: "node" }],
      "post-restart": [{ cmd: "drush cr", service: "appserver" }],
    });
    expect(summary(result)).toEqual([
      "generated events.pre-start.0",
      "rewritten events.pre-start.1.node",
      "rewritten events.post-db-import",
      "generated events.post-db-import.0",
      "rewritten events.post-restart",
    ]);
  });

  test("keeps nested lando calls as shell steps so no converted event re-enters the runtime", async () => {
    // Given / When
    const result = await translate(
      "services: {appserver: {type: 'php:8.3'}}\ntooling:\n  a: {service: appserver, cmd: lando b}\n  b: {service: appserver, cmd: lando a}\nevents:\n  pre-a: [lando b]\n  post-b: [lando a]\n",
    );
    // Then
    const events = section(result, "events");
    expect(events).toEqual({
      "pre-a": [{ cmd: "lando b", service: "appserver" }],
      "post-b": [{ cmd: "lando a", service: "appserver" }],
    });
    const steps = isPlainRecord(events) ? Object.values(events).flat() : [];
    for (const step of steps)
      expect(Object.keys(isPlainRecord(step) ? step : {}).sort()).toEqual(["cmd", "service"]);
  });

  test("drops events Lando 4 would reject", async () => {
    // Given / When
    const result = await translate(
      "services: {appserver: {type: 'php:8.3'}}\nevents:\n  pre-uninstall: [echo bye]\n  post-db-import: [drush cr]\n  post-pull: [echo]\n",
    );
    // Then
    expect(summary(result)).toEqual([
      "dropped events.pre-uninstall",
      "dropped events.post-db-import",
      "dropped events.post-pull",
    ]);
    expect(section(result, "events")).toBeUndefined();
  });

  test.each([
    ["an API-4 primary service", "services: {a: {type: compose}, b: {api: 4, primary: true, image: x}}", "b"],
    ["the first API-3 service", "services: {c: {type: compose}, d: {type: 'node:22'}}", "d"],
    ["the first Compose service", "services: {e: {type: compose, services: {image: x}}}", "e"],
    ["appserver", "{}", "appserver"],
  ])("falls back to %s", async (_label, services, expected) => {
    // Given / When
    const result = await translate(
      `${services.startsWith("{") ? "" : services}\nevents: {pre-start: [echo]}\n`,
    );
    // Then
    expect(section(result, "events")).toEqual({ "pre-start": [{ cmd: "echo", service: expected }] });
  });

  test("uses a dynamic task's flag default for its bracket events", async () => {
    // Given / When
    const result = await translate(
      "tooling:\n  who: {cmd: whoami, service: ':s', options: {s: {default: node}}}\nevents:\n  pre-who: [date]\n",
    );
    // Then
    expect(section(result, "events")).toEqual({ "pre-who": [{ cmd: "date", service: "node" }] });
  });
});
