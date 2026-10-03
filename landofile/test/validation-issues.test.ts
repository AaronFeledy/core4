import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit, Option } from "effect";

import { LandofileValidationError } from "@lando/sdk/errors";
import { formatValidationIssuePath } from "@lando/sdk/schema";

import { loadLandofileFile } from "../src/service.ts";

describe("Landofile validation issues", () => {
  test("reports three independent problems with paths and an image suggestion", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "lando-validation-issues-"));
    const file = join(appRoot, ".lando.yml");
    try {
      await writeFile(
        file,
        [
          "name: config-lint-invalid",
          "services:",
          "  web:",
          "    type: compose",
          "    imgae: nginx:1.27-alpine",
          '    home: "nope"',
          "    ports:",
          "      - target: 99999",
          "        protocol: tcp",
          "",
        ].join("\n"),
      );
      const exit = await Effect.runPromiseExit(loadLandofileFile(file));
      expect(Exit.isFailure(exit)).toBe(true);
      if (!Exit.isFailure(exit)) return;
      const failure = Cause.findErrorOption(exit.cause);
      expect(Option.isSome(failure)).toBe(true);
      if (!Option.isSome(failure) || !(failure.value instanceof LandofileValidationError)) {
        throw new Error("expected LandofileValidationError");
      }
      const paths = failure.value.issues.map((issue) => formatValidationIssuePath(issue.path));
      expect(paths).toContain("services.web.imgae");
      expect(paths).toContain("services.web.home");
      expect(paths).toContain("services.web.ports[0].target");
      expect(failure.value.issues.find((issue) => issue.path.at(-1) === "imgae")?.suggestion).toBe(
        'Did you mean "image"?',
      );
    } finally {
      await rm(appRoot, { recursive: true, force: true });
    }
  });
});
