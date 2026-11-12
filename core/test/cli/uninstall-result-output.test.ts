import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UninstallResultSchema } from "@lando/engine/operations/uninstall";
import { HostMaintenanceRegistry } from "@lando/engine/runtime/host-maintenance";
import { createBufferedRendererIO } from "@lando/renderer/io";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { Effect, Layer, Schema } from "effect";
import { metaUninstallSpec } from "../../src/cli/command-specs/meta/uninstall.ts";
import { runWithRendererHandling } from "../../src/cli/renderer-boundary.ts";

test("uninstall machine output retains owned classification for manual contributions and blocked roots", async () => {
  const completion = metaUninstallSpec.completion;
  if (completion === undefined) throw new Error("Uninstall requires a completion handler");
  const root = mkdtempSync(join(tmpdir(), "lando-uninstall-output-"));
  const data = join(root, "data");
  mkdirSync(data);
  const io = createBufferedRendererIO();
  let exitCode = 0;
  const registry = Layer.succeed(HostMaintenanceRegistry, {
    maintainers: [
      {
        id: "fixture",
        pluginId: "@lando/test",
        uninstall: {
          plan: () =>
            Effect.succeed([
              {
                id: "helper",
                label: "helper",
                target: join(root, "helper"),
                status: "owned",
                destructive: true,
                detail: "owned helper",
              },
            ]),
          execute: () => Effect.succeed({ outcome: "manual", detail: "ownership changed" }),
        },
      },
    ],
  });
  try {
    await runWithRendererHandling(
      metaUninstallSpec.run({
        flags: { yes: true, purge: true },
        _userDataRoot: data,
        _userCacheRoot: join(root, "cache"),
        _userConfRoot: join(root, "config"),
        _cgroupsDelegatePath: join(root, "delegate.conf"),
        _shellProfilePath: join(root, "profile"),
        _listDiscoveredApps: async () => [],
        _readManagedProviderMachine: () => ({ ownership: "absent" }),
      }),
      {
        runtime: Layer.merge(PrivateFileAccessService.layer, registry),
        rendererMode: "json",
        resultFormat: "json",
        command: metaUninstallSpec.id,
        resultSchema: metaUninstallSpec.resultSchema,
        completion: (result) => completion(result, {}),
        setExitCode: (code) => {
          exitCode = code;
        },
        io,
        render: () => "unused",
        formatError: () => "unexpected failure",
      },
    );
    const envelope = Schema.decodeUnknownSync(
      Schema.fromJsonString(
        Schema.Struct({
          ok: Schema.Boolean,
          result: UninstallResultSchema,
        }),
      ),
    )(io.stdout());
    expect(envelope.ok).toBe(false);
    expect(exitCode).toBe(1);
    expect(envelope.result.failed).toBe(true);
    expect(envelope.result.steps.find((step) => step.id === "fixture:helper")).toMatchObject({
      status: "owned",
      outcome: "manual",
      detail: "ownership changed",
    });
    expect(envelope.result.steps.find((step) => step.id === "user-data-root")).toMatchObject({
      status: "owned",
      outcome: "failed",
      error: expect.any(String),
    });
    expect(existsSync(data)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
