import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit, Option } from "effect";

import { loadLandofileLayers } from "../src/service.ts";

const withApp = async <A>(files: Readonly<Record<string, string>>, run: (appRoot: string) => Promise<A>) => {
  const appRoot = await mkdtemp(join(tmpdir(), "lando-recipe-expression-"));
  try {
    for (const [name, content] of Object.entries(files)) await writeFile(join(appRoot, name), content);
    return await run(appRoot);
  } finally {
    await rm(appRoot, { recursive: true, force: true });
  }
};

const failureMessage = (exit: Exit.Exit<unknown, unknown>): string => {
  if (!Exit.isFailure(exit)) return "";
  const failure = Cause.failureOption(exit.cause);
  return Option.isSome(failure) ? String((failure.value as { message?: unknown }).message ?? "") : "";
};

const load = (appRoot: string) => loadLandofileLayers(appRoot, join(appRoot, ".lando.yml"));

const withEnv = async <A>(entries: Readonly<Record<string, string | undefined>>, run: () => Promise<A>) => {
  const previous = Object.fromEntries(Object.keys(entries).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(entries)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return await run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

const provenance = (options: string) =>
  [
    "recipe:",
    '  id: "lamp"',
    '  version: "0.1.0"',
    "  producer:",
    '    sourceKind: "bundled"',
    '    packageName: "@lando/recipe-lamp"',
    '    recipeId: "lamp"',
    '    manifestVersion: "0.1.0"',
    `    contentDigest: "sha256:${"0".repeat(64)}"`,
    "  options:",
    options,
  ].join("\n");

describe("recipe option expressions in a loaded Landofile", () => {
  test("materializes a whole recipe option reference from merged provenance", async () => {
    await withApp(
      {
        ".lando.yml": [
          "name: recipeapp",
          "runtime: 4",
          provenance(['    php: "8.3"', '    webroot: "/app"'].join("\n")),
          "services:",
          "  appserver:",
          '    type: "php:{{ recipe.php }}"',
          '    webroot: "{{ recipe.webroot }}"',
          "",
        ].join("\n"),
      },
      async (appRoot) => {
        // When
        const landofile = await Effect.runPromise(load(appRoot));

        // Then
        const services = landofile.services as Record<string, Record<string, unknown>>;
        expect(services.appserver?.type).toBe("php:8.3");
        expect(services.appserver?.webroot).toBe("/app");
      },
    );
  });

  test("reads options merged across layers rather than one file", async () => {
    await withApp(
      {
        ".lando.yml": [
          "name: recipeapp",
          "runtime: 4",
          provenance(['    php: "8.3"'].join("\n")),
          "services:",
          "  appserver:",
          '    type: "php:{{ recipe.php }}"',
          "",
        ].join("\n"),
        ".lando.local.yml": [provenance('    php: "8.4"'), ""].join("\n"),
      },
      async (appRoot) => {
        // When
        const landofile = await Effect.runPromise(load(appRoot));

        // Then
        const services = landofile.services as Record<string, Record<string, unknown>>;
        expect(services.appserver?.type).toBe("php:8.4");
      },
    );
  });

  test("leaves an app/proxy route hostname for the planner", async () => {
    await withApp(
      {
        ".lando.yml": [
          "name: recipeapp",
          "runtime: 4",
          provenance('    php: "8.3"'),
          "services:",
          "  appserver:",
          '    type: "php:{{ recipe.php }}"',
          "    routes:",
          '      - hostname: "{{ app.name }}.{{ proxy.defaultDomain }}"',
          "        scheme: both",
          "",
        ].join("\n"),
      },
      async (appRoot) => {
        // When
        const landofile = await Effect.runPromise(load(appRoot));

        // Then
        const services = landofile.services as Record<string, Record<string, unknown>>;
        const routes = services.appserver?.routes as ReadonlyArray<Record<string, unknown>>;
        expect(services.appserver?.type).toBe("php:8.3");
        expect(routes[0]?.hostname).toBe("{{ app.name }}.{{ proxy.defaultDomain }}");
      },
    );
  });

  test("fails closed when a referenced option is absent", async () => {
    await withApp(
      {
        ".lando.yml": [
          "name: recipeapp",
          "runtime: 4",
          provenance('    php: "8.3"'),
          "services:",
          "  appserver:",
          '    type: "php:{{ recipe.missing }}"',
          "",
        ].join("\n"),
      },
      async (appRoot) => {
        // When
        const exit = await Effect.runPromiseExit(load(appRoot));

        // Then
        expect(Exit.isFailure(exit)).toBe(true);
        expect(failureMessage(exit)).toContain("services.appserver.type");
        expect(failureMessage(exit)).toContain("recipe option the Landofile does not set");
      },
    );
  });

  test("fails closed when the Landofile records only a bare recipe id", async () => {
    await withApp(
      {
        ".lando.yml": [
          "name: recipeapp",
          "runtime: 4",
          "recipe: lamp",
          "services:",
          "  appserver:",
          '    type: "php:{{ recipe.php }}"',
          "",
        ].join("\n"),
      },
      async (appRoot) => {
        // When
        const exit = await Effect.runPromiseExit(load(appRoot));

        // Then
        expect(Exit.isFailure(exit)).toBe(true);
        expect(failureMessage(exit)).toContain("services.appserver.type");
        expect(failureMessage(exit)).toContain("records no recipe options");
      },
    );
  });

  test("does not rewrite expressions inside recipe provenance", async () => {
    await withEnv({ LANDO_SHOULD_STAY: "secret" }, async () => {
      await withApp(
        {
          ".lando.yml": [
            "name: recipeapp",
            "runtime: 4",
            provenance(['    php: "8.3"', '    note: "{{ env.LANDO_SHOULD_STAY }}"'].join("\n")),
            "services:",
            "  appserver:",
            '    type: "php:{{ recipe.php }}"',
            "",
          ].join("\n"),
        },
        async (appRoot) => {
          // When
          const landofile = await Effect.runPromise(load(appRoot));

          // Then
          const services = landofile.services as Record<string, Record<string, unknown>>;
          const recipe = landofile.recipe as { readonly options?: Record<string, unknown> };
          expect(services.appserver?.type).toBe("php:8.3");
          expect(recipe.options?.note).toBe("{{ env.LANDO_SHOULD_STAY }}");
        },
      );
    });
  });
});

describe("env expressions in a loaded Landofile", () => {
  test("resolves a helper call over the host environment", async () => {
    await withEnv({ LANDO_NODE_VERSION: "22" }, async () => {
      await withApp(
        {
          ".lando.yml": [
            "name: envapp",
            "runtime: 4",
            "services:",
            "  web:",
            "    image: \"node:{{ default(env.LANDO_NODE_VERSION, 'lts') }}\"",
            "",
          ].join("\n"),
        },
        async (appRoot) => {
          // When
          const landofile = await Effect.runPromise(load(appRoot));

          // Then
          const services = landofile.services as Record<string, Record<string, unknown>>;
          expect(services.web?.image).toBe("node:22");
        },
      );
    });
  });

  test("falls back to the declared default when the variable is unset", async () => {
    await withEnv({ LANDO_NODE_VERSION: undefined, NODE_ENV: undefined }, async () => {
      await withApp(
        {
          ".lando.yml": [
            "name: envapp",
            "runtime: 4",
            "services:",
            "  web:",
            "    image: \"node:{{ default(env.LANDO_NODE_VERSION, 'lts') }}\"",
            "    environment:",
            "      NODE_ENV: \"{{ default(env.NODE_ENV, 'development') }}\"",
            "",
          ].join("\n"),
        },
        async (appRoot) => {
          // When
          const landofile = await Effect.runPromise(load(appRoot));

          // Then
          const services = landofile.services as Record<string, Record<string, unknown>>;
          const environment = services.web?.environment as Record<string, unknown>;
          expect(services.web?.image).toBe("node:lts");
          expect(environment?.NODE_ENV).toBe("development");
        },
      );
    });
  });

  test("fails closed when a bare variable reference is unset", async () => {
    await withEnv({ LANDO_MISSING_FIXTURE: undefined }, async () => {
      await withApp(
        {
          ".lando.yml": [
            "name: envapp",
            "runtime: 4",
            "services:",
            "  web:",
            '    image: "node:{{ env.LANDO_MISSING_FIXTURE }}"',
            "",
          ].join("\n"),
        },
        async (appRoot) => {
          // When
          const exit = await Effect.runPromiseExit(load(appRoot));

          // Then
          expect(Exit.isFailure(exit)).toBe(true);
          expect(failureMessage(exit)).toContain("services.web.image");
        },
      );
    });
  });

  test("fails closed when a pure helper exceeds the load-time budget", async () => {
    await withApp(
      {
        ".lando.yml": [
          "name: envapp",
          "runtime: 4",
          "services:",
          "  web:",
          '    image: "{{ range(0, 50000) }}"',
          "",
        ].join("\n"),
      },
      async (appRoot) => {
        // When
        const exit = await Effect.runPromiseExit(load(appRoot));

        // Then
        expect(Exit.isFailure(exit)).toBe(true);
        expect(failureMessage(exit)).toContain("services.web.image");
        expect(failureMessage(exit)).toContain("load-time expression budget");
      },
    );
  });
});

describe("mixed recipe and env expressions in one Landofile", () => {
  test("resolves both scopes and leaves planner-owned sites alone", async () => {
    await withEnv({ LANDO_NODE_VERSION: "20" }, async () => {
      await withApp(
        {
          ".lando.yml": [
            "name: recipeapp",
            "runtime: 4",
            provenance(['    node: "22"', '    framework: "express"'].join("\n")),
            "services:",
            "  web:",
            "    image: \"node:{{ default(env.LANDO_NODE_VERSION, 'lts') }}\"",
            "    environment:",
            '      API_FRAMEWORK: "{{ recipe.framework }}"',
            "    routes:",
            '      - hostname: "{{ app.name }}.{{ proxy.defaultDomain }}"',
            "        scheme: both",
            "",
          ].join("\n"),
        },
        async (appRoot) => {
          // When
          const landofile = await Effect.runPromise(load(appRoot));

          // Then
          const services = landofile.services as Record<string, Record<string, unknown>>;
          const environment = services.web?.environment as Record<string, unknown>;
          const routes = services.web?.routes as ReadonlyArray<Record<string, unknown>>;
          expect(services.web?.image).toBe("node:20");
          expect(environment?.API_FRAMEWORK).toBe("express");
          expect(routes[0]?.hostname).toBe("{{ app.name }}.{{ proxy.defaultDomain }}");
        },
      );
    });
  });

  test("leaves a site that mixes a resolvable scope with a planner scope untouched", async () => {
    await withEnv({ LANDO_SUFFIX: "edge" }, async () => {
      await withApp(
        {
          ".lando.yml": [
            "name: recipeapp",
            "runtime: 4",
            provenance('    php: "8.3"'),
            "services:",
            "  appserver:",
            '    type: "php:{{ recipe.php }}"',
            "    routes:",
            "      - hostname: \"{{ app.name }}-{{ default(env.LANDO_SUFFIX, 'main') }}.{{ proxy.defaultDomain }}\"",
            "        scheme: both",
            "",
          ].join("\n"),
        },
        async (appRoot) => {
          // When
          const landofile = await Effect.runPromise(load(appRoot));

          // Then
          const services = landofile.services as Record<string, Record<string, unknown>>;
          const routes = services.appserver?.routes as ReadonlyArray<Record<string, unknown>>;
          expect(services.appserver?.type).toBe("php:8.3");
          expect(routes[0]?.hostname).toBe(
            "{{ app.name }}-{{ default(env.LANDO_SUFFIX, 'main') }}.{{ proxy.defaultDomain }}",
          );
        },
      );
    });
  });
});

describe("shell parameter text alongside deferred-scope expressions", () => {
  const shellCommand = (major: string): string =>
    [
      "set -eu",
      "app_root=$(printenv LANDO_APP_ROOT 2>/dev/null || echo /app)",
      'printf "%s\\n" "$$" > "$app_root/pid"',
      `composer create-project 'drupal/recommended-project:^${major}' "$app_root"`,
      'echo "$1" "$2"',
    ].join("\n");

  const withTooling = (cmd: string, options: string) =>
    [
      "name: recipeapp",
      "runtime: 4",
      provenance(options),
      "services:",
      "  appserver:",
      '    type: "php:8.3"',
      "tooling:",
      "  scaffold:",
      "    service: appserver",
      `    cmd: ${JSON.stringify(cmd)}`,
      "",
    ].join("\n");

  test("resolves a recipe option inside a shell command and preserves every shell parameter", async () => {
    await withApp(
      { ".lando.yml": withTooling(shellCommand("{{ recipe.drupal }}"), '    drupal: "11"') },
      async (appRoot) => {
        // When
        const landofile = await Effect.runPromise(load(appRoot));

        // Then
        const tooling = landofile.tooling as Record<string, Record<string, unknown>>;
        expect(tooling.scaffold?.cmd).toBe(shellCommand("11"));
      },
    );
  });

  test("resolves recipe and env expressions in one shell command", async () => {
    await withEnv({ LANDO_SCAFFOLD_FLAVOR: "slim" }, async () => {
      const cmd = [
        'app_root="$PWD"',
        "install '{{ recipe.package }}' --flavor={{ default(env.LANDO_SCAFFOLD_FLAVOR, 'full') }}",
        'echo "$app_root"',
      ].join("\n");
      await withApp({ ".lando.yml": withTooling(cmd, '    package: "drupal/core"') }, async (appRoot) => {
        // When
        const landofile = await Effect.runPromise(load(appRoot));

        // Then
        const tooling = landofile.tooling as Record<string, Record<string, unknown>>;
        expect(tooling.scaffold?.cmd).toBe(
          ['app_root="$PWD"', "install 'drupal/core' --flavor=slim", 'echo "$app_root"'].join("\n"),
        );
      });
    });
  });

  test("fails closed when a shell command references an option the Landofile does not set", async () => {
    await withApp(
      { ".lando.yml": withTooling(shellCommand("{{ recipe.missing }}"), '    drupal: "11"') },
      async (appRoot) => {
        // When
        const exit = await Effect.runPromiseExit(load(appRoot));

        // Then
        expect(Exit.isFailure(exit)).toBe(true);
        expect(failureMessage(exit)).toContain("tooling.scaffold.cmd");
        expect(failureMessage(exit)).toContain("recipe option the Landofile does not set");
      },
    );
  });

  test("leaves a shell command that also reads a planner-owned scope untouched", async () => {
    const cmd = ['curl "https://{{ app.name }}.{{ proxy.defaultDomain }}"', 'echo "$app_root"'].join("\n");
    await withApp({ ".lando.yml": withTooling(cmd, '    drupal: "11"') }, async (appRoot) => {
      // When
      const landofile = await Effect.runPromise(load(appRoot));

      // Then
      const tooling = landofile.tooling as Record<string, Record<string, unknown>>;
      expect(tooling.scaffold?.cmd).toBe(cmd);
    });
  });

  test("still rejects a shell command that reaches the host through a helper", async () => {
    const cmd = ['echo "$app_root"', "run {{ which('git') }}"].join("\n");
    await withApp({ ".lando.yml": withTooling(cmd, '    drupal: "11"') }, async (appRoot) => {
      // When
      const exit = await Effect.runPromiseExit(load(appRoot));

      // Then
      expect(Exit.isFailure(exit)).toBe(true);
      expect(failureMessage(exit)).toContain("Template expressions");
    });
  });

  test("still rejects a shell command that reads a scope the loader does not own", async () => {
    const cmd = ['echo "$app_root"', "run {{ nope.value }}"].join("\n");
    await withApp({ ".lando.yml": withTooling(cmd, '    drupal: "11"') }, async (appRoot) => {
      // When
      const exit = await Effect.runPromiseExit(load(appRoot));

      // Then
      expect(Exit.isFailure(exit)).toBe(true);
      expect(failureMessage(exit)).toContain("Template expressions");
    });
  });

  test("leaves a shell command that carries no expression byte-identical", async () => {
    const cmd = "echo $HOME and $$ and $(date)";
    await withApp({ ".lando.yml": withTooling(cmd, '    drupal: "11"') }, async (appRoot) => {
      // When
      const landofile = await Effect.runPromise(load(appRoot));

      // Then
      const tooling = landofile.tooling as Record<string, Record<string, unknown>>;
      expect(tooling.scaffold?.cmd).toBe(cmd);
    });
  });
});

describe("braced shell forms stay unsupported on the load path", () => {
  const landofile = (value: string, extra: ReadonlyArray<string> = []) =>
    [
      "name: recipeapp",
      "runtime: 4",
      provenance('    php: "8.3"'),
      "services:",
      "  appserver:",
      `    type: ${JSON.stringify(value)}`,
      ...extra,
      "",
    ].join("\n");

  test("rejects a parameter reference beside a resolvable expression", async () => {
    await withApp({ ".lando.yml": landofile("php:{{ recipe.php }}-${LANDO_FLAVOR}") }, async (appRoot) => {
      // When
      const exit = await Effect.runPromiseExit(load(appRoot));

      // Then
      expect(Exit.isFailure(exit)).toBe(true);
      expect(failureMessage(exit)).toContain("Configuration expressions");
    });
  });

  test("rejects a parameter reference on a file whose raw scan is skipped", async () => {
    // Given a `load(` occurrence anywhere in the file skips the raw pre-parse scan.
    await withApp(
      {
        ".lando.yml": landofile("php:{{ recipe.php }}-${LANDO_FLAVOR}", [
          "    environment:",
          "      CA: \"{{ load('./ca.pem') }}\"",
        ]),
        "ca.pem": "pem",
      },
      async (appRoot) => {
        // When
        const exit = await Effect.runPromiseExit(load(appRoot));

        // Then
        expect(Exit.isFailure(exit)).toBe(true);
        expect(failureMessage(exit)).toContain("not supported");
      },
    );
  });

  test("rejects a secret reference beside a resolvable expression", async () => {
    await withApp({ ".lando.yml": landofile("php:{{ recipe.php }}-${secret:token}") }, async (appRoot) => {
      // When
      const exit = await Effect.runPromiseExit(load(appRoot));

      // Then
      expect(Exit.isFailure(exit)).toBe(true);
      expect(failureMessage(exit)).toContain("Configuration expressions");
    });
  });

  test("resolves a recipe option beside an escaped $${ form on a file whose raw scan is skipped", async () => {
    // Given a `load(` occurrence anywhere in the file skips the raw pre-parse scan.
    await withApp(
      {
        ".lando.yml": landofile("php:{{ recipe.php }}-$${FLAVOR}", [
          "    environment:",
          "      CA: \"{{ load('./ca.pem') }}\"",
        ]),
        "ca.pem": "pem",
      },
      async (appRoot) => {
        // When
        const landofile = await Effect.runPromise(load(appRoot));

        // Then
        const services = landofile.services as Record<string, Record<string, unknown>>;
        expect(services.appserver?.type).toBe("php:8.3-${FLAVOR}");
      },
    );
  });
});
