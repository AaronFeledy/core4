import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Cause, Effect, Exit } from "effect";

import {
  LandofileParseError,
  LandofileSandboxError,
  LandofileTimeoutError,
  LandofileValidationError,
  NotImplementedError,
} from "@lando/core/errors";
import { ServiceName, defineLandofile } from "@lando/core/schema";
import { LandofileService } from "@lando/core/services";

import { LandofileServiceLive } from "../../src/landofile/service.ts";
import { TS_TIMEOUT_ENV } from "../../src/landofile/ts-loader.ts";

const withTempCwd = async <T>(run: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await mkdtemp(join(tmpdir(), "lando-landofile-ts-"));
  const previousCwd = process.cwd();
  try {
    return await run(dir);
  } finally {
    process.chdir(previousCwd);
    await rm(dir, { recursive: true, force: true });
  }
};

const withEnv = async <T>(
  vars: Readonly<Record<string, string | undefined>>,
  run: () => Promise<T>,
): Promise<T> => {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) previous[key] = process.env[key];
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

const discover = () =>
  Effect.runPromise(
    Effect.flatMap(LandofileService, (service) => service.discover).pipe(
      Effect.provide(LandofileServiceLive),
    ),
  );

const discoverExit = () =>
  Effect.runPromiseExit(
    Effect.flatMap(LandofileService, (service) => service.discover).pipe(
      Effect.provide(LandofileServiceLive),
    ),
  );

const failureFromExit = <A, E>(exit: Exit.Exit<A, E>): E | undefined => {
  if (!Exit.isFailure(exit)) return undefined;
  const failure = Cause.failureOption(exit.cause);
  return failure._tag === "Some" ? failure.value : undefined;
};

describe("LandofileServiceLive — TS form value export", () => {
  test("loads a `.lando.ts` value-form export and matches an equivalent YAML Landofile", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(
        join(dir, ".lando.ts"),
        [
          "export default {",
          '  name: "myapp",',
          "  services: {",
          '    web: { image: "node:lts", environment: { NODE_ENV: "development" } },',
          '    db: { image: "postgres:16", environment: { POSTGRES_PASSWORD: "lando" } },',
          "  },",
          "};",
          "",
        ].join("\n"),
      );
      process.chdir(dir);

      const landofile = await discover();
      expect(landofile.name).toBe("myapp");
      const web = landofile.services?.[ServiceName.make("web")];
      const db = landofile.services?.[ServiceName.make("db")];
      expect(web?.image).toBe("node:lts");
      expect(web?.environment).toEqual({ NODE_ENV: "development" });
      expect(db?.image).toBe("postgres:16");
      expect(db?.environment).toEqual({ POSTGRES_PASSWORD: "lando" });
    });
  });

  test("YAML and TS forms produce structurally identical Landofile values", async () => {
    const tsLandofile = await withTempCwd(async (dir) => {
      await writeFile(
        join(dir, ".lando.ts"),
        [
          "export default {",
          '  name: "myapp",',
          '  services: { web: { image: "node:lts" } },',
          "};",
          "",
        ].join("\n"),
      );
      process.chdir(dir);
      return await discover();
    });

    const yamlLandofile = await withTempCwd(async (dir) => {
      await writeFile(
        join(dir, ".lando.yml"),
        ["name: myapp", "services:", "  web:", "    image: node:lts", ""].join("\n"),
      );
      process.chdir(dir);
      return await discover();
    });

    expect(tsLandofile.name).toBe(yamlLandofile.name);
    expect(tsLandofile.services?.[ServiceName.make("web")]?.image).toBe(
      yamlLandofile.services?.[ServiceName.make("web")]?.image,
    );
  });

  test("supports function-form default export that returns a Landofile value", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(
        join(dir, ".lando.ts"),
        [
          "export default () => ({",
          '  name: "fn-form-app",',
          '  services: { web: { image: "node:lts" } },',
          "});",
          "",
        ].join("\n"),
      );
      process.chdir(dir);
      const landofile = await discover();
      expect(landofile.name).toBe("fn-form-app");
      expect(landofile.services?.[ServiceName.make("web")]?.image).toBe("node:lts");
    });
  });

  test("supports function-form default export that returns a Promise<Landofile>", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(
        join(dir, ".lando.ts"),
        [
          "export default async () => ({",
          '  name: "async-fn-app",',
          '  services: { web: { image: "node:lts" } },',
          "});",
          "",
        ].join("\n"),
      );
      process.chdir(dir);
      const landofile = await discover();
      expect(landofile.name).toBe("async-fn-app");
    });
  });

  test("function form receives a context with cwd and env access", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(
        join(dir, ".lando.ts"),
        [
          "export default (ctx: { env: Record<string, string | undefined> }) => ({",
          '  name: ctx.env.MY_TEST_APP_NAME ?? "fallback",',
          '  services: { web: { image: "node:lts" } },',
          "});",
          "",
        ].join("\n"),
      );
      process.chdir(dir);
      await withEnv({ MY_TEST_APP_NAME: "ctx-derived-name" }, async () => {
        const landofile = await discover();
        expect(landofile.name).toBe("ctx-derived-name");
      });
    });
  });
});

describe("LandofileServiceLive — TS form sandbox violations", () => {
  const assertSandboxRejection = (error: unknown, violationFragment: string): void => {
    expect(error).toBeInstanceOf(LandofileSandboxError);
    if (!(error instanceof LandofileSandboxError)) return;
    expect(error._tag).toBe("LandofileSandboxError");
    expect(error.remediation).toContain("§7.1.1");
    expect(error.violation).toContain(violationFragment);
  };

  test("rejects import of node:fs with LandofileSandboxError", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(
        join(dir, ".lando.ts"),
        [
          'import fs from "node:fs";',
          'export default { name: "x", services: { web: { image: "node:lts" } } };',
          "",
        ].join("\n"),
      );
      process.chdir(dir);
      const exit = await discoverExit();
      assertSandboxRejection(failureFromExit(exit), "node:fs");
    });
  });

  test("rejects import of node:child_process with LandofileSandboxError", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(
        join(dir, ".lando.ts"),
        [
          'import { spawn } from "node:child_process";',
          'export default { name: "x", services: { web: { image: "node:lts" } } };',
          "",
        ].join("\n"),
      );
      process.chdir(dir);
      const exit = await discoverExit();
      assertSandboxRejection(failureFromExit(exit), "child_process");
    });
  });

  test("rejects import of unprefixed `fs` builtin with LandofileSandboxError", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(
        join(dir, ".lando.ts"),
        [
          'import fs from "fs";',
          'export default { name: "x", services: { web: { image: "node:lts" } } };',
          "",
        ].join("\n"),
      );
      process.chdir(dir);
      const exit = await discoverExit();
      assertSandboxRejection(failureFromExit(exit), "fs");
    });
  });

  test("rejects remote https import with LandofileSandboxError", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(
        join(dir, ".lando.ts"),
        [
          'import x from "https://example.com/mod.ts";',
          'export default { name: "x", services: { web: { image: "node:lts" } } };',
          "",
        ].join("\n"),
      );
      process.chdir(dir);
      const exit = await discoverExit();
      assertSandboxRejection(failureFromExit(exit), "https://");
    });
  });

  test("rejects relative import that resolves outside the app root", async () => {
    await withTempCwd(async (dir) => {
      const appDir = join(dir, "app");
      await mkdir(appDir, { recursive: true });
      await writeFile(join(dir, "outside.ts"), "export const x = 1;\n");
      await writeFile(
        join(appDir, ".lando.ts"),
        [
          'import { x } from "../outside.ts";',
          'export default { name: `app-${x}`, services: { web: { image: "node:lts" } } };',
          "",
        ].join("\n"),
      );
      process.chdir(appDir);
      const exit = await discoverExit();
      assertSandboxRejection(failureFromExit(exit), "../outside.ts");
    });
  });

  test("rejects dynamic import() of a forbidden module", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(
        join(dir, ".lando.ts"),
        [
          'const _fs = import("node:fs");',
          'export default { name: "x", services: { web: { image: "node:lts" } } };',
          "",
        ].join("\n"),
      );
      process.chdir(dir);
      const exit = await discoverExit();
      assertSandboxRejection(failureFromExit(exit), "node:fs");
    });
  });

  test("rejects require() usage with LandofileSandboxError", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(
        join(dir, ".lando.ts"),
        [
          'const fs = require("node:fs");',
          'export default { name: "x", services: { web: { image: "node:lts" } } };',
          "",
        ].join("\n"),
      );
      process.chdir(dir);
      const exit = await discoverExit();
      const failure = failureFromExit(exit);
      expect(failure).toBeInstanceOf(LandofileSandboxError);
      if (failure instanceof LandofileSandboxError) {
        expect(failure.violation).toContain("node:fs");
      }
    });
  });
});

describe("LandofileServiceLive — TS form schema validation", () => {
  test("returned value with wrong-typed field surfaces LandofileValidationError", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(
        join(dir, ".lando.ts"),
        ["export default {", "  name: 123,", '  services: { web: { image: "node:lts" } },', "};", ""].join(
          "\n",
        ),
      );
      process.chdir(dir);
      const exit = await discoverExit();
      const failure = failureFromExit(exit);
      expect(failure).toBeInstanceOf(LandofileValidationError);
      if (failure instanceof LandofileValidationError) {
        expect(failure.issues.length).toBeGreaterThan(0);
      }
    });
  });

  test("returned value with unsupported MVP keys surfaces LandofileValidationError", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(
        join(dir, ".lando.ts"),
        [
          "export default {",
          '  name: "myapp",',
          '  services: { web: { image: "node:lts", deploy: { replicas: 3 } } },',
          "};",
          "",
        ].join("\n"),
      );
      process.chdir(dir);
      const exit = await discoverExit();
      const failure = failureFromExit(exit);
      expect(failure).toBeInstanceOf(LandofileValidationError);
      if (failure instanceof LandofileValidationError) {
        expect(failure.issues.some((issue) => issue.includes("services.web.deploy"))).toBe(true);
      }
    });
  });
});

describe("LandofileServiceLive — TS form timeout", () => {
  test("function form that never resolves fails with LandofileTimeoutError", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(
        join(dir, ".lando.ts"),
        ["export default () => new Promise<{ name: string }>(() => {});", ""].join("\n"),
      );
      process.chdir(dir);
      await withEnv({ [TS_TIMEOUT_ENV]: "120" }, async () => {
        const exit = await discoverExit();
        const failure = failureFromExit(exit);
        expect(failure).toBeInstanceOf(LandofileTimeoutError);
        if (failure instanceof LandofileTimeoutError) {
          expect(failure.timeoutMs).toBe(120);
          expect(failure.remediation).toContain(TS_TIMEOUT_ENV);
        }
      });
    });
  });
});

describe("LandofileServiceLive — TS form discovery edge cases", () => {
  test("having both `.lando.yml` and `.lando.ts` in the same directory fails with LandofileParseError", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(
        join(dir, ".lando.yml"),
        ["name: from-yaml", "services:", "  web:", "    image: node:lts", ""].join("\n"),
      );
      await writeFile(
        join(dir, ".lando.ts"),
        ['export default { name: "from-ts", services: { web: { image: "node:lts" } } };', ""].join("\n"),
      );
      process.chdir(dir);
      const exit = await discoverExit();
      const failure = failureFromExit(exit);
      expect(failure).toBeInstanceOf(LandofileParseError);
      if (failure instanceof LandofileParseError) {
        expect(failure.message).toContain(".lando.yml");
        expect(failure.message).toContain(".lando.ts");
      }
    });
  });

  test("discovers `.lando.ts` from a nested subdirectory when no YAML exists", async () => {
    await withTempCwd(async (dir) => {
      const appDir = join(dir, "apps", "myapp");
      await mkdir(join(appDir, "src"), { recursive: true });
      await writeFile(
        join(appDir, ".lando.ts"),
        ['export default { name: "nested-ts", services: { web: { image: "node:lts" } } };', ""].join("\n"),
      );
      process.chdir(join(appDir, "src"));
      const landofile = await discover();
      expect(landofile.name).toBe("nested-ts");
    });
  });
});

describe("defineLandofile identity helper", () => {
  test("returns the value unchanged so it can be used as a typing convenience", () => {
    const input = { name: "x", services: { web: { image: "node:lts" } } } as const;
    const result = defineLandofile(input);
    expect(result).toBe(input);
  });
});

describe("LandofileServiceLive — TS form Beta-rejection parity", () => {
  test("TS export with top-level `includes:` surfaces NotImplementedError matching the YAML path", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(
        join(dir, ".lando.ts"),
        [
          "export default {",
          '  name: "x",',
          '  services: { web: { image: "node:lts" } },',
          '  includes: ["foo"],',
          "};",
          "",
        ].join("\n"),
      );
      process.chdir(dir);
      const exit = await discoverExit();
      const failure = failureFromExit(exit);
      expect(failure).toBeInstanceOf(NotImplementedError);
      if (failure instanceof NotImplementedError) {
        expect(failure.specSection).toBe("§7.7");
        expect(failure.commandId).toBe("landofile.parse");
        expect(failure.remediation).toContain("Beta");
      }
    });
  });

  test("TS export with Beta tooling field surfaces NotImplementedError matching the YAML path", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(
        join(dir, ".lando.ts"),
        [
          "export default {",
          '  name: "x",',
          '  services: { web: { image: "node:lts" } },',
          '  tooling: { test: { deps: ["foo"] } },',
          "};",
          "",
        ].join("\n"),
      );
      process.chdir(dir);
      const exit = await discoverExit();
      const failure = failureFromExit(exit);
      expect(failure).toBeInstanceOf(NotImplementedError);
      if (failure instanceof NotImplementedError) {
        expect(failure.commandId).toBe("landofile.parse");
        expect(failure.message).toContain('"deps"');
      }
    });
  });
});

describe("LandofileServiceLive — TS form sandbox tightening for require() variants", () => {
  test("rejects template-literal `require(`node:fs`)` with LandofileSandboxError", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(
        join(dir, ".lando.ts"),
        [
          "const fs = require(`node:fs`);",
          'export default { name: "x", services: { web: { image: "node:lts" } } };',
          "",
        ].join("\n"),
      );
      process.chdir(dir);
      const exit = await discoverExit();
      const failure = failureFromExit(exit);
      expect(failure).toBeInstanceOf(LandofileSandboxError);
      if (failure instanceof LandofileSandboxError) {
        expect(failure.violation).toContain("node:fs");
      }
    });
  });

  test('rejects parenthesized `(require)("node:fs")` with LandofileSandboxError', async () => {
    await withTempCwd(async (dir) => {
      await writeFile(
        join(dir, ".lando.ts"),
        [
          'const fs = (require)("node:fs");',
          'export default { name: "x", services: { web: { image: "node:lts" } } };',
          "",
        ].join("\n"),
      );
      process.chdir(dir);
      const exit = await discoverExit();
      const failure = failureFromExit(exit);
      expect(failure).toBeInstanceOf(LandofileSandboxError);
      if (failure instanceof LandofileSandboxError) {
        expect(failure.violation).toContain("node:fs");
      }
    });
  });
});

describe("LandofileServiceLive — TS form Effect-return support", () => {
  test("function form returning an Effect.succeed value resolves to a parsed Landofile", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(
        join(dir, ".lando.ts"),
        [
          'import { Effect } from "effect";',
          "export default () =>",
          "  Effect.succeed({",
          '    name: "effect-form-app",',
          '    services: { web: { image: "node:lts" } },',
          "  });",
          "",
        ].join("\n"),
      );
      process.chdir(dir);
      const landofile = await discover();
      expect(landofile.name).toBe("effect-form-app");
      expect(landofile.services?.[ServiceName.make("web")]?.image).toBe("node:lts");
    });
  });
});
