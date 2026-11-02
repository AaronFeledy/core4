import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { lastEnvelope, makeFixture, runSource } from "./subprocess-support.ts";

test.each(["app:config:lint", "start", "app:includes:update", "app:includes:verify"])(
  "%s retains both layer failures through source dispatch (#1646)",
  async (command) => {
    const fixture = await makeFixture("load-aggregate");
    try {
      await writeFile(join(fixture.root, ".lando.yml"), "name: aggregate\nincludes: [./missing-a.yml]\n");
      await writeFile(join(fixture.root, ".lando.local.yml"), "includes: [./missing-b.yml]\n");
      const result = await runSource(fixture, [command, "--format=json"]);
      const envelope = lastEnvelope(result.stdout);
      expect(result.exitCode, result.stderr).toBe(1);
      if (command === "app:config:lint") {
        expect(envelope).toMatchObject({
          ok: true,
          result: {
            valid: false,
            violations: [
              { rule: "landofile.load", source: { file: join(fixture.root, ".lando.yml") } },
              { rule: "landofile.load", source: { file: join(fixture.root, ".lando.local.yml") } },
            ],
          },
        });
      } else if (command === "app:includes:verify") {
        expect(envelope).toMatchObject({
          ok: true,
          result: {
            ok: false,
            failures: [
              { _tag: "LandofileIncludeError", file: join(fixture.root, ".lando.yml") },
              { _tag: "LandofileIncludeError", file: join(fixture.root, ".lando.local.yml") },
            ],
          },
        });
      } else {
        expect(envelope).toMatchObject({
          ok: false,
          error: {
            _tag: "LandofileLoadError",
            failures: [
              {
                _tag: "LandofileIncludeError",
                file: join(fixture.root, ".lando.yml"),
                path: ["includes", 0],
              },
              {
                _tag: "LandofileIncludeError",
                file: join(fixture.root, ".lando.local.yml"),
                path: ["includes", 0],
              },
            ],
          },
        });
      }
    } finally {
      await fixture.cleanup();
    }
  },
  30_000,
);

test.each(["app:includes:update", "app:includes:verify"])(
  "%s also records root env materialization and lando failures",
  async (command) => {
    const fixture = await makeFixture("include-load-stages");
    const isolated = {
      ...fixture,
      env: Object.fromEntries(
        Object.entries(fixture.env).filter(
          ([key]) => key !== "LANDO_TEST_LOAD_UNSET_A" && key !== "LANDO_TEST_LOAD_UNSET_B",
        ),
      ),
    };
    try {
      await writeFile(
        join(fixture.root, ".lando.yml"),
        'name: aggregate\nincludes: [./missing.yml]\nx-value: "{{ env.LANDO_TEST_LOAD_UNSET_A }}"\nlando: "{{ env.LANDO_TEST_LOAD_UNSET_B }}"\n',
      );
      const result = await runSource(isolated, [command, "--format=json"]);
      const envelope = lastEnvelope(result.stdout);
      expect(result.exitCode, result.stderr).toBe(1);
      expect(envelope).toMatchObject(
        command === "app:includes:update"
          ? {
              ok: false,
              error: {
                _tag: "LandofileLoadError",
                failures: [
                  { _tag: "LandofileIncludeError" },
                  { _tag: "ConfigExpressionError", path: ["x-value"] },
                  { _tag: "ConfigExpressionError", path: ["lando"] },
                ],
              },
            }
          : {
              ok: true,
              result: {
                ok: false,
                failures: [
                  { _tag: "LandofileIncludeError" },
                  { _tag: "ConfigExpressionError", path: ["x-value"] },
                  { _tag: "ConfigExpressionError", path: ["lando"] },
                ],
              },
            },
      );
    } finally {
      await fixture.cleanup();
    }
  },
  30_000,
);
