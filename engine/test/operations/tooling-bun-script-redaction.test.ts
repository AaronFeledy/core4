import { expect, test } from "bun:test";
import { join } from "node:path";
import { parseScriptFile } from "@lando/landofile/bun-sh-discovery";
import { RedactionService, makeRedactionService } from "@lando/redaction/service";
import { createPayloadRedactor } from "@lando/sdk/secrets";
import { EventService, type LandoEvent } from "@lando/sdk/services";
import { Effect, Layer } from "effect";
import { StreamFrameSink, type StreamFrameSinkFrame } from "../../src/operations/stream-frame-sink.ts";
import { runBunShellScript, runBunShellTooling } from "../../src/operations/tooling-bun-script.ts";
import { testEnvironmentResolverLayerFor } from "../environment-values.ts";
import { recordingScriptEvents, scriptHostLayer, withBunScript } from "./tooling-bun-script-support.ts";

for (const entry of ["direct", "discovery"] as const) {
  test.each(
    ["live", "collected"].flatMap((mode) =>
      ["heuristic", "explicit"].flatMap((sensitivity) =>
        ["RawArgv", "NamedMaps"].map((inputMode) => ({ mode, sensitivity, inputMode })),
      ),
    ),
  )(
    `${entry} redacts $sensitivity $inputMode and JSON escaped inputs in $mode output and shell events`,
    async ({ mode, sensitivity, inputMode }) => {
      // Given
      const token = 'script-canary-token-"quoted"\\backslash\nnext-line';
      const password = 'script-canary-password-\\value"\nlast-line';
      const flagName = sensitivity === "explicit" ? "mode" : "apiToken";
      const argName = sensitivity === "explicit" ? "target" : "dbPassword";
      const events: LandoEvent[] = [];
      const frames: StreamFrameSinkFrame[] = [];
      const redaction = makeRedactionService();
      const values = await Effect.runPromise(redaction.payloadValues());
      const payloads = { stdout: createPayloadRedactor(values), stderr: createPayloadRedactor(values) };
      const script = [
        "# ---",
        "# flags:",
        `#   ${flagName}:`,
        ...(sensitivity === "explicit" ? ["#     sensitive: true"] : []),
        "# args:",
        `#   ${argName}:`,
        ...(sensitivity === "explicit" ? ["#     sensitive: true"] : []),
        "#     required: true",
        "# ---",
        `printf '%s\n' "$LANDO_FLAG_${flagName.toUpperCase()}" "$LANDO_ARG_${argName.toUpperCase()}" "$LANDO_INPUT"`,
        `printf '%s\n' "$LANDO_INPUT" 1>&2`,
      ].join("\n");
      const sink = StreamFrameSink.of({
        emit: (frame) =>
          Effect.sync(() => {
            const bytes =
              typeof frame.chunk === "string" ? new TextEncoder().encode(frame.chunk) : frame.chunk;
            frames.push({ ...frame, kind: "bytes", chunk: payloads[frame._tag].write(bytes) });
          }),
      });
      await withBunScript(script, async (root) => {
        const options = {
          name: "probe",
          input:
            inputMode === "RawArgv"
              ? { _tag: "RawArgv" as const, argv: [`--${flagName}=${token}`, password] }
              : { _tag: "NamedMaps" as const, flags: { [flagName]: token }, args: { [argName]: password } },
        };
        const discovered = await Effect.runPromise(
          parseScriptFile(join(root, ".lando/scripts/probe.bun.sh"), "probe.bun.sh"),
        );
        const execution =
          entry === "direct"
            ? runBunShellScript(discovered, root, options)
            : runBunShellTooling(options, root);
        // When
        const result = await Effect.runPromise(
          (mode === "live" ? execution.pipe(Effect.provideService(StreamFrameSink, sink)) : execution).pipe(
            Effect.provide(Layer.merge(scriptHostLayer, testEnvironmentResolverLayerFor(redaction))),
            Effect.provideService(RedactionService, redaction),
            Effect.provideService(EventService, recordingScriptEvents(events)),
          ),
        );
        for (const channel of ["stdout", "stderr"] as const)
          frames.push({ _tag: channel, kind: "bytes", chunk: payloads[channel].flush() });
        // Then
        const frameText = (channel: "stdout" | "stderr") =>
          frames
            .filter((frame) => frame._tag === channel)
            .map((frame) =>
              typeof frame.chunk === "string" ? frame.chunk : new TextDecoder().decode(frame.chunk),
            )
            .join("");
        const stdout = mode === "live" ? frameText("stdout") : result?.stdout;
        const stderr = mode === "live" ? frameText("stderr") : result?.stderr;
        const expectedJson = JSON.stringify({
          flags: { [flagName]: "[redacted]" },
          args: { [argName]: "[redacted]" },
        });
        expect(result?.exitCode).toBe(0);
        expect(stdout).toBe(`[redacted]\n[redacted]\n${expectedJson}\n`);
        expect(stderr).toBe(`${expectedJson}\n`);
        const shellEvents = events.filter(
          (event) => event._tag === "pre-shell-exec" || event._tag === "post-shell-exec",
        );
        expect(shellEvents.map((event) => event._tag)).toEqual(["pre-shell-exec", "post-shell-exec"]);
        expect(JSON.stringify(shellEvents)).not.toContain("script-canary");
        expect(JSON.stringify(shellEvents)).toContain("[redacted]");
      });
    },
  );

  test.each(
    ["RawArgv", "NamedMaps"].flatMap((inputMode) =>
      [true, false].flatMap((enabled) => ["live", "collected"].map((mode) => ({ inputMode, enabled, mode }))),
    ),
  )(
    `${entry} preserves boolean values and ordinary positionals for $inputMode in $mode output`,
    async ({ inputMode, enabled, mode }) => {
      // Given
      const redaction = makeRedactionService();
      const payload = createPayloadRedactor(await Effect.runPromise(redaction.payloadValues()));
      const frames: Uint8Array[] = [];
      const sink = StreamFrameSink.of({
        emit: (frame) =>
          Effect.sync(() => {
            if (frame._tag === "stdout")
              frames.push(
                payload.write(
                  typeof frame.chunk === "string" ? new TextEncoder().encode(frame.chunk) : frame.chunk,
                ),
              );
          }),
      });
      const script = [
        "# ---",
        "# flags:",
        "#   token:",
        "#     boolean: true",
        "# args:",
        "#   path:",
        "# ---",
        'echo "$LANDO_FLAG_TOKEN|$LANDO_ARG_PATH|true|false"',
      ].join("\n");
      await withBunScript(script, async (root) => {
        const options = {
          name: "probe",
          input:
            inputMode === "RawArgv"
              ? { _tag: "RawArgv" as const, argv: [`--token=${enabled}`, "src"] }
              : { _tag: "NamedMaps" as const, flags: { token: enabled }, args: { path: "src" } },
        };
        const discovered = await Effect.runPromise(
          parseScriptFile(join(root, ".lando/scripts/probe.bun.sh"), "probe.bun.sh"),
        );
        // When
        const result = await Effect.runPromise(
          (entry === "direct"
            ? runBunShellScript(discovered, root, options)
            : runBunShellTooling(options, root)
          ).pipe(
            Effect.provide(Layer.merge(scriptHostLayer, testEnvironmentResolverLayerFor(redaction))),
            Effect.provideService(RedactionService, redaction),
            Effect.provide(mode === "live" ? Layer.succeed(StreamFrameSink, sink) : Layer.empty),
          ),
        );
        // Then
        frames.push(payload.flush());
        const stdout = mode === "live" ? new TextDecoder().decode(Buffer.concat(frames)) : result?.stdout;
        expect(stdout).toBe(`${enabled}|src|true|false\n`);
      });
    },
  );

  test.each(
    ["env", "input", "registered"].flatMap((source) =>
      ["true", "false"].map((secret) => ({ source, secret })),
    ),
  )(`${entry} still redacts a genuine $source secret value $secret`, async ({ source, secret }) => {
    // Given
    const redaction = makeRedactionService();
    if (source === "registered") await Effect.runPromise(redaction.registerValues([secret]));
    const script = [
      "# ---",
      "# flags:",
      "#   token:",
      "#     boolean: true",
      "#   note:",
      "#     sensitive: true",
      "# ---",
      'echo "$LANDO_FLAG_TOKEN|true|false"',
    ].join("\n");
    await withBunScript(script, async (root) => {
      const options = {
        name: "probe",
        input: {
          _tag: "NamedMaps" as const,
          flags: { token: true, ...(source === "input" ? { note: secret } : {}) },
          args: {},
        },
        ...(source === "env" ? { env: { PASSWORD: secret } } : {}),
      };
      const discovered = await Effect.runPromise(
        parseScriptFile(join(root, ".lando/scripts/probe.bun.sh"), "probe.bun.sh"),
      );
      // When
      const result = await Effect.runPromise(
        (entry === "direct"
          ? runBunShellScript(discovered, root, options)
          : runBunShellTooling(options, root)
        ).pipe(
          Effect.provide(Layer.merge(scriptHostLayer, testEnvironmentResolverLayerFor(redaction))),
          Effect.provideService(RedactionService, redaction),
        ),
      );
      // Then
      expect(result?.stdout).toBe(
        secret === "true" ? "[redacted]|[redacted]|false\n" : "true|true|[redacted]\n",
      );
    });
  });
}
