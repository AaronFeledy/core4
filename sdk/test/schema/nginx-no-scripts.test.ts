import { describe, expect, test } from "bun:test";
import { Result, Schema } from "effect";

import {
  LandofileShape,
  NginxNoScriptPath,
  NGINX_NO_SCRIPT_PATH_PATTERN,
  ServiceConfig,
  ServiceName,
  isNginxNoScriptPath,
} from "@lando/sdk/schema";

const decodeService = (raw: unknown, options?: { readonly onExcessProperty?: "error" }): ServiceConfig =>
  Schema.decodeUnknownSync(ServiceConfig)(raw, options);

const decodeLandofileService = (raw: unknown): ServiceConfig => {
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    name: "myapp",
    services: { web: raw },
  });
  const service = landofile.services?.[ServiceName.make("web")];
  if (service === undefined) throw new Error("web service missing");
  return service;
};

const rejectedPaths = [
  "",
  "/",
  "/sites/default/files",
  "sites/default/files/",
  "sites/../files",
  "sites/**/files",
  "sites/*/files ",
  "sites/* /files",
  "files; } location / {",
  "files{deny",
  'files"x',
  "files'x",
  "files$uri",
  "files\\x",
  "files(x",
  "files)x",
  "files|x",
  "files^x",
  "files?x",
  "files+x",
  "files[x",
  "files]x",
  "files}x",
  "files x",
] as const;

describe("NginxNoScriptPath", () => {
  test.each(["sites/*/files", "uploads", "sites/default/files", "wp-content/uploads", "a.b_c-d/e"])(
    "accepts %j",
    (path) => {
      expect(isNginxNoScriptPath(path)).toBe(true);
      expect(Schema.decodeUnknownSync(NginxNoScriptPath)(path)).toBe(path);
    },
  );

  test.each(rejectedPaths)("rejects %j", (path) => {
    expect(isNginxNoScriptPath(path)).toBe(false);
    expect(Result.isFailure(Schema.decodeUnknownResult(NginxNoScriptPath)(path))).toBe(true);
    expect(Result.isFailure(Schema.decodeUnknownResult(ServiceConfig)({ noScripts: [path] }))).toBe(true);
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(LandofileShape)({
          name: "myapp",
          services: { web: { type: "nginx", noScripts: [path] } },
        }),
      ),
    ).toBe(true);
  });

  test("publishes the allowlist pattern", () => {
    expect(NGINX_NO_SCRIPT_PATH_PATTERN.test("sites/*/files")).toBe(true);
    expect(NGINX_NO_SCRIPT_PATH_PATTERN.test("**")).toBe(false);
  });
});

describe("ServiceConfig.noScripts", () => {
  test.each([{ onExcessProperty: "error" as const }, {}])(
    "accepts its canonical list under %j and decode(decode(x))",
    (options) => {
      const input = { type: "nginx", noScripts: ["sites/*/files", "uploads"] };
      const once = decodeService(input, options);
      expect(once.noScripts).toEqual(["sites/*/files", "uploads"]);
      expect(decodeService(once, options)).toEqual(once);
      expect(Schema.encodeSync(ServiceConfig)(once).noScripts).toEqual(["sites/*/files", "uploads"]);
    },
  );

  test("omits the field when it is not authored", () => {
    expect(decodeService({ type: "nginx" }).noScripts).toBeUndefined();
    expect(decodeLandofileService({ type: "nginx" }).noScripts).toBeUndefined();
  });

  test("accepts an empty list so a recipe default can be cleared", () => {
    expect(decodeService({ type: "nginx", noScripts: [] }).noScripts).toEqual([]);
  });
});
