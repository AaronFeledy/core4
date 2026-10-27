import { expect, test } from "bun:test";
import { plugin } from "@lando/lando4";
import { parseLandofile } from "@lando/landofile/parser";
import { loadAuthoredDocuments } from "@lando/landofile/root-compile";
import { createStandaloneRedactor } from "@lando/redaction/service";
import { compileRecipeSource } from "@lando/sdk/recipes";
import { AbsolutePath, ServiceName } from "@lando/sdk/schema";
import { Effect, Result } from "effect";
import { makeCompiledRecipeDecomposer } from "../../src/recipes/compiled-decomposer.ts";
import { previewRecipeLandofile } from "../../src/recipes/init-pipeline.ts";

const source = (field = "services.app.environment.TOKEN") => ({
  id: "external-secret",
  title: "External secret",
  description: "Secret binding fixture",
  version: "1.0.0",
  options: {
    payload: { type: { kind: "string" }, default: "default data" },
    token: { type: { kind: "secret" }, disposition: { kind: "secret-store", field } },
  },
  config: {
    runtime: 4,
    services: {
      app: {
        type: "lando",
        image: "alpine:3.21",
        environment: {
          COPIED: "{{ recipe.payload }}",
          HELPER: "{{ lower('${secret:FORGED_HELPER}') }}",
          STATIC: "{{ app.name }}",
        },
      },
    },
  },
});
const compileContext = { sourceKind: "local", packageName: "local", assets: [] } as const;
const fixture = (field = "services.app.environment.TOKEN") => {
  const manifest = Result.getOrThrow(compileRecipeSource(source(field), compileContext));
  const appRoot = "/tmp/external-secret-bindings";
  const factory = makeCompiledRecipeDecomposer(manifest, {
    source: "/recipes/external/recipe.yml",
    appRoot: AbsolutePath.make(appRoot),
  });
  return { manifest, appRoot, factory };
};

test("approved secret-store reference populates its declared site without promoting option or helper data", async () => {
  // Given
  const { manifest, appRoot, factory } = fixture();
  const loader = plugin.configTranslators?.get("lando4");
  if (loader === undefined) throw new Error("missing encoder");
  // When
  const preview = await Effect.runPromise(
    previewRecipeLandofile({
      manifest,
      appRoot,
      decomposer: factory,
      answers: { payload: "${secret:FORGED_OPTION}" },
      secretAnswers: { token: "${secret:APP_TOKEN}" },
      appName: "external-secret",
      encoder: await loader(),
    }),
  );
  const loaded = await Effect.runPromise(
    parseLandofile({ file: `${appRoot}/.lando.yml`, cwd: appRoot, content: preview.text }).pipe(
      Effect.flatMap((value) =>
        loadAuthoredDocuments([{ file: `${appRoot}/.lando.yml`, value }], {
          appRoot,
          file: `${appRoot}/.lando.yml`,
        }),
      ),
    ),
  );
  // Then
  expect(loaded.document.services?.[ServiceName.make("app")]?.environment).toEqual({
    TOKEN: { _tag: "SecretRef", reference: "APP_TOKEN" },
    COPIED: "${secret:FORGED_OPTION}",
    HELPER: "${secret:forged_helper}",
    STATIC: "{{ app.name }}",
  });
  expect(loaded.pendingSites.map((site) => site.path.join("."))).toEqual(["services.app.environment.STATIC"]);
});

test.each(["name", "services.app.image", "services.app.environment.__proto__"])(
  "rejects a secret-store disposition outside a safe binding site: %s",
  async (field) => {
    // Given
    const { factory } = fixture(field);
    const decomposer = factory({ redactor: createStandaloneRedactor("secrets") });
    // When
    const result = await Effect.runPromise(
      Effect.result(
        decomposer.decompose({
          producer: decomposer.producer,
          options: {},
          secrets: { token: { disposition: "secret-store", reference: "${secret:APP_TOKEN}" } },
        }),
      ),
    );
    // Then
    expect(result).toMatchObject({ _tag: "Failure", failure: { reason: "invalid-secret-reference" } });
  },
);

test.each(["reference", "extra-field"])(
  "rejects raw secret %s payloads without retaining them",
  async (site) => {
    // Given
    const { factory } = fixture();
    const decomposer = factory({ redactor: createStandaloneRedactor("secrets") });
    const raw = "raw-secret-marker-never-retained";
    const secret = {
      disposition: "secret-store" as const,
      reference: site === "reference" ? raw : "${secret:APP_TOKEN}",
      ...(site === "extra-field" ? { raw } : {}),
    };
    // When
    const result = await Effect.runPromise(
      Effect.result(
        decomposer.decompose({
          producer: decomposer.producer,
          options: {},
          secrets: { token: secret },
        }),
      ),
    );
    // Then
    expect(result).toMatchObject({ _tag: "Failure", failure: { reason: "invalid-secret-reference" } });
    expect(JSON.stringify(result)).not.toContain(raw);
  },
);

test("records only nonsecret options in provenance after binding a stored secret", async () => {
  // Given
  const { factory } = fixture();
  const decomposer = factory({ redactor: createStandaloneRedactor("secrets") });
  // When
  const result = await Effect.runPromise(
    decomposer.decompose({
      producer: decomposer.producer,
      options: { payload: "public-option" },
      secrets: { token: { disposition: "secret-store", reference: "${secret:APP_TOKEN}" } },
    }),
  );
  // Then
  expect(result.fragment).toMatchObject({
    services: { app: { environment: { TOKEN: "${secret:APP_TOKEN}" } } },
  });
  expect(result.provenance.options).toEqual({ payload: "public-option" });
});
