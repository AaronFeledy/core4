import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { Cause, Context, Effect, Exit, Layer, Option } from "effect";

import { NoCertificateAuthorityError } from "@lando/sdk/errors";
import { AbsolutePath } from "@lando/sdk/schema";

import { CertificateAuthorityResolver } from "../../src/plugins/certificate-authority-resolver.ts";
import { makeLandoRuntime } from "../../src/runtime/layer.ts";
import type { LandoRuntimeOptions } from "../../src/runtime/runtime-options.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const resolveAuthority = (
  plugins: NonNullable<LandoRuntimeOptions["plugins"]>,
  config?: LandoRuntimeOptions["config"],
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(makeLandoRuntime({ bootstrap: "provider", plugins, config }));
      return yield* Context.get(context, CertificateAuthorityResolver).resolve;
    }),
  );

const writeDiscoveredAuthority = async (root: string): Promise<string> => {
  const userDataRoot = join(root, "data");
  const registryRoot = join(userDataRoot, "plugins");
  const packageRoot = join(root, "custom-ca");
  await mkdir(registryRoot, { recursive: true });
  await mkdir(packageRoot, { recursive: true });

  const effectUrl = pathToFileURL(
    resolve(import.meta.dirname, "../../../node_modules/effect/dist/esm/index.js"),
  );
  const servicesUrl = pathToFileURL(resolve(import.meta.dirname, "../../../sdk/src/services/index.ts"));
  await writeFile(
    join(packageRoot, "ca.mjs"),
    [
      `import { Effect, Layer } from ${JSON.stringify(effectUrl.href)};`,
      `import { CertificateAuthority } from ${JSON.stringify(servicesUrl.href)};`,
      "export const ca = Layer.succeed(CertificateAuthority, {",
      '  id: "custom-ca",',
      "  setup: () => Effect.void,",
      '  issueCert: () => Effect.succeed({ certPath: "/tmp/cert", keyPath: "/tmp/key", caPath: "/tmp/ca" }),',
      "});",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(packageRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "@example/custom-ca",
        version: "1.0.0",
        landoPlugin: {
          name: "@example/custom-ca",
          version: "1.0.0",
          api: 4,
          contributes: {
            certificateAuthorities: [
              { id: "custom-ca", module: "./ca.mjs", defaultFor: { platform: [process.platform] } },
            ],
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(registryRoot, "registry.json"),
    `${JSON.stringify(
      {
        "@example/custom-ca": {
          name: "@example/custom-ca",
          version: "1.0.0",
          path: packageRoot,
        },
      },
      null,
      2,
    )}\n`,
  );
  return userDataRoot;
};

describe("runtime certificate authority discovery", () => {
  test("selects bundled mkcert for the default CLI discovery source", async () => {
    const authority = await Effect.runPromise(
      resolveAuthority({
        policy: "discovery",
        discovery: { bundled: true, system: false, user: false, app: false },
      }),
    );

    expect(authority.id).toBe("mkcert");
  });

  test("does not use bundled mkcert when the plugin is explicitly disabled", async () => {
    const exit = await Effect.runPromiseExit(
      resolveAuthority({
        policy: "discovery",
        discovery: { bundled: true, system: false, user: false, app: false },
        disable: ["@lando/ca-mkcert"],
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(Option.isSome(failure) && failure.value instanceof NoCertificateAuthorityError).toBe(true);
    }
  });

  test("selects a discovered user authority after bundled mkcert is disabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "lando-ca-discovery-"));
    tempRoots.push(root);
    const userDataRoot = await writeDiscoveredAuthority(root);

    const authority = await Effect.runPromise(
      resolveAuthority(
        {
          policy: "discovery",
          discovery: { bundled: true, system: false, user: true, app: false },
          disable: ["@lando/ca-mkcert"],
        },
        { userDataRoot: AbsolutePath.make(userDataRoot) },
      ),
    );

    expect(authority.id).toBe("custom-ca");
  });
});
