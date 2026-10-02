import { describe, expect, test } from "bun:test";
import { isLegacyTagged, parseLegacyLandofile } from "@lando/sdk/landofile";
import { Effect, Schema } from "effect";
import {
  Lando3Api3CatalogService,
  Lando3Api3RawService,
  Lando3Api4Service,
  Lando3LandofileShape,
  Lando3ToolingEntry,
  decodeLando3Landofile,
} from "../src/model.ts";
import pin from "./fixtures/lando3/pin.json";

const file = `${import.meta.dir}/fixtures/lando3/kitchen-sink.lando.yml`;
const parse = (content: string) => Effect.runSync(parseLegacyLandofile({ mode: "legacy", file, content }));
const corpus = async () => parse(await Bun.file(file).text());

describe("Lando 3 permissive shape model", () => {
  test("decodes the complete pinned corpus with zero unknown keys", async () => {
    const document = await corpus();
    const result = decodeLando3Landofile(document.value);
    expect(result.unknownKeys).toEqual([]);
    expect(Schema.is(Lando3LandofileShape)(result.landofile)).toBe(true);
  });

  test("retains typed app identity and free-form recipe options", async () => {
    const document = await corpus();
    const { landofile } = decodeLando3Landofile(document.value);
    if (!Schema.is(Lando3LandofileShape)(landofile)) throw new Error("Expected modeled corpus");
    expect(landofile.name).toBe("kitchen-sink");
    expect(landofile.recipe).toBe("drupal10");
    expect(landofile.config?.php).toBe("8.3");
  });

  test("distinguishes catalog, nested Compose, and API 4 services", async () => {
    const { value } = await corpus();
    const { landofile } = decodeLando3Landofile(value);
    if (!Schema.is(Lando3LandofileShape)(landofile)) throw new Error("Expected modeled corpus");
    const catalog = landofile.services?.appserver;
    const raw = landofile.services?.raw3;
    const leet = landofile.services?.leet;
    if (!Schema.is(Lando3Api3CatalogService)(catalog)) throw new Error("Expected catalog service");
    if (!Schema.is(Lando3Api3RawService)(raw)) throw new Error("Expected raw service");
    if (!Schema.is(Lando3Api4Service)(leet)) throw new Error("Expected API 4 service");
    expect(catalog.type).toBe("php:8.3");
    expect(catalog.webroot).toBe("web");
    expect(raw.services?.image).toBe("nginx:1.22.1");
    expect(leet.api).toBe(4);
    expect(leet.type).toBe("l337");
    expect(leet.image).toMatchObject({ tag: "lando/nginx:powerman-5000", buildx: true });
  });

  test("retains tooling options and multi-service command lists", async () => {
    const { value } = await corpus();
    const { landofile } = decodeLando3Landofile(value);
    if (!Schema.is(Lando3LandofileShape)(landofile)) throw new Error("Expected modeled corpus");
    const word = landofile.tooling?.word;
    const install = landofile.tooling?.install;
    if (!Schema.is(Lando3ToolingEntry)(word)) throw new Error("Expected word tooling");
    if (!Schema.is(Lando3ToolingEntry)(install)) throw new Error("Expected install tooling");
    expect(word.options?.word).toMatchObject({ passthrough: true, alias: ["w"] });
    expect(install.cmd).toEqual([
      { appserver: "cd /app && composer install --no-interaction" },
      { node: "pnpm install --frozen-lockfile\nturbo typecheck\n" },
      { appserver: "rsync -av /app/build/ /app/web/themes/custom/x/assets/" },
    ]);
  });

  test("retains event targets and both proxy route forms", async () => {
    const { value } = await corpus();
    const { landofile } = decodeLando3Landofile(value);
    if (!Schema.is(Lando3LandofileShape)(landofile)) throw new Error("Expected modeled corpus");
    expect(landofile.events?.["pre-start"]?.[1]).toEqual({
      database: 'mysql -uroot --silent --execute "SHOW DATABASES;"',
    });
    expect(landofile.proxy?.appserver?.[0]).toBe("kitchen-sink.lndo.site");
    expect(landofile.proxy?.node?.[2]).toMatchObject({
      hostname: "node.kitchen-sink.lndo.site",
      port: 3000,
      pathname: "/api",
      middlewares: [
        { name: "test", key: "headers.customrequestheaders.X-Lando-Test", value: "on" },
        { name: "test-secured", key: "headers.customrequestheaders.X-Lando-Test-SSL", value: "on" },
      ],
    });
  });

  test("retains Compose inputs, excludes, plugins, and named resources", async () => {
    const { value } = await corpus();
    const { landofile } = decodeLando3Landofile(value);
    if (!Schema.is(Lando3LandofileShape)(landofile)) throw new Error("Expected modeled corpus");
    expect(landofile.compose).toEqual(["compose.yml", "docker-compose/moar.yml"]);
    expect(landofile.excludes).toContain("!web/sites/default/files/keep-me");
    expect(landofile.plugins).toMatchObject({ "@lando/php": "lando/php#main" });
    expect(landofile.volumes).toEqual({ "my-data": null, go_path: { driver: "local" } });
    expect(landofile.networks).toEqual({ "my-network": null });
  });

  test("keeps load and import markers without resolving nonexistent files", () => {
    const document = parse(
      "config:\n  a: !load /nonexistent/model-test.yaml\n  b: !import /nonexistent/model-test.sh\n",
    );
    const result = decodeLando3Landofile(document.value);
    if (!Schema.is(Lando3LandofileShape)(result.landofile)) throw new Error("Expected modeled document");
    expect(result.tags).toEqual([
      { path: ["config", "a"], tag: "!load" },
      { path: ["config", "b"], tag: "!import" },
    ]);
    expect(isLegacyTagged(result.landofile.config?.a)).toBe(true);
    expect(isLegacyTagged(result.landofile.config?.b)).toBe(true);
    expect(result.landofile as unknown).toEqual(document.value);
  });

  test("finds every corpus tag without traversing marker metadata", async () => {
    const document = await corpus();
    const result = decodeLando3Landofile(document.value);
    expect(result.tags).toEqual(document.tags.map(({ path, tag }) => ({ path, tag })));
    expect(result.tags.map(({ tag }) => tag)).toContain("!load");
    expect(result.tags.map(({ tag }) => tag)).toContain("!import");
    expect(result.landofile as unknown).toEqual(document.value);
  });

  test("reports maximal unknown paths while retaining their values", () => {
    const document = parse(
      "totallyMadeUpKey: 1\nservices:\n  web:\n    type: php:8.3\n    alsoMadeUp: 2\n    weird:\n      nested: true\n",
    );
    const result = decodeLando3Landofile(document.value);
    expect(result.unknownKeys).toEqual([
      ["totallyMadeUpKey"],
      ["services", "web", "alsoMadeUp"],
      ["services", "web", "weird"],
    ]);
    expect(result.landofile as unknown).toEqual(document.value);
  });

  test("reports nested modeled-object extras but ignores free-form bags and anchors", () => {
    const document = parse(
      "x-anchor: {anything: true}\nconfig: {anything: true}\nproxy:\n  web:\n    - hostname: test.lndo.site\n      weird: {leaf: 1}\nservices:\n  web:\n    type: php\n    scanner: {timeout: 10, weird: {leaf: 2}}\n",
    );
    const result = decodeLando3Landofile(document.value);
    expect(result.unknownKeys).toEqual([
      ["proxy", "web", 0, "weird"],
      ["services", "web", "scanner", "weird"],
    ]);
    expect(result.landofile as unknown).toEqual(document.value);
  });

  test("retains unrecognized service shapes and malformed modeled fields", () => {
    const document = parse(
      "name: [unexpected]\nservices:\n  future: {api: 9, type: future, newOption: {leaf: 1}}\n  disabled: false\n  patch: {build: [echo ok]}\n",
    );
    const result = decodeLando3Landofile(document.value);
    expect(result.landofile as unknown).toEqual(document.value);
    expect(result.unknownKeys).toEqual([["services", "future", "newOption"]]);
  });

  test("models custom basenames and defaults absent service api to family 3", () => {
    const document = parse(
      "landoFile: custom.yml\npreLandoFiles: [base.yml]\npostLandoFiles: [local.yml]\nservices:\n  raw: {type: lando, services: {image: nginx}}\n  catalog: {type: node, services: {image: nginx}}\n",
    );
    const result = decodeLando3Landofile(document.value);
    expect(result.unknownKeys).toEqual([["services", "catalog", "services"]]);
    expect(result.landofile as unknown).toEqual(document.value);
  });

  test("produces structurally identical results for the same input", async () => {
    const document = await corpus();
    const results = [decodeLando3Landofile(document.value), decodeLando3Landofile(document.value)];
    expect(results[0]).toEqual(results[1]);
  });

  test("matches the pinned corpus byte length and sha256", async () => {
    const expected = pin.files.find(({ vendored }) => vendored === "kitchen-sink.lando.yml");
    if (expected === undefined) throw new Error("The pin manifest must record the kitchen-sink corpus.");
    const bytes = await Bun.file(file).bytes();
    expect(bytes.byteLength).toBe(expected.bytes);
    expect(new Bun.CryptoHasher("sha256").update(bytes).digest("hex")).toBe(expected.sha256);
  });
});
