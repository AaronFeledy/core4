import { expect, test } from "bun:test";
import { createBufferedRendererIO } from "@lando/renderer/io";
import { Lando3LandofileDetected, LandofileDialectMixError } from "@lando/sdk/errors";
import { Effect, Layer } from "effect";
import { buildBugReport, renderPlainBugReport } from "../../src/cli/bug-report.ts";
import { runWithRendererHandling } from "../../src/cli/renderer-boundary.ts";

const failures = [
  new Lando3LandofileDetected({
    appRoot: "/app",
    sourceFile: "/app/.lando.yml",
    message: "Legacy canonical .lando.yml",
    remediation: "Run `lando4 app:config:translate --from lando3 --write`.",
  }),
  new LandofileDialectMixError({
    appRoot: "/app",
    canonicalFile: "/app/.lando.yml",
    conflictingLayer: "/app/.lando.local.yml",
    message: "Legacy layer .lando.local.yml",
    remediation: "Run `lando4 app:config:translate --from lando3 --file .lando.local.yml --write`.",
  }),
];

for (const error of failures) {
  test(`renders ${error._tag} with remediation and failure exit status`, async () => {
    // Given
    const io = createBufferedRendererIO();
    const codes: number[] = [];
    // When
    await runWithRendererHandling(Effect.fail(error), {
      runtime: Layer.empty,
      rendererMode: "plain",
      io,
      command: "app:config",
      setExitCode: (code) => codes.push(code),
      formatError: (failure) =>
        renderPlainBugReport(
          buildBugReport({
            error: failure,
            context: { commandId: "app:config", cacheRoot: "/cache" },
          }),
        ),
    });
    // Then
    expect(codes).toEqual([1]);
    expect(io.stderr()).toContain(error._tag);
    expect(io.stderr()).toContain(error.remediation);
  });

  test(`preserves ${error._tag} remediation in the machine envelope`, async () => {
    // Given
    const io = createBufferedRendererIO();
    const codes: number[] = [];
    // When
    await runWithRendererHandling(Effect.fail(error), {
      runtime: Layer.empty,
      rendererMode: "plain",
      resultFormat: "json",
      io,
      command: "app:config",
      setExitCode: (code) => codes.push(code),
      formatError: () => "unused",
    });
    // Then
    expect(codes).toEqual([1]);
    expect(JSON.parse(io.stdout())).toMatchObject({
      ok: false,
      error: { _tag: error._tag, remediation: error.remediation },
    });
  });
}
