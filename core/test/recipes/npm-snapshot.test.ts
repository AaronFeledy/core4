import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScratchInitAppPort } from "@lando/engine/scratch-app/service";
import { ProcessRunner } from "@lando/sdk/services";
import { Effect, Layer } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { layer } from "../../src/runtime/scratch-init-port";
import { privateFileAccessLayer } from "../_support/private-file-access";
import { processRunnerFor } from "../_support/process-runner";
import { withEnvVar } from "../_support/temp-cwd";

test("retained scratch init observes npm config changes on every acquisition", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-npm-snapshot-"));
  const recipe = join(root, "recipe");
  const requests: { url: string; authorization: string | undefined }[] = [];
  const client = HttpClient.make((request, url) =>
    Effect.sync(() => {
      requests.push({ url: url.href, authorization: request.headers.authorization });
      return HttpClientResponse.fromWeb(request, new Response("denied", { status: 401 }));
    }),
  );
  try {
    await mkdir(recipe);
    await writeFile(
      join(recipe, "recipe.yml"),
      "id: recipe\ntitle: Child\ndescription: Private npm parent.\nversion: 1.0.0\nextends: npm:@acme/parent\nconfig:\n",
    );
    await withEnvVar("NPM_CONFIG_USERCONFIG", join(root, "absent-npmrc"), async () => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const port = yield* ScratchInitAppPort;
            for (const host of ["first.test", "second.test"]) {
              yield* Effect.promise(() =>
                withEnvVar("npm_config_@acme:registry", `https://${host}/`, () =>
                  withEnvVar(`npm_config_//${host}/:_authToken`, `token-${host}`, async () => {
                    const result = await port
                      .initApp({
                        cwd: root,
                        destination: join(root, host),
                        recipe,
                        name: "snapshot",
                        full: false,
                        runPostInit: false,
                        yes: true,
                        nonInteractive: true,
                      })
                      .catch((error: unknown) => error);
                    expect(String(result)).toContain("401");
                  }),
                ),
              );
            }
          }),
        ).pipe(
          Effect.provide(
            layer.pipe(
              Layer.provide(
                Layer.mergeAll(
                  privateFileAccessLayer,
                  Layer.succeed(HttpClient.HttpClient, client),
                  Layer.succeed(
                    ProcessRunner,
                    processRunnerFor(() => Effect.succeed({ exitCode: 0 })),
                  ),
                ),
              ),
            ),
          ),
        ),
      );
    });
    expect(requests).toEqual([
      { url: "https://first.test/@acme%2fparent", authorization: "Bearer token-first.test" },
      { url: "https://second.test/@acme%2fparent", authorization: "Bearer token-second.test" },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
