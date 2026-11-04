import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { plugin } from "@lando/lando4";
import { Effect, Result } from "effect";
import { readAuxiliaryScaffoldContent } from "../../src/recipes/init-pipeline/files.ts";
import { containsSecretValue } from "../../src/recipes/init-pipeline/secrets.ts";
import { prepareRecipeInit } from "../../src/recipes/prepared-init.ts";
import { ownerOnlyFileAccess } from "../_support/private-file-access.ts";
import { runRecipeInitPipeline } from "../_support/recipe-pipeline.ts";
import { compileTestSource, prepareTestSource, testSource } from "./fixtures/prepared-source.ts";

const roots: string[] = [];
const temporary = async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-init-bytes-"));
  roots.push(root);
  return root;
};
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("roundtrips static disk bytes without decoding or template interpolation", async () => {
  // Given invalid UTF-8, a BOM, NUL, and an inert template token.
  const sourceRoot = await temporary();
  const appRoot = await temporary();
  const bytes = new Uint8Array([
    0xef,
    0xbb,
    0xbf,
    0,
    0xff,
    0xc3,
    0x28,
    ...new TextEncoder().encode("{{ app.name }}\r\n"),
  ]);
  await Bun.write(join(sourceRoot, "asset.bin"), bytes);

  // When a static scaffold is copied.
  const prepared = await prepareTestSource(
    { ...testSource, files: [{ src: "asset.bin", dest: "asset.bin" }] },
    sourceRoot,
    appRoot,
  );
  await Effect.runPromise(
    runRecipeInitPipeline({
      prepared,
      privateFileAccess: ownerOnlyFileAccess,
      journalRoot: () => join(sourceRoot, "journal"),
    }),
  );

  // Then every byte survives unchanged.
  expect(await Bun.file(join(appRoot, "asset.bin")).bytes()).toEqual(bytes);
});

test("returns bytes when a static source is valid UTF-8", async () => {
  // Given a static text file, whose encoding must remain opaque.
  const sourceRoot = await temporary();
  const bytes = new TextEncoder().encode("hello\r\n");
  await Bun.write(join(sourceRoot, "text"), bytes);
  // When acquiring it.
  const content = await readAuxiliaryScaffoldContent({
    sourceRoot,
    appName: "app",
    file: { src: "text", dest: "text" },
  });
  // Then the prepared value is the exact byte sequence.
  expect(content).toBeInstanceOf(Uint8Array);
  expect(content).toEqual(bytes);
});

test("rejects invalid UTF-8 when an asset is explicitly a template", async () => {
  // Given malformed template bytes on disk.
  const sourceRoot = await temporary();
  await Bun.write(join(sourceRoot, "template"), new Uint8Array([0xc3, 0x28]));
  // When the template is acquired, then decoding fails rather than replacing bytes.
  expect(
    readAuxiliaryScaffoldContent({
      sourceRoot,
      appName: "app",
      file: { src: "template", dest: "text", template: true },
    }),
  ).rejects.toThrow(TypeError);
});

test.each(["key", "päss🔐"])("finds raw secret %s inside invalid UTF-8", (secret) => {
  // Given secret UTF-8 bytes surrounded by malformed sequences.
  const bytes = new Uint8Array([0xff, 0, ...new TextEncoder().encode(secret), 0xfe]);
  // When scanning opaque bytes, then the secret is detected.
  expect(containsSecretValue([secret], bytes)).toBe(true);
});

test("does not match secret bytes outside a Uint8Array view", () => {
  // Given a subview excluding the secret in its backing buffer.
  const bytes = new TextEncoder().encode("secret-safe").subarray(7);
  // When scanning, then only the view's bytes participate.
  expect(containsSecretValue(["secret"], bytes)).toBe(false);
});

test("renders supplied template bytes without interpreting the substituted app name", async () => {
  // Given a UTF-8 template with a BOM and an app name containing replacement syntax.
  const bytes = new TextEncoder().encode("\ufeff{{ app.name }} / {{ app.name }}\r\n");
  // When the explicit template is rendered.
  const content = await readAuxiliaryScaffoldContent({
    appName: "${PORT}-$&",
    file: { src: "embedded", dest: "text", template: true },
    contentSource: async () => bytes,
  });
  // Then substitutions are literal, with the BOM and newline preserved.
  expect(content).toBe("\ufeff${PORT}-$& / ${PORT}-$&\r\n");
});

test("rejects invalid UTF-8 from a supplied template", async () => {
  // Given a byte supplier with a truncated UTF-8 sequence.
  const contentSource = async () => new Uint8Array([0xf0, 0x9f]);
  // When it is explicitly templated, then acquisition fails closed.
  expect(
    readAuxiliaryScaffoldContent({
      appName: "app",
      file: { src: "embedded", dest: "text", template: true },
      contentSource,
    }),
  ).rejects.toThrow(TypeError);
});

test("writes prepared bytes after their original source has disappeared", async () => {
  // Given acquired bytes and a removed source.
  const appRoot = await temporary();
  const sourceRoot = await temporary();
  const bytes = new Uint8Array([0xff, 0, 0xfe]);
  await Bun.write(join(sourceRoot, "asset"), bytes);
  const prepared = await prepareTestSource(
    { ...testSource, files: [{ src: "asset", dest: "asset" }] },
    sourceRoot,
    appRoot,
  );
  await rm(join(sourceRoot, "asset"));
  // When publishing the prepared value, no source is needed.
  await Effect.runPromise(
    runRecipeInitPipeline({
      prepared,
      privateFileAccess: ownerOnlyFileAccess,
      journalRoot: () => join(sourceRoot, "journal"),
    }),
  );
  // Then the originally prepared bytes are published unchanged.
  expect(await Bun.file(join(appRoot, "asset")).bytes()).toEqual(bytes);
});

test("refuses raw secret bytes before creating the destination's parents", async () => {
  // Given invalid UTF-8 surrounding an init-only secret.
  const appRoot = await temporary();
  const content = new Uint8Array([0xff, ...new TextEncoder().encode("hidden"), 0xfe]);
  const sourceRoot = await temporary();
  await Bun.write(join(sourceRoot, "asset"), content);
  const compiled = await compileTestSource(
    {
      ...testSource,
      files: [{ src: "asset", dest: "nested/asset" }],
      options: {
        token: { type: { kind: "secret" }, disposition: { kind: "init-only", sink: { kind: "stdin" } } },
      },
      postInit: [{ type: "command", cmd: "app:config:translate", stdin: { prompt: "token" } }],
    },
    sourceRoot,
  );
  const loader = plugin.configTranslators?.get("lando4");
  if (loader === undefined) throw new Error("Missing encoder");
  // When the prepared bytes reach the final write guard, then no content is published.
  const result = await Effect.runPromise(
    Effect.result(
      prepareRecipeInit({
        compiled,
        appRoot,
        appName: "prepared",
        answers: {},
        secretAnswers: { token: "hidden" },
        encoder: await loader(),
      }),
    ),
  );
  expect(Result.isFailure(result) && result.failure).toMatchObject({ stage: "validate" });
  expect(await Bun.file(join(appRoot, "nested/asset")).exists()).toBe(false);
});
