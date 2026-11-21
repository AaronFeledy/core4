import { expect, test } from "bun:test";
import { join } from "node:path";
import { ServiceName } from "@lando/sdk/schema";
import { Effect } from "effect";
import { decodeScratchLandofile } from "../../src/scratch-app/landofile.ts";

test("locates an invalid service key in a scratch Landofile", async () => {
  const root = process.cwd();
  const file = join(root, ".lando.yml");
  const yaml = "name: scratch-app\nservices:\n  bad/name:\n    image: nginx\n";
  await expect(Effect.runPromise(decodeScratchLandofile(file, yaml, root))).rejects.toMatchObject({
    _tag: "ScratchAppError",
    cause: {
      _tag: "LandofileValidationError",
      issues: [{ path: ["services", "bad/name"], source: { file, path: ["services", "bad/name"] } }],
    },
  });
});

test("scratch Landofiles decode endpoint shorthand and authored filter kinds", async () => {
  const root = process.cwd();
  const yaml = `name: scratch-app
services:
  web:
    type: compose
    image: nginx:alpine
    endpoints: [http:80]
    routes:
      - hostname: scratch.test
        filters:
          - kind: redirect
            to: https://elsewhere.test
`;
  const loaded = await Effect.runPromise(decodeScratchLandofile(join(root, ".lando.yml"), yaml, root));
  expect(loaded.document.services?.[ServiceName.make("web")]).toMatchObject({
    endpoints: [{ kind: "internal", protocol: "http", port: 80 }],
    routes: [{ hostname: "scratch.test", filters: [{ kind: "redirect", to: "https://elsewhere.test" }] }],
  });
});
