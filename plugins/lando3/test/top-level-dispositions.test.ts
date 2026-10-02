import { expect, test } from "bun:test";
import { ConfigTranslateInput } from "@lando/sdk/schema";
import { Effect, Schema } from "effect";
import { lando3ConfigTranslator } from "../src/translator.ts";

const translate = (text: string) =>
  Effect.runPromise(
    lando3ConfigTranslator.translate(
      Schema.decodeUnknownSync(ConfigTranslateInput)({
        _tag: "landofile-document-set",
        mode: "full",
        selectedSourceIds: ["source"],
        currentLowerV4Fragments: [],
        writableLayerIds: ["canonical"],
        documents: [
          {
            sourceId: "source",
            layerId: "canonical",
            path: ".lando.yml",
            mediaType: "application/yaml",
            bytes: Buffer.from(text).toString("base64"),
            contentDigest: `sha256:${new Bun.CryptoHasher("sha256").update(text).digest("hex")}`,
          },
        ],
      }),
    ),
  );

const dropped = [
  "domain",
  "bindAddress",
  "proxyName",
  "proxyHttpPort",
  "proxyHttpsPort",
  "proxyHttpFallbacks",
  "proxyHttpsFallbacks",
  "proxyBindAddress",
  "proxyPassThru",
  "proxyDefaultCert",
  "proxyDefaultKey",
  "proxyCache",
  "proxyCommand",
  "proxyCustom",
  "networkBridge",
  "networkLimit",
  "engineConfig",
  "dockerBin",
  "orchestratorVersion",
  "orchestratorBin",
  "composeBin",
  "orchestratorSeparator",
  "dockerSupportedVersions",
  "appEnv",
  "appLabels",
  "maxKeyWarning",
  "disablePlugins",
  "experimental",
  "alliance",
  "setup",
  "channel",
  "stats",
  "logLevel",
  "logLevelConsole",
  "logDir",
  "mode",
  "isInteractive",
  "userAgent",
  "proxyContainer",
  "proxyNet",
  "proxyDir",
  "proxyConfigDir",
  "proxyCurrentPorts",
  "proxyHttpPorts",
  "proxyHttpsPorts",
  "proxyLastPorts",
  "proxyScanHttp",
  "proxyScanHttps",
  "proxyDomain",
  "proxyIp",
  "dockerBinDir",
  "orchestratorMV",
  "uid",
  "gid",
  "username",
  "caCert",
  "caKey",
  "caDomain",
  "userConfRoot",
  "home",
  "configSources",
  "envPrefix",
  "product",
  "hyperdrive",
  "runtime",
  "version",
  "cli",
  "coreBase",
  "srcRoot",
  "fatcore",
  "packaged",
  "leia",
  "os",
  "isArmed",
  "node",
  "process",
  "instance",
  "id",
  "user",
  "env",
  "command",
  "landoFileConfig",
  "hconf",
] as const;

test.each([...dropped])("drops global %s once without blocking authoring output", async (key) => {
  // Given a global-only key in an explicitly supplied Landofile.
  const text = `name: demo\n${key}: {nested: 'lando pull $LANDO_INFO'}\n`;
  // When translating it.
  const result = await translate(text);
  // Then the global owner alone diagnoses the path and retains the preview fragment.
  expect(result.diagnostics.map(({ kind, keyPath }) => ({ kind, keyPath }))).toEqual([
    { kind: "dropped", keyPath: [key] },
  ]);
  expect(result.diagnostics[0]?.remediation).toBeTruthy();
  expect(result.outputs[0]?.fragment).toEqual({ name: "demo" });
});

test.each(["pluginConfig", "pluginConfigFile"])(
  "blocks private registry %s without disclosing values",
  async (key) => {
    // Given a private registry credential.
    const secret = "canary-private-registry-token";
    // When translating it.
    const result = await translate(`name: demo\n${key}: ${secret}\n`);
    // Then one blocking diagnostic contains no credential.
    expect(result.diagnostics.map(({ kind, keyPath }) => ({ kind, keyPath }))).toEqual([
      { kind: "unsupported", keyPath: [key] },
    ]);
    expect(JSON.stringify(result.diagnostics)).not.toContain(secret);
  },
);

test("leaves unknown keys to the model and preserves extensions", async () => {
  // Given an unknown key and an extension.
  const text = "name: demo\nunknownSetting: true\nx-custom: preserved\n";
  // When translating.
  const result = await translate(text);
  // Then no catch-all unsupported diagnostic competes with the model.
  expect(result.diagnostics.map(({ kind, keyPath }) => ({ kind, keyPath }))).toEqual([
    { kind: "dropped", keyPath: ["unknownSetting"] },
  ]);
  expect(result.outputs[0]?.fragment).toEqual({ name: "demo", "x-custom": "preserved" });
});
