import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AppPlanner,
  ConfigService,
  LandofileService,
  RuntimeProviderRegistry,
  ToolingEngine,
} from "@lando/sdk/services";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { Effect, Layer } from "effect";
import { runBunShellTooling } from "../../src/operations/tooling-bun-script.ts";
import { runTooling } from "../../src/operations/tooling.ts";

test.each(["direct", "fallback"] as const)(
  "forwards positional args through the %s script path",
  async (path) => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "lando-script-args-"));
    try {
      await mkdir(join(root, ".lando/scripts"), { recursive: true });
      await writeFile(join(root, ".lando.yml"), "name: script-args\n");
      await writeFile(
        join(root, ".lando/scripts/probe.bun.sh"),
        '# ---\n# desc: Args probe\n# ---\necho "<$1>"; echo "<$2>"; echo "<$3>"; echo "<$4>"\n',
      );
      const options = { name: "probe", args: ["a", "b c", "$(echo injected)", "*.ts"], cwd: root };
      const fallbackLayer = Layer.mergeAll(
        PrivateFileAccessService.layer,
        Layer.succeed(
          LandofileService,
          LandofileService.of({ discover: Effect.succeed({ name: "script-args" }) }),
        ),
        Layer.succeed(AppPlanner, AppPlanner.of({ plan: () => Effect.die("script must skip planning") })),
        Layer.succeed(
          ConfigService,
          ConfigService.of({ load: Effect.die("unused"), get: () => Effect.die("unused") }),
        ),
        Layer.succeed(
          RuntimeProviderRegistry,
          RuntimeProviderRegistry.of({
            list: Effect.die("unused"),
            capabilities: Effect.die("unused"),
            select: () => Effect.die("unused"),
          }),
        ),
        Layer.succeed(ToolingEngine, ToolingEngine.of({ id: "unused", run: () => Effect.die("unused") })),
      );
      // When
      const result = await Effect.runPromise(
        path === "direct"
          ? runBunShellTooling(options, root).pipe(Effect.provide(PrivateFileAccessService.layer))
          : runTooling(options).pipe(Effect.provide(fallbackLayer)),
      );
      // Then
      expect(result).toMatchObject({ exitCode: 0, stdout: "<a>\n<b c>\n<$(echo injected)>\n<*.ts>\n" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
