import { describe, expect, test } from "bun:test";
import { Effect, Result, Schema } from "effect";

import type { LoadedPluginContribution } from "@lando/engine/plugins/contribution-graph";
import { pluginDoctorCheckIndex } from "@lando/engine/plugins/doctor-contributions";
import { PluginManifest } from "@lando/sdk/schema";

const manifest = Schema.decodeSync(PluginManifest)({ name: "@example/doctor", version: "1.0.0", api: 4 });
const node = (module: Readonly<Record<string, unknown>>): LoadedPluginContribution => ({
  source: "user",
  manifest,
  module,
});
const check = { id: "healthy", run: () => Effect.succeed([]) };

describe("doctor contribution projection", () => {
  test("supports direct and descriptor exports without validating unrelated manifest-only capabilities", () => {
    const declared = Schema.decodeSync(PluginManifest)({
      ...manifest,
      contributes: { commands: [{ id: "example:unloaded", summary: "Unloaded command." }] },
    });
    for (const module of [
      { doctorChecks: [check] },
      { plugin: { name: manifest.name, manifest, doctorChecks: [check] } },
    ]) {
      const result = pluginDoctorCheckIndex([{ ...node(module), manifest: declared }]);
      expect(Result.isSuccess(result)).toBe(true);
      if (Result.isSuccess(result)) expect([...result.success.keys()]).toEqual(["healthy"]);
    }
  });

  test("prioritizes the loaded entry descriptor over namespace checks", () => {
    const result = pluginDoctorCheckIndex([
      { ...node({ doctorChecks: null }), entry: { name: manifest.name, manifest, doctorChecks: [check] } },
    ]);
    expect(Result.isSuccess(result)).toBe(true);
    if (Result.isSuccess(result)) expect([...result.success.keys()]).toEqual(["healthy"]);
  });

  test("treats undefined optional checks as absent and prioritizes direct checks", () => {
    const result = pluginDoctorCheckIndex([
      node({ doctorChecks: undefined, plugin: { name: manifest.name, manifest, doctorChecks: [check] } }),
    ]);
    expect(Result.isSuccess(result)).toBe(true);
    if (Result.isSuccess(result)) expect(result.success.size).toBe(1);
    const direct = pluginDoctorCheckIndex([node({ doctorChecks: [check], plugin: { doctorChecks: null } })]);
    expect(Result.isSuccess(direct)).toBe(true);
  });

  test("ignores unrelated descriptor identities when no doctor checks are exported", () => {
    for (const module of [
      { name: "other", manifest: null },
      { plugin: () => "unrelated" },
      { plugin: { name: "other", manifest: null } },
      {
        get name() {
          throw new Error("unrelated identity");
        },
        doctorChecks: undefined,
      },
    ]) {
      const result = pluginDoctorCheckIndex([node(module)]);
      expect(Result.isSuccess(result)).toBe(true);
      if (Result.isSuccess(result)) expect(result.success.size).toBe(0);
    }
  });

  test("rejects malformed checks and exported identities with plugin attribution", () => {
    for (const module of [
      { doctorChecks: null },
      { doctorChecks: {} },
      { doctorChecks: [null] },
      { doctorChecks: [{ ...check, id: " " }] },
      { doctorChecks: [{ ...check, run: "invalid" }] },
      { doctorChecks: [{ ...check, relevant: false }] },
      { name: "@example/other", doctorChecks: [check] },
      { manifest: { name: manifest.name }, doctorChecks: [check] },
      { plugin: { name: "@example/other", manifest, doctorChecks: [check] } },
      { plugin: { doctorChecks: [check] } },
      { doctorChecks: null, plugin: { name: manifest.name, manifest, doctorChecks: [check] } },
    ]) {
      const result = pluginDoctorCheckIndex([node(module)]);
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result))
        expect(result.failure).toMatchObject({
          _tag: "PluginDescriptorMismatchError",
          pluginName: manifest.name,
          kind: "doctorChecks",
        });
    }
  });

  test("fails the complete index on duplicate ids without executing callbacks", () => {
    let ran = false;
    const duplicate = {
      ...check,
      run: () => {
        ran = true;
        return Effect.succeed([]);
      },
    };
    expect(Result.isFailure(pluginDoctorCheckIndex([node({ doctorChecks: [duplicate, duplicate] })]))).toBe(
      true,
    );
    expect(
      Result.isFailure(
        pluginDoctorCheckIndex([
          node({ doctorChecks: [duplicate] }),
          {
            ...node({ doctorChecks: [duplicate] }),
            manifest: Schema.decodeSync(PluginManifest)({ ...manifest, name: "@example/second" }),
          },
        ]),
      ),
    ).toBe(true);
    expect(ran).toBe(false);
  });

  test("snapshots getters once and preserves callback receivers", async () => {
    let reads = 0;
    const descriptor = {
      id: "snapshot",
      get run() {
        reads++;
        if (reads > 1) throw new Error("run reread");
        return function (this: { id: string }) {
          return Effect.succeed([
            { name: this.id, status: "pass" as const, severity: "info" as const, context: {}, solutions: [] },
          ]);
        };
      },
      get relevant() {
        reads++;
        return function (this: { id: string }) {
          return this.id === "snapshot";
        };
      },
    };
    const result = pluginDoctorCheckIndex([node({ doctorChecks: [descriptor] })]);
    expect(Result.isSuccess(result)).toBe(true);
    if (Result.isSuccess(result)) {
      const projected = result.success.get("snapshot");
      expect(projected).toBeDefined();
      if (projected !== undefined) {
        const reports = await Effect.runPromise(projected.run({} as never));
        expect(reports[0]?.name).toBe("snapshot");
        expect(projected.relevant?.({} as never)).toBe(true);
      }
    }
    expect(reads).toBe(2);
  });

  test("does not read plugin-controlled bind properties while snapshotting callbacks", () => {
    let inspected = false;
    const run = () => Effect.succeed([]);
    const relevant = () => true;
    for (const callback of [run, relevant]) {
      Object.defineProperty(callback, "bind", {
        get() {
          inspected = true;
          throw new Error("plugin bind read");
        },
      });
    }
    const result = pluginDoctorCheckIndex([node({ doctorChecks: [{ id: "native-bind", run, relevant }] })]);
    expect(Result.isSuccess(result)).toBe(true);
    expect(inspected).toBe(false);
  });

  test("contains throwing descriptor getters with safe attributed errors", () => {
    const result = pluginDoctorCheckIndex([
      node({
        get doctorChecks() {
          throw new Error("private token");
        },
      }),
    ]);
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure.pluginName).toBe(manifest.name);
      expect(result.failure.message).not.toContain("private token");
    }
  });
});
