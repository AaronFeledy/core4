import { describe, expect, test } from "bun:test";
import { LEGACY_TAGGED } from "@lando/sdk/landofile";
import { ServiceConfig } from "@lando/sdk/schema";
import { Schema } from "effect";
import { lowerApi4Service } from "../src/lower-api4.ts";
import type { LoweringPatch, ServiceLoweringContext } from "../src/lowering-contract.ts";

const ctx: ServiceLoweringContext = {
  serviceName: "leet",
  keyPath: ["services", "leet"],
  fallbackSourceId: "source",
  occurrenceAt: () => undefined,
  topLevel: { excludes: [], includes: [] },
};
const paths = (result: LoweringPatch, kind: string) =>
  result.diagnostics.filter((diagnostic) => diagnostic.kind === kind).map((diagnostic) => diagnostic.keyPath);
const path = (...relative: (string | number)[]) => ["services", "leet", ...relative];

describe("API-4 service lowering", () => {
  test("preserves a minimal service when defaults are disabled", () => {
    // Given
    const service = {
      api: 4,
      image: "curlimages/curl:8.10.1",
      command: "sleep infinity",
      "app-mount": false,
      certs: false,
    };
    // When
    const result = lowerApi4Service(service, ctx);
    // Then
    expect(result).toEqual({
      patch: { type: "lando", image: service.image, command: service.command, appMount: false, certs: false },
      diagnostics: [],
    });
  });
  test("blocks SSH forwarding when enabled", () => {
    const result = lowerApi4Service({ image: { ssh: true } }, ctx);
    expect(paths(result, "unsupported")).toEqual([path("image", "ssh")]);
    expect(result.blocked).toBe(true);
  });
  test.each(["https://example.test/repo", "git@example.test:repo"])(
    "blocks remote context %s and drops local context once",
    (remote) => {
      const result = lowerApi4Service(
        { image: { context: [{ source: remote }, { src: "./local", destination: "/src" }] } },
        ctx,
      );
      expect(paths(result, "unsupported")).toEqual([path("image", "context", 0)]);
      expect(paths(result, "dropped")).toEqual([path("image", "context", 1)]);
      expect(result.blocked).toBe(true);
    },
  );
  test("diagnoses each unsupported image subfield separately", () => {
    const result = lowerApi4Service(
      { image: { tag: "test", buildx: false, buildkit: true, groups: [{}, {}], steps: [{}, {}] } },
      ctx,
    );
    expect(paths(result, "dropped")).toEqual([
      path("image", "tag"),
      path("image", "buildx"),
      path("image", "buildkit"),
      path("image", "groups", 0),
      path("image", "groups", 1),
      path("image", "steps", 0),
      path("image", "steps", 1),
    ]);
    expect(result.diagnostics).toHaveLength(7);
  });
  test("rewrites inline Dockerfiles when imagefile is supplied", () => {
    const result = lowerApi4Service({ image: { imagefile: "FROM alpine", args: ["A=x=y"] } }, ctx);
    expect(result.patch.build).toEqual({ context: ".", dockerfileInline: "FROM alpine", args: { A: "x=y" } });
    expect(paths(result, "rewritten")).toEqual([path("image", "imagefile")]);
    expect(() => Schema.decodeUnknownSync(ServiceConfig)(result.patch)).not.toThrow();
  });
  test("rewrites Dockerfile paths and mapping arguments", () => {
    const result = lowerApi4Service(
      { type: "l337", image: { dockerfile: "Dockerfile.dev", args: { N: 3 } } },
      ctx,
    );
    expect(result.patch).toEqual({
      type: "lando",
      build: { context: ".", dockerfile: "Dockerfile.dev", args: { N: "3" } },
    });
    expect(paths(result, "rewritten")).toEqual([path("image", "dockerfile")]);
  });
  test("lowers binds and diagnoses individual unsupported mount fields", () => {
    const result = lowerApi4Service(
      {
        mounts: [
          "./a:/a:ro",
          { source: "./b", destination: "/b", readOnly: false, includes: ["keep"] },
          { contents: "bytes", target: "/file" },
          { source: "./c", target: "/c", type: "copy" },
          { source: "./d", target: "/d", group: "www" },
        ],
      },
      ctx,
    );
    expect(result.patch.mounts).toEqual([
      { source: "./a", target: "/a", readOnly: true },
      { source: "./b", target: "/b", readOnly: false, includes: ["keep"] },
      { source: "./c", target: "/c" },
      { source: "./d", target: "/d" },
    ]);
    expect(paths(result, "dropped")).toEqual([
      path("mounts", 2),
      path("mounts", 3, "type"),
      path("mounts", 4, "group"),
    ]);
    expect(result.diagnostics).toHaveLength(3);
  });
  test("splits negated excludes into includes when app mount is expanded", () => {
    const result = lowerApi4Service(
      {
        "app-mount": { destination: "/app", excludes: ["node_modules", "!node_modules/keep"], type: "copy" },
      },
      ctx,
    );
    expect(result.patch.appMount).toEqual({
      target: "/app",
      excludes: ["node_modules"],
      includes: ["node_modules/keep"],
    });
    expect(paths(result, "dropped")).toEqual([path("app-mount", "type")]);
  });
  test.each([false, "disabled", "off"])("disables appMount when set to %s", (value) => {
    expect(lowerApi4Service({ appMount: value }, ctx).patch.appMount).toBe(false);
  });
  test("lowers six storage forms when persistent storage is present", () => {
    const result = lowerApi4Service(
      {
        "persistent-storage": [
          "/var/lib/data",
          { destination: "/cache", scope: "app" },
          { source: "known", target: "/known" },
          "./a:/b",
          { type: "bind", source: "./c", destination: "/d" },
          { type: "image", destination: "/image" },
        ],
      },
      ctx,
    );
    expect(result.patch.storage).toEqual([
      { store: "var-lib-data", target: "/var/lib/data" },
      { store: "cache", target: "/cache", scope: "app" },
      { store: "known", target: "/known" },
    ]);
    expect(result.patch.mounts).toEqual([
      { source: "./a", target: "/b" },
      { source: "./c", target: "/d" },
    ]);
    expect(paths(result, "dropped")).toEqual([path("persistent-storage", 5)]);
    expect(paths(result, "rewritten")).toEqual([path("persistent-storage")]);
  });
  test("derives endpoints when ports use API-4 shorthand", () => {
    const result = lowerApi4Service({ ports: ["8080/http", "8443/https", "0:80"] }, ctx);
    expect(result.patch.endpoints).toEqual([
      { _tag: "internal", protocol: "http", port: 8080 },
      { _tag: "internal", protocol: "https", port: 8443 },
      { _tag: "published", protocol: "tcp", port: 80, publication: {} },
    ]);
    expect(result.patch.ports ?? []).toEqual([]);
    expect(paths(result, "rewritten")).toEqual([path("ports")]);
  });
  test("converts healthcheck timing and drops its user", () => {
    const result = lowerApi4Service(
      { healthcheck: { command: "true", user: "root", retry: 100, delay: 1000 } },
      ctx,
    );
    expect(result.patch.healthcheck).toEqual({ command: "true", retries: 100, intervalSeconds: 1 });
    expect(paths(result, "dropped")).toEqual([path("healthcheck", "user")]);
  });
  test("canonicalizes CA aliases when cas is supplied", () => {
    const result = lowerApi4Service({ security: { cas: ["./ca.pem"] } }, ctx);
    expect(result.patch.security).toEqual({ ca: ["./ca.pem"] });
    expect(paths(result, "rewritten")).toEqual([path("security", "cas")]);
  });
  test("rejects tagged commands and CA entries without reading references", () => {
    const tagged = { [LEGACY_TAGGED]: true, tag: "!load", value: "./absent" };
    const result = lowerApi4Service(
      { command: tagged, entrypoint: [tagged], security: { ca: ["./ca.pem", tagged] } },
      ctx,
    );
    expect(paths(result, "unsupported")).toEqual([
      path("command"),
      path("entrypoint"),
      path("security", "ca", 1),
    ]);
    expect(result.patch.security).toEqual({ ca: ["./ca.pem"] });
    expect(result.patch.command).toBeUndefined();
    expect(result.blocked).toBe(true);
  });
  test("drops every packages subkey even when false", () => {
    const result = lowerApi4Service({ packages: { git: true, "ssh-agent": true, sudo: false } }, ctx);
    expect(paths(result, "dropped")).toEqual([
      path("packages", "git"),
      path("packages", "ssh-agent"),
      path("packages", "sudo"),
    ]);
    expect(result.diagnostics).toHaveLength(3);
  });
  test("defers scanner even when false", () => {
    const result = lowerApi4Service({ scanner: false }, ctx);
    expect(paths(result, "unsupported")).toEqual([path("scanner")]);
    expect(result.diagnostics[0]?.message.endsWith("has no Lando 4 target yet.")).toBe(true);
  });
  test("preserves ordinary fields and ignores fields owned by other lowerers", () => {
    const result = lowerApi4Service(
      {
        user: "www",
        working_dir: "/app",
        primary: true,
        hostnames: ["app.test"],
        labels: { x: "y" },
        environment: ["A=x=y"],
        volumes: ["data:/data"],
        networks: ["default"],
        certs: { cert: "cert.pem", key: "key.pem" },
        ports: ["8080:80"],
        build: { app: ["echo hi"] },
        tty: true,
        overrides: {},
      },
      ctx,
    );
    expect(result.patch).toEqual({
      type: "lando",
      user: "www",
      workingDirectory: "/app",
      primary: true,
      hostnames: ["app.test"],
      labels: { x: "y" },
      environment: { A: "x=y" },
      volumes: ["data:/data"],
      networks: ["default"],
      certs: { cert: "cert.pem", key: "key.pem" },
      ports: ["8080:80"],
    });
    expect(() => Schema.decodeUnknownSync(ServiceConfig)(result.patch)).not.toThrow();
  });
});
