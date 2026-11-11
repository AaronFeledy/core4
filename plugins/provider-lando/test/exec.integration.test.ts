import { describe, expect, test } from "bun:test";
import { containerHelperTestOptions } from "@lando/container-runtime/testing/exec-supervision";
import { resolveLiveProviderSocket } from "@lando/engine/testing/live-provider-socket";
import { bringDown, bringUp, exec, execStream, makePodmanApiClient } from "@lando/provider-lando";
import { Effect, Stream } from "effect";
import { appId, decodeChunks, node, plan } from "./support/exec-fixture.ts";

describe("provider-lando exec", () => {
  test.skipIf(resolveLiveProviderSocket() === undefined)(
    "execs commands in a live Podman service",
    async () => {
      const socketPath = resolveLiveProviderSocket()?.socketPath;
      expect(socketPath).toBeTruthy();
      const api = makePodmanApiClient(socketPath ?? "");
      const helperOptions = await Effect.runPromise(containerHelperTestOptions(api));

      await Effect.runPromise(bringUp(plan, { api, ...helperOptions }));
      try {
        const chunks = await Effect.runPromise(
          execStream(
            plan,
            { app: appId, service: node.name },
            { command: ["node", "-e", "console.log('hi')"] },
            { api, ...helperOptions },
          ).pipe(Stream.runCollect, Effect.scoped),
        );
        const streamed = decodeChunks(chunks);
        const failed = await Effect.runPromise(
          exec(plan, { app: appId, service: node.name }, { command: ["false"] }, { api, ...helperOptions }),
        );

        expect(streamed.stdout).toContain("hi\n");
        expect(streamed.exitCode).toBe(0);
        expect(failed.exitCode).toBe(1);
        expect(failed.stderr).toBe("");
      } finally {
        await Effect.runPromise(bringDown(plan, { api }));
      }
    },
    60_000,
  );
});
