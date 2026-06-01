import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit } from "effect";

import {
  NotImplementedError,
  RecipeManifestParseError,
  RecipeManifestValidationError,
} from "@lando/sdk/errors";

import {
  nodePostgresRecipeSource,
  nodePostgresRecipeYaml,
} from "../../src/recipes/builtin/node-postgres/manifest.ts";
import { parseRecipe } from "../../src/recipes/manifest/service.ts";

const runParse = async (source: string, content: string) =>
  Effect.runPromiseExit(parseRecipe(source, content));

const expectFailure = <E>(exit: Exit.Exit<unknown, E>): E => {
  expect(Exit.isFailure(exit)).toBe(true);
  if (!Exit.isFailure(exit)) throw new Error("expected failure");
  const failure = Cause.failureOption(exit.cause);
  expect(failure._tag).toBe("Some");
  if (failure._tag !== "Some") throw new Error("expected tagged failure");
  return failure.value;
};

describe("RecipeManifestService.parse — happy paths (§8.8.3)", () => {
  test("metadata: required id/title/description/version with optional authors/tags/requires", async () => {
    const yaml = `id: my-app
title: My App
description: A friendly app.
version: 1.2.3
authors:
  - Alice
  - Bob
tags:
  - sample
  - alpha
requires:
  lando: ^4.0.0
  hostTools:
    - git
`;
    const exit = await runParse("test://metadata", yaml);
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    const manifest = exit.value;
    expect(manifest.id).toBe("my-app");
    expect(manifest.title).toBe("My App");
    expect(manifest.description).toBe("A friendly app.");
    expect(manifest.version).toBe("1.2.3");
    expect(manifest.authors).toEqual(["Alice", "Bob"]);
    expect(manifest.tags).toEqual(["sample", "alpha"]);
    expect(manifest.requires?.lando).toBe("^4.0.0");
    expect(manifest.requires?.hostTools).toEqual(["git"]);
  });

  test("prompts: each Alpha prompt type decodes", async () => {
    const yaml = `id: prompts-cover
title: Prompts
description: One prompt of each Alpha type.
version: 0.1.0
prompts:
  - name: title
    type: text
    message: Title?
    default: My Site
  - name: framework
    type: select
    message: Framework?
    choices:
      - laravel
      - symfony
  - name: features
    type: multiselect
    message: Features?
    choices:
      - value: redis
        label: Redis cache
      - value: queue
        label: Queue worker
        description: Background processor
  - name: install
    type: confirm
    message: Install deps now?
    default: true
  - name: workers
    type: number
    message: How many workers?
    default: 2
    validate:
      min: 1
      max: 8
  - name: dbPassword
    type: secret
    message: Database password?
  - name: docroot
    type: path
    message: Docroot?
    default: web
    validate:
      exists: false
`;
    const exit = await runParse("test://prompts", yaml);
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    const prompts = exit.value.prompts ?? [];
    expect(prompts.map((p) => p.type)).toEqual([
      "text",
      "select",
      "multiselect",
      "confirm",
      "number",
      "secret",
      "path",
    ]);
    expect(prompts[0]?.default).toBe("My Site");
    expect(prompts[3]?.default).toBe(true);
    expect(prompts[4]?.validate?.min).toBe(1);
    expect(prompts[4]?.validate?.max).toBe(8);
    expect(prompts[6]?.validate?.exists).toBe(false);
  });

  test("files: src/dest/when/mode/template/engine fields decode", async () => {
    const yaml = `id: files-cover
title: Files
description: File manifest with every supported field.
version: 0.0.1
files:
  - src: templates/.lando.yml.tmpl
    dest: .lando.yml
    template: true
  - src: assets/server.js
    dest: server.js
    template: false
  - src: templates/script.sh.tmpl
    dest: bin/script.sh
    when: answers.installScript
    mode: "0755"
    engine: handlebars
`;
    const exit = await runParse("test://files", yaml);
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    const files = exit.value.files ?? [];
    expect(files).toHaveLength(3);
    expect(files[2]?.mode).toBe("0755");
    expect(files[2]?.engine).toBe("handlebars");
    expect(files[2]?.when).toBe("answers.installScript");
  });

  test("Landofile output: recipe can describe a .lando.yml emission", async () => {
    const yaml = `id: lando-output
title: Landofile Output
description: Recipe emits a .lando.yml file.
version: 0.0.1
files:
  - src: templates/.lando.yml.tmpl
    dest: .lando.yml
    template: true
`;
    const exit = await runParse("test://lando-output", yaml);
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    const landofileEntry = exit.value.files?.find((f) => f.dest === ".lando.yml");
    expect(landofileEntry).toBeDefined();
    expect(landofileEntry?.template).toBe(true);
  });

  test("postInit: gitInit / message / command / bun.install all decode", async () => {
    const yaml = `id: post-init
title: Post init
description: One of each Alpha post-init action.
version: 0.0.1
postInit:
  - type: gitInit
  - type: message
    text: Done!
  - type: command
    cmd: app:start
    args:
      - --yes
  - type: bun
    verb: install
    cwd: .
`;
    const exit = await runParse("test://post-init", yaml);
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    const actions = exit.value.postInit ?? [];
    expect(actions.map((a) => a.type)).toEqual(["gitInit", "message", "command", "bun"]);
    const command = actions[2];
    expect(command?.type).toBe("command");
    if (command?.type === "command") {
      expect(command.cmd).toBe("app:start");
      expect(command.args).toEqual(["--yes"]);
    }
    const bun = actions[3];
    expect(bun?.type).toBe("bun");
    if (bun?.type === "bun") {
      expect(bun.verb).toBe("install");
      expect(bun.cwd).toBe(".");
    }
  });
});

describe("RecipeManifestService.parse — Beta-deferred rejections (§8.8)", () => {
  const baseHeader = `id: beta-rejection
title: Beta rejection
description: Trigger one Beta surface per case.
version: 0.0.1
`;

  test("top-level `runs:` is rejected with §8.8.14 remediation", async () => {
    const yaml = `${baseHeader}runs:
  - pantheon:list-sites
`;
    const exit = await runParse("test://beta-runs", yaml);
    const error = expectFailure(exit);
    expect(error).toBeInstanceOf(NotImplementedError);
    if (error instanceof NotImplementedError) {
      expect(error.specSection).toBe("§8.8.14");
      expect(error.message).toContain("runs");
      expect(error.remediation).toContain("Beta");
    }
  });

  test("top-level `fetchAllowlist:` is rejected with §8.8.14 remediation", async () => {
    const yaml = `${baseHeader}fetchAllowlist:
  - https://api.example.com
`;
    const exit = await runParse("test://beta-fetch", yaml);
    const error = expectFailure(exit);
    expect(error).toBeInstanceOf(NotImplementedError);
    if (error instanceof NotImplementedError) {
      expect(error.specSection).toBe("§8.8.14");
      expect(error.message).toContain("fetchAllowlist");
    }
  });

  test("prompt type `editor` is rejected with §8.8.5 remediation", async () => {
    const yaml = `${baseHeader}prompts:
  - name: notes
    type: editor
    message: Notes?
`;
    const exit = await runParse("test://beta-editor", yaml);
    const error = expectFailure(exit);
    expect(error).toBeInstanceOf(NotImplementedError);
    if (error instanceof NotImplementedError) {
      expect(error.specSection).toBe("§8.8.5");
      expect(error.message).toContain("editor");
    }
  });

  test("prompt `choicesFrom:` is accepted (no static choices required)", async () => {
    const yaml = `${baseHeader}prompts:
  - name: phpVersion
    type: select
    message: PHP version?
    choicesFrom:
      command: services:list
      args:
        - --type=php
      parse: lines
`;
    const exit = await runParse("test://choicesfrom-accept", yaml);
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    const prompt = exit.value.prompts?.[0];
    expect(prompt?.choicesFrom?.command).toBe("services:list");
    expect(prompt?.choicesFrom?.args).toEqual(["--type=php"]);
    expect(prompt?.choicesFrom?.parse).toBe("lines");
    expect(prompt?.choices).toBeUndefined();
  });

  test("select with neither `choices:` nor `choicesFrom:` is rejected", async () => {
    const yaml = `${baseHeader}prompts:
  - name: phpVersion
    type: select
    message: PHP version?
`;
    const exit = await runParse("test://choicesfrom-missing", yaml);
    const error = expectFailure(exit);
    expect(error).toBeInstanceOf(RecipeManifestValidationError);
    if (error instanceof RecipeManifestValidationError) {
      expect(error.issues.some((issue) => issue.includes("choicesFrom"))).toBe(true);
    }
  });

  test("top-level `deprecated:` is rejected with §18 remediation", async () => {
    const yaml = `${baseHeader}deprecated:
  since: 4.0.0
  note: replaced by node-postgres-v2
`;
    const exit = await runParse("test://beta-deprecated", yaml);
    const error = expectFailure(exit);
    expect(error).toBeInstanceOf(NotImplementedError);
    if (error instanceof NotImplementedError) {
      expect(error.specSection).toBe("§18");
      expect(error.message).toContain("deprecated");
    }
  });

  test("per-prompt `deprecated:` is rejected with §18 remediation", async () => {
    const yaml = `${baseHeader}prompts:
  - name: legacy
    type: text
    message: Legacy?
    deprecated:
      since: 4.0.0
      note: removed in 5.0
`;
    const exit = await runParse("test://beta-prompt-deprecated", yaml);
    const error = expectFailure(exit);
    expect(error).toBeInstanceOf(NotImplementedError);
    if (error instanceof NotImplementedError) {
      expect(error.specSection).toBe("§18");
      expect(error.message).toContain("legacy");
    }
  });

  for (const verb of ["script", "add", "create", "run", "x"]) {
    test(`postInit bun verb \`${verb}\` is rejected with §8.8.8 remediation`, async () => {
      const yaml = `${baseHeader}postInit:
  - type: bun
    verb: ${verb}
`;
      const exit = await runParse(`test://beta-bun-${verb}`, yaml);
      const error = expectFailure(exit);
      expect(error).toBeInstanceOf(NotImplementedError);
      if (error instanceof NotImplementedError) {
        expect(error.specSection).toBe("§8.8.8");
        expect(error.message).toContain(verb);
        expect(error.remediation).toContain("Beta");
      }
    });
  }
});

describe("RecipeManifestService.parse — validation/parse errors", () => {
  test("unknown top-level key is rejected by strict decode", async () => {
    const yaml = `id: unknown-key
title: Unknown key
description: An undocumented top-level key.
version: 0.0.1
mystery: yes
`;
    const exit = await runParse("test://unknown-key", yaml);
    const error = expectFailure(exit);
    expect(error).toBeInstanceOf(RecipeManifestValidationError);
  });

  test("missing required field reports a validation error with issue path", async () => {
    const yaml = `id: missing-title
description: missing title.
version: 0.0.1
`;
    const exit = await runParse("test://missing-title", yaml);
    const error = expectFailure(exit);
    expect(error).toBeInstanceOf(RecipeManifestValidationError);
    if (error instanceof RecipeManifestValidationError) {
      expect(error.issues.some((i) => i.includes("title"))).toBe(true);
    }
  });

  test("duplicate prompt names are rejected by semantic validation", async () => {
    const yaml = `id: dup-prompts
title: Dup
description: dup names
version: 0.0.1
prompts:
  - name: appName
    type: text
    message: Name?
  - name: appName
    type: text
    message: Name again?
`;
    const exit = await runParse("test://dup-prompts", yaml);
    const error = expectFailure(exit);
    expect(error).toBeInstanceOf(RecipeManifestValidationError);
    if (error instanceof RecipeManifestValidationError) {
      expect(error.issues.some((i) => i.includes("duplicate prompt name"))).toBe(true);
      expect(error.issues.some((i) => i.includes("appName"))).toBe(true);
    }
  });

  test("`select` prompt without `choices:` is rejected", async () => {
    const yaml = `id: missing-choices
title: Missing choices
description: select missing choices
version: 0.0.1
prompts:
  - name: framework
    type: select
    message: Framework?
`;
    const exit = await runParse("test://missing-choices", yaml);
    const error = expectFailure(exit);
    expect(error).toBeInstanceOf(RecipeManifestValidationError);
    if (error instanceof RecipeManifestValidationError) {
      expect(error.issues.some((i) => i.includes("framework") && i.includes("choices"))).toBe(true);
    }
  });

  test("`multiselect` prompt with empty `choices:` is rejected", async () => {
    const yaml = `id: empty-choices
title: Empty choices
description: multiselect with empty choices
version: 0.0.1
prompts:
  - name: features
    type: multiselect
    message: Features?
    choices: []
`;
    const exit = await runParse("test://empty-choices", yaml);
    const error = expectFailure(exit);
    expect(error).toBeInstanceOf(RecipeManifestValidationError);
    if (error instanceof RecipeManifestValidationError) {
      expect(error.issues.some((i) => i.includes("features") && i.includes("non-empty"))).toBe(true);
    }
  });

  test("reserved `__proto__` key in recipe.yml is rejected at parse time", async () => {
    const yaml = `id: proto-pollution
title: Proto
description: attempted prototype pollution
version: 0.0.1
__proto__:
  polluted: true
`;
    const exit = await runParse("test://proto", yaml);
    const error = expectFailure(exit);
    expect(error).toBeInstanceOf(RecipeManifestParseError);
    if (error instanceof RecipeManifestParseError) {
      expect(error.message).toContain("__proto__");
    }
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
  });

  test("malformed YAML raises a tagged parse error with line info", async () => {
    const yaml = `id: bad
title: Bad
description: bad
version: 0.0.1
files:
\tfoo: bar
`;
    const exit = await runParse("test://bad", yaml);
    const error = expectFailure(exit);
    expect(error).toBeInstanceOf(RecipeManifestParseError);
    if (error instanceof RecipeManifestParseError) {
      expect(error.source).toBe("test://bad");
      expect(error.line).toBeGreaterThan(0);
    }
  });
});

describe("RecipeManifestService.parse — bundled node-postgres recipe", () => {
  test("the built-in node-postgres recipe parses cleanly", async () => {
    const exit = await runParse(nodePostgresRecipeSource, nodePostgresRecipeYaml);
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    const manifest = exit.value;
    expect(manifest.id).toBe("node-postgres");
    expect(manifest.title).toBe("Node + Postgres");
    expect(manifest.files?.map((f) => f.dest)).toEqual([".lando.yml", "package.json", "server.js"]);
    expect(manifest.prompts?.[0]?.name).toBe("name");
    expect(manifest.postInit?.[0]?.type).toBe("message");
  });
});
