import { expect, test } from "bun:test";
import { join } from "node:path";
import { ServiceName } from "@lando/sdk/schema";
import { Effect } from "effect";
import { decodeScratchLandofile } from "../../src/scratch-app/landofile.ts";

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
