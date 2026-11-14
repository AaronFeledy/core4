import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileToolingCommands } from "@lando/engine/cache/command-compiler";
import { createBufferedRendererIO } from "@lando/renderer/io";
import { ToolingCompileError } from "@lando/sdk/errors";
import { LandofileShape } from "@lando/sdk/schema";
import { createRedactor } from "@lando/sdk/secrets";
import { Effect, Schema } from "effect";
import { resolveInvocationHead, splitInvocation } from "../../src/cli/invocation";
import { ownerPolicy } from "../../src/cli/invocation-owner";
import { refuseToolingInvocation } from "../../src/cli/tooling-refusal";
import { normalizedToolingRoute } from "../../src/cli/tooling-route";
import { unavailableToolingError } from "../../src/cli/tooling-unavailable";

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

test("cached refusal stays within disclosure bounds after supplied-value redaction", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-refusal-bounds-"));
  try {
    const sourcePath = join(root, ".lando.yml");
    const names = Array.from({ length: 10 }, (_, index) => `${"wxyz-".repeat(160)}${index}`);
    const authored = {
      name: "refusal-bounds",
      tooling: {
        bad: {
          cmd: "echo must-not-run",
          flags: Object.fromEntries(names.map((name) => [name, { alias: "q" }])),
        },
      },
    };
    await writeFile(sourcePath, Bun.YAML.stringify(authored));
    const landofile = Schema.decodeUnknownSync(LandofileShape)(authored, { onExcessProperty: "error" });
    const [entry] = compileToolingCommands(landofile, createRedactor("secrets").redactString, {
      sourcePath,
      toolingSource: () => ({
        path: sourcePath,
        locate: (path) => ({ layer: "canonical", file: sourcePath, path }),
      }),
    });
    if (entry === undefined) throw new Error("Missing compiled task");
    const route = normalizedToolingRoute(entry, undefined, sourcePath);
    const refusal = await Effect.runPromise(unavailableToolingError(route));
    if (!(refusal instanceof ToolingCompileError)) throw new Error("Missing cached compile diagnostic");
    expect(bytes(refusal)).toBeLessThanOrEqual(16 * 1024);
    expect(bytes(refusal.message)).toBeLessThanOrEqual(1024);
    const argv = ["bad", "--renderer=wxyz", "--json"];
    const head = resolveInvocationHead(argv);
    const split = splitInvocation(argv, head, ownerPolicy({ kind: "tooling", route, refusal }));
    const io = createBufferedRendererIO();
    const statuses: number[] = [];

    await refuseToolingInvocation({
      route,
      refusal,
      head,
      split,
      rawArgv: argv,
      configGlobals: {},
      context: {
        cwd: root,
        env: {},
        io,
        setExitCode: (code) => {
          statuses.push(code);
        },
      },
    });

    const envelope = Schema.decodeUnknownSync(
      Schema.Struct({ ok: Schema.Literal(false), error: Schema.Unknown }),
    )(JSON.parse(io.stdout()));
    expect(bytes(envelope.error)).toBeLessThanOrEqual(16 * 1024);
    const emitted = Schema.decodeUnknownSync(ToolingCompileError)(envelope.error);
    expect(statuses).toEqual([1]);
    expect(bytes(emitted.message)).toBeLessThanOrEqual(1024);
    expect(bytes(emitted.remediation)).toBeLessThanOrEqual(1024);
    expect(emitted.issues.length).toBeLessThanOrEqual(8);
    expect(emitted.issues.length + emitted.omittedIssueCount).toBe(9);
    expect(emitted.source).toEqual({ path: sourcePath, task: "bad" });
    expect(io.stdout() + io.stderr()).not.toContain("wxyz");
    const redactedNames = names.map((name) => name.replaceAll("wxyz", "[redacted]"));
    const firstName = `${"[redacted]-".repeat(160)}0`;
    expect(emitted.issues.length).toBeGreaterThan(0);
    for (const issue of emitted.issues) {
      expect(issue.reason).toBe("alias-collision");
      expect(redactedNames).toContain(String(issue.path[3]));
      expect(issue.source).toEqual({ layer: "canonical", file: sourcePath, path: issue.path });
      expect(issue.related).toEqual([
        {
          path: ["tooling", "bad", "flags", firstName, "alias"],
          source: {
            layer: "canonical",
            file: sourcePath,
            path: ["tooling", "bad", "flags", firstName, "alias"],
          },
        },
      ]);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
