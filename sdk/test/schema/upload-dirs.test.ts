import { describe, expect, test } from "bun:test";
import {
  LandofileShape,
  ServiceConfig,
  ServiceName,
  UPLOAD_DIR_PATTERN,
  UploadDir,
  isUploadDir,
} from "@lando/sdk/schema";
import { PhpServiceConfig } from "@lando/sdk/schema/services/php";
import { Result, Schema, SchemaIssue } from "effect";

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

const uploadDirIssueCount = (path: string): number => {
  const result = Schema.decodeUnknownResult(UploadDir)(path);
  if (!Result.isFailure(result)) {
    throw new Error("expected UploadDir decode to fail");
  }
  return SchemaIssue.makeFormatterStandardSchemaV1()(result.failure.issue).issues.length;
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
  "files;x",
  "files#x",
  "files\nx",
  "files\rx",
  "fïles",
  "files%x",
  "files,x",
  "files~x",
  "files=x",
  "files@x",
  "files!x",
  "files&x",
  "files:x",
  "files<x",
  "files`x",
  ".",
  "a/./b",
  "a//b",
  "*",
] as const;

describe("UploadDir", () => {
  test.each(["sites/*/files", "uploads", "sites/default/files", "wp-content/uploads", "a.b_c-d/e"])(
    "accepts %j",
    (path) => {
      expect(isUploadDir(path)).toBe(true);
      expect(UPLOAD_DIR_PATTERN.test(path)).toBe(true);
      expect(Schema.decodeUnknownSync(UploadDir)(path)).toBe(path);
    },
  );

  test.each([...rejectedPaths])("rejects %j", (path) => {
    expect(isUploadDir(path)).toBe(false);
    expect(UPLOAD_DIR_PATTERN.test(path)).toBe(false);
    expect(uploadDirIssueCount(path)).toBe(1);
    expect(Result.isFailure(Schema.decodeUnknownResult(ServiceConfig)({ uploadDirs: [path] }))).toBe(true);
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(LandofileShape)({
          name: "myapp",
          services: { web: { type: "nginx", uploadDirs: [path] } },
        }),
      ),
    ).toBe(true);
  });

  test("publishes the allowlist pattern", () => {
    expect(UPLOAD_DIR_PATTERN.test("sites/*/files")).toBe(true);
    expect(UPLOAD_DIR_PATTERN.test("**")).toBe(false);
  });
});

describe("ServiceConfig.uploadDirs", () => {
  test("accepts upload directories on the PHP per-type contract", () => {
    const config = Schema.decodeUnknownSync(PhpServiceConfig)(
      { type: "php:8.3", uploadDirs: ["uploads"] },
      { onExcessProperty: "error" },
    );
    expect(config.uploadDirs).toEqual(["uploads"]);
  });
  test.each([{ onExcessProperty: "error" as const }, {}])(
    "accepts its canonical list under %j and decode(decode(x))",
    (options) => {
      const input = { type: "nginx", uploadDirs: ["sites/*/files", "uploads"] };
      const once = decodeService(input, options);
      expect(once.uploadDirs).toEqual(["sites/*/files", "uploads"]);
      expect(decodeService(once, options)).toEqual(once);
      expect(Schema.encodeSync(ServiceConfig)(once).uploadDirs).toEqual(["sites/*/files", "uploads"]);
    },
  );

  test("omits the field when it is not authored", () => {
    expect(decodeService({ type: "nginx" }).uploadDirs).toBeUndefined();
    expect(decodeLandofileService({ type: "nginx" }).uploadDirs).toBeUndefined();
  });

  test("accepts an empty list so a recipe default can be cleared", () => {
    expect(decodeService({ type: "nginx", uploadDirs: [] }).uploadDirs).toEqual([]);
  });
});
