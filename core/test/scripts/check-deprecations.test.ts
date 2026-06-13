import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import { checkDeprecationReleaseGate, checkDeprecationTsdoc } from "../../../scripts/check-deprecations.ts";

type DeprecationOffender = Awaited<ReturnType<typeof checkDeprecationTsdoc>>["offenders"][number];

const withFixtureRoot = async (run: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "lando-deprecations-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const write = async (root: string, path: string, content: string): Promise<void> => {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content, "utf8");
};

const repoRoot = resolve(import.meta.dirname, "../../..");

const offenderSummaries = (root: string, offenders: readonly DeprecationOffender[]): string[] =>
  offenders.map(
    (offender) =>
      `${relative(root, offender.file)}:${offender.line}:${offender.exportName}:${offender.reason}`,
  );

describe("deprecation TSDoc lint gate", () => {
  test("passes public deprecated exports with markDeprecated or tagged-error metadata", async () => {
    await withFixtureRoot(async (root) => {
      await write(
        root,
        "sdk/src/public.ts",
        `
          import { Effect } from "effect";
          import { Schema } from "effect";
          import { markDeprecated } from "@lando/sdk/services";
          import type { DeprecationNotice } from "@lando/sdk/schema";
          const notice: DeprecationNotice = { since: "4.2.0", note: "Use newApi instead.", replacement: "newApi" };
          /** @deprecated Deprecated since 4.2.0. Use newApi instead. Use newApi instead. */
          export const oldApi = markDeprecated(notice, "oldApi", () => Effect.succeed("ok"));
          /** @deprecated Deprecated since 4.2.0. Use NewError instead. */
          export class OldError extends Schema.TaggedError<OldError>()("OldError", { message: Schema.String }) {
            static readonly deprecation: DeprecationNotice = { since: "4.2.0", note: "Use NewError instead." };
          }
        `,
      );

      expect(await checkDeprecationTsdoc({ root })).toEqual({ ok: true, offenders: [] });
    });
  });

  test("accepts deprecated exports using an aliased markDeprecated import", async () => {
    await withFixtureRoot(async (root) => {
      await write(
        root,
        "sdk/src/public.ts",
        `
          import { Effect } from "effect";
          import { markDeprecated as md } from "@lando/sdk/services";
          const notice = { since: "4.2.0", note: "Use newApi instead.", replacement: "newApi" };
          /** @deprecated Deprecated since 4.2.0. Use newApi instead. */
          export const oldApi = md(notice, "oldApi", () => Effect.succeed("ok"));
        `,
      );

      expect(await checkDeprecationTsdoc({ root })).toEqual({ ok: true, offenders: [] });
    });
  });

  test("accepts deprecated exports using namespace markDeprecated imports", async () => {
    await withFixtureRoot(async (root) => {
      await write(
        root,
        "sdk/src/public.ts",
        `
          import { Effect } from "effect";
          import * as services from "@lando/sdk/services";
          const notice = { since: "4.2.0", note: "Use newApi instead.", replacement: "newApi" };
          /** @deprecated Deprecated since 4.2.0. Use newApi instead. */
          export const oldApi = services.markDeprecated(notice, "oldApi", () => Effect.succeed("ok"));
        `,
      );

      expect(await checkDeprecationTsdoc({ root })).toEqual({ ok: true, offenders: [] });
    });
  });

  test("accepts deprecated exports using two-argument named function implementations", async () => {
    await withFixtureRoot(async (root) => {
      await write(
        root,
        "sdk/src/public.ts",
        `
          import { Effect } from "effect";
          import { markDeprecated } from "@lando/sdk/services";
          const notice = { since: "4.2.0", note: "Use newApi instead.", replacement: "newApi" };
          /** @deprecated Deprecated since 4.2.0. Use newApi instead. */
          export const oldApi = markDeprecated(notice, function oldApi() {
            return Effect.succeed("ok");
          });
        `,
      );

      expect(await checkDeprecationTsdoc({ root })).toEqual({ ok: true, offenders: [] });
    });
  });

  test("rejects explicit markDeprecated ids without implementation arguments", async () => {
    await withFixtureRoot(async (root) => {
      await write(
        root,
        "sdk/src/public.ts",
        `
          import { markDeprecated } from "@lando/sdk/services";
          const notice = { since: "4.2.0", note: "Use newApi instead.", replacement: "newApi" };
          /** @deprecated Deprecated since 4.2.0. Use newApi instead. */
          export const oldApi = markDeprecated(notice, "oldApi");
        `,
      );

      const result = await checkDeprecationTsdoc({ root });

      expect(result.ok).toBe(false);
      expect(offenderSummaries(root, result.offenders)).toEqual([
        "sdk/src/public.ts:5:oldApi:markDeprecated export id must match exported name",
      ]);
    });
  });

  test("rejects deprecated exports using unrelated property-access calls", async () => {
    await withFixtureRoot(async (root) => {
      await write(
        root,
        "sdk/src/public.ts",
        `
          const fake = {
            markDeprecated: (_notice: unknown, _id: string, impl: () => string) => impl,
          };
          /** @deprecated Deprecated since 4.2.0. Use newApi instead. */
          export const oldApi = fake.markDeprecated({ since: "4.2.0", note: "Use newApi instead." }, "oldApi", () => "ok");
        `,
      );

      const result = await checkDeprecationTsdoc({ root });

      expect(result.ok).toBe(false);
      expect(offenderSummaries(root, result.offenders)).toEqual([
        "sdk/src/public.ts:6:oldApi:missing markDeprecated(notice, impl) wrapper",
      ]);
    });
  });

  test("rejects deprecated exports using an unrelated local call", async () => {
    await withFixtureRoot(async (root) => {
      await write(
        root,
        "sdk/src/public.ts",
        `
          const md = (_notice: unknown, _id: string, impl: () => string) => impl;
          function markDeprecated(_notice: unknown, _id: string, impl: () => string) {
            return impl;
          }
          /** @deprecated Deprecated since 4.2.0. Use newApi instead. */
          export const oldApi = md({ since: "4.2.0", note: "Use newApi instead." }, "oldApi", () => "ok");
          /** @deprecated Deprecated since 4.2.0. Use newerApi instead. */
          export const olderApi = markDeprecated({ since: "4.2.0", note: "Use newerApi instead." }, "olderApi", () => "ok");
        `,
      );

      const result = await checkDeprecationTsdoc({ root });

      expect(result.ok).toBe(false);
      expect(offenderSummaries(root, result.offenders)).toEqual([
        "sdk/src/public.ts:7:oldApi:missing markDeprecated(notice, impl) wrapper",
        "sdk/src/public.ts:9:olderApi:missing markDeprecated(notice, impl) wrapper",
      ]);
    });
  });

  test("fails public deprecated exports without runtime metadata", async () => {
    await withFixtureRoot(async (root) => {
      await write(
        root,
        "sdk/src/public.ts",
        `
          /** @deprecated Deprecated since 4.2.0. Use newApi instead. */
          export const oldApi = () => "ok";
          /** @deprecated Deprecated since 4.2.0. Use NewError instead. */
          export class OldError extends Error {}
        `,
      );

      const result = await checkDeprecationTsdoc({ root });

      expect(result.ok).toBe(false);
      expect(offenderSummaries(root, result.offenders)).toEqual([
        "sdk/src/public.ts:3:oldApi:missing markDeprecated(notice, impl) wrapper",
        "sdk/src/public.ts:5:OldError:missing static readonly deprecation metadata",
      ]);
    });
  });

  test("rejects non-tagged classes and stale TSDoc text", async () => {
    await withFixtureRoot(async (root) => {
      await write(
        root,
        "sdk/src/public.ts",
        `
          import { Effect } from "effect";
          import { markDeprecated } from "@lando/sdk/services";
          import type { DeprecationNotice } from "@lando/sdk/schema";
          /** @deprecated Deprecated since 4.2.0. Use oldApi instead. */
          export const oldApi = markDeprecated({ since: "4.2.0", note: "Use newApi instead.", replacement: "newApi" }, "oldApi", () => Effect.succeed("ok"));
          /** @deprecated Deprecated since 4.2.0. Use NewThing instead. */
          export class OldThing {
            static readonly deprecation: DeprecationNotice = { since: "4.2.0", note: "Use NewThing instead." };
          }
        `,
      );

      const result = await checkDeprecationTsdoc({ root });

      expect(result.ok).toBe(false);
      expect(offenderSummaries(root, result.offenders)).toEqual([
        "sdk/src/public.ts:6:oldApi:@deprecated text must include DeprecationNotice note/replacement",
        "sdk/src/public.ts:8:OldThing:static readonly deprecation metadata is only accepted on tagged errors",
      ]);
    });
  });

  test("checks deprecated named export declarations against local runtime metadata", async () => {
    await withFixtureRoot(async (root) => {
      await write(
        root,
        "sdk/src/public.ts",
        `
          import { Effect } from "effect";
          import { markDeprecated } from "@lando/sdk/services";
          const goodNotice = { since: "4.2.0", note: "Use newApi instead.", replacement: "newApi" };
          const oldApi = markDeprecated(goodNotice, "oldApi", () => Effect.succeed("ok"));
          const missingRuntime = () => Effect.succeed("ok");
          /** @deprecated Deprecated since 4.2.0. Use newApi instead. */
          export { oldApi };
          /** @deprecated Deprecated since 4.2.0. Use missingRuntimeReplacement instead. */
          export { missingRuntime };
        `,
      );

      const result = await checkDeprecationTsdoc({ root });

      expect(result.ok).toBe(false);
      expect(offenderSummaries(root, result.offenders)).toEqual([
        "sdk/src/public.ts:10:missingRuntime:missing markDeprecated(notice, impl) wrapper",
      ]);
    });
  });

  test("flags a deprecated local declaration exported via an untagged named export", async () => {
    await withFixtureRoot(async (root) => {
      await write(
        root,
        "sdk/src/public.ts",
        `
          import { Effect } from "effect";
          /** @deprecated Deprecated since 4.2.0. Use newApi instead. */
          const oldApi = () => Effect.succeed("ok");
          export { oldApi };
        `,
      );

      const result = await checkDeprecationTsdoc({ root });

      expect(result.ok).toBe(false);
      expect(offenderSummaries(root, result.offenders)).toEqual([
        "sdk/src/public.ts:5:oldApi:missing markDeprecated(notice, impl) wrapper",
      ]);
    });
  });

  test("flags a deprecated local function exported via an untagged named export", async () => {
    await withFixtureRoot(async (root) => {
      await write(
        root,
        "sdk/src/public.ts",
        `
          import { Effect } from "effect";
          /** @deprecated Deprecated since 4.2.0. Use newApi instead. */
          function oldApi() {
            return Effect.succeed("ok");
          }
          export { oldApi };
        `,
      );

      const result = await checkDeprecationTsdoc({ root });

      expect(result.ok).toBe(false);
      expect(offenderSummaries(root, result.offenders)).toEqual([
        "sdk/src/public.ts:7:oldApi:missing markDeprecated(notice, impl) wrapper",
      ]);
    });
  });

  test("ignores deprecated type-only named exports", async () => {
    await withFixtureRoot(async (root) => {
      await write(
        root,
        "sdk/src/public.ts",
        `
          interface InternalShape {
            readonly name: string;
          }
          type InternalAlias = {
            readonly id: string;
          };
          /** @deprecated Deprecated since 4.2.0. Use NewShape instead. */
          export type { InternalShape as OldShape };
          /** @deprecated Deprecated since 4.2.0. Use NewAlias instead. */
          export { type InternalAlias as OldAlias };
          /** @deprecated Deprecated since 4.2.0. Use NewInline instead. */
          interface OldInline {
            readonly enabled: boolean;
          }
          /** @deprecated Deprecated since 4.2.0. Use NewNamed instead. */
          type OldNamed = {
            readonly value: string;
          };
          export { OldInline, OldNamed };
        `,
      );

      expect(await checkDeprecationTsdoc({ root })).toEqual({ ok: true, offenders: [] });
    });
  });

  test("still flags deprecated runtime named exports without markDeprecated", async () => {
    await withFixtureRoot(async (root) => {
      await write(
        root,
        "sdk/src/public.ts",
        `
          const oldApi = () => "ok";
          /** @deprecated Deprecated since 4.2.0. Use newApi instead. */
          export { oldApi };
        `,
      );

      const result = await checkDeprecationTsdoc({ root });

      expect(result.ok).toBe(false);
      expect(offenderSummaries(root, result.offenders)).toEqual([
        "sdk/src/public.ts:4:oldApi:missing markDeprecated(notice, impl) wrapper",
      ]);
    });
  });

  test("requires markDeprecated explicit ids for anonymous exported implementations", async () => {
    await withFixtureRoot(async (root) => {
      await write(
        root,
        "sdk/src/public.ts",
        `
          import { Effect } from "effect";
          import { markDeprecated } from "@lando/sdk/services";
          /** @deprecated Deprecated since 4.2.0. Use newApi instead. */
          export const oldApi = markDeprecated({ since: "4.2.0", note: "Use newApi instead." }, () => Effect.succeed("ok"));
        `,
      );

      const result = await checkDeprecationTsdoc({ root });

      expect(result.ok).toBe(false);
      expect(offenderSummaries(root, result.offenders)).toEqual([
        "sdk/src/public.ts:5:oldApi:markDeprecated export id must match exported name",
      ]);
    });
  });

  test("ignores deprecated external named re-exports without local bindings", async () => {
    await withFixtureRoot(async (root) => {
      await write(
        root,
        "sdk/src/public.ts",
        `
          /** @deprecated Deprecated since 4.2.0. Use newApi instead. */
          export { oldApi } from "./internal.ts";
        `,
      );

      expect(await checkDeprecationTsdoc({ root })).toEqual({ ok: true, offenders: [] });
    });
  });
});

describe("deprecation release gate", () => {
  test("is wired into codegen:check after codegen and before typecheck", async () => {
    const packageJson = await Bun.file(resolve(repoRoot, "package.json")).json();

    expect(packageJson.scripts["codegen:check"]).toBe(
      "bun run codegen && bun run check:deprecations && bun run typecheck",
    );
  });

  test("passes current notices with released or pending since versions", async () => {
    await withFixtureRoot(async (root) => {
      await write(
        root,
        "sdk/src/public.ts",
        `
          import { Effect } from "effect";
          import { markDeprecated } from "@lando/sdk/services";
          const notice = { since: "4.2.0", removeIn: "5.0.0", note: "Use newApi instead.", replacement: "newApi" };
          /** @deprecated Deprecated since 4.2.0; remove in 5.0.0. Use newApi instead. */
          export const oldApi = markDeprecated(notice, "oldApi", () => Effect.succeed("ok"));
        `,
      );

      expect(
        await checkDeprecationReleaseGate({
          root,
          targetRelease: "4.2.0",
          today: new Date("2026-06-01T00:00:00Z"),
        }),
      ).toEqual({ ok: true, offenders: [] });
    });
  });

  test("uses package version as the release target when no explicit release env is set", async () => {
    await withFixtureRoot(async (root) => {
      await write(root, "package.json", JSON.stringify({ version: "5.0.0" }));
      await write(
        root,
        "sdk/src/public.ts",
        `
          import { Effect } from "effect";
          import { markDeprecated } from "@lando/sdk/services";
          const notice = { since: "4.2.0", removeIn: "5.0.0", note: "Use newApi instead.", replacement: "newApi" };
          /** @deprecated Deprecated since 4.2.0; remove in 5.0.0. Use newApi instead. */
          export const oldApi = markDeprecated(notice, "oldApi", () => Effect.succeed("ok"));
        `,
      );

      const result = await checkDeprecationReleaseGate({ root, env: {} });

      expect(result.ok).toBe(false);
      expect(offenderSummaries(root, result.offenders)).toEqual([
        "sdk/src/public.ts:6:oldApi:DeprecationStaleError: surface is still present at removeIn 5.0.0",
      ]);
    });
  });

  test("uses the release env version before package metadata and normalizes prereleases", async () => {
    await withFixtureRoot(async (root) => {
      await write(root, "package.json", JSON.stringify({ version: "4.0.0" }));
      await write(
        root,
        "sdk/src/public.ts",
        `
          import { Effect } from "effect";
          import { markDeprecated } from "@lando/sdk/services";
          const notice = { since: "4.2.0", removeIn: "5.0.0", note: "Use newApi instead.", replacement: "newApi" };
          /** @deprecated Deprecated since 4.2.0; remove in 5.0.0. Use newApi instead. */
          export const oldApi = markDeprecated(notice, "oldApi", () => Effect.succeed("ok"));
        `,
      );

      const result = await checkDeprecationReleaseGate({
        root,
        env: { LANDO_NPM_VERSION: "5.0.0-beta.1" },
      });

      expect(result.ok).toBe(false);
      expect(offenderSummaries(root, result.offenders)).toEqual([
        "sdk/src/public.ts:6:oldApi:DeprecationStaleError: surface is still present at removeIn 5.0.0",
      ]);
    });
  });

  test("fails notices whose since version is not released or pending", async () => {
    await withFixtureRoot(async (root) => {
      await write(
        root,
        "sdk/src/public.ts",
        `
          import { Effect } from "effect";
          import { markDeprecated } from "@lando/sdk/services";
          const notice = { since: "4.99.0", removeIn: "5.0.0", note: "Use newApi instead." };
          /** @deprecated Deprecated since 4.99.0. Use newApi instead. */
          export const oldApi = markDeprecated(notice, "oldApi", () => Effect.succeed("ok"));
        `,
      );

      const result = await checkDeprecationReleaseGate({ root, releasedOrPending: ["4.2.0"] });

      expect(result.ok).toBe(false);
      expect(offenderSummaries(root, result.offenders)).toEqual([
        "sdk/src/public.ts:6:oldApi:since must match a released or pending semver",
      ]);
    });
  });

  test("requires removeIn for notices older than twelve months", async () => {
    await withFixtureRoot(async (root) => {
      await write(
        root,
        "sdk/src/public.ts",
        `
          import { Effect } from "effect";
          import { markDeprecated } from "@lando/sdk/services";
          const notice = { since: "4.1.0", note: "Use newApi instead." };
          /** @deprecated Deprecated since 4.1.0. Use newApi instead. */
          export const oldApi = markDeprecated(notice, "oldApi", () => Effect.succeed("ok"));
        `,
      );

      const result = await checkDeprecationReleaseGate({
        root,
        releasedOrPending: ["4.1.0", "4.2.0"],
        today: new Date("2026-06-01T00:00:00Z"),
      });

      expect(result.ok).toBe(false);
      expect(offenderSummaries(root, result.offenders)).toEqual([
        "sdk/src/public.ts:6:oldApi:removeIn is required for notices older than 12 months",
      ]);
    });
  });

  test("rejects removeIn values that are not future major or minor releases", async () => {
    await withFixtureRoot(async (root) => {
      await write(
        root,
        "sdk/src/public.ts",
        `
          import { Effect } from "effect";
          import { markDeprecated } from "@lando/sdk/services";
          const patchNotice = { since: "4.2.0", removeIn: "4.2.1", note: "Use newApi instead." };
          const sameNotice = { since: "4.2.0", removeIn: "4.2.0", note: "Use sameApi instead." };
          /** @deprecated Deprecated since 4.2.0. Use newApi instead. */
          export const patchApi = markDeprecated(patchNotice, "patchApi", () => Effect.succeed("ok"));
          /** @deprecated Deprecated since 4.2.0. Use sameApi instead. */
          export const sameApi = markDeprecated(sameNotice, "sameApi", () => Effect.succeed("ok"));
        `,
      );

      const result = await checkDeprecationReleaseGate({
        root,
        releasedOrPending: ["4.2.0", "4.2.1"],
        targetRelease: "4.2.0",
      });

      expect(result.ok).toBe(false);
      expect(offenderSummaries(root, result.offenders)).toEqual([
        "sdk/src/public.ts:7:patchApi:removeIn must be a future major or minor release",
        "sdk/src/public.ts:9:sameApi:removeIn must be a future major or minor release",
        "sdk/src/public.ts:9:sameApi:DeprecationStaleError: surface is still present at removeIn 4.2.0",
      ]);
    });
  });

  test("enforces stale registry notices that are not markDeprecated exports", async () => {
    await withFixtureRoot(async (root) => {
      await write(
        root,
        "plugins/plugin-example/src/index.ts",
        `
          export const manifest = {
            name: "@lando/plugin-example",
            contributes: {
              commands: [
                { id: "example:old", deprecated: { since: "4.2.0", removeIn: "5.0.0", note: "Use example:new." } },
              ],
            },
          };
        `,
      );

      const result = await checkDeprecationReleaseGate({
        root,
        releasedOrPending: ["4.2.0", "5.0.0"],
        targetRelease: "5.0.0",
      });

      expect(result.ok).toBe(false);
      expect(offenderSummaries(root, result.offenders)).toEqual([
        "plugins/plugin-example/src/index.ts:6:example:old:DeprecationStaleError: surface is still present at removeIn 5.0.0",
      ]);
    });
  });

  test("rejects patch, same-release, and past removeIn schedules", async () => {
    await withFixtureRoot(async (root) => {
      await write(
        root,
        "core/src/deprecated-contracts.ts",
        `
          export const surfaces = [
            { id: "patch", deprecated: { since: "4.2.0", removeIn: "4.2.1", note: "Use newer surface." } },
            { id: "same", deprecated: { since: "4.2.0", removeIn: "4.2.0", note: "Use newer surface." } },
            { id: "past", deprecated: { since: "4.2.0", removeIn: "4.1.0", note: "Use newer surface." } },
          ];
        `,
      );

      const result = await checkDeprecationReleaseGate({
        root,
        releasedOrPending: ["4.1.0", "4.2.0"],
        targetRelease: "4.2.0",
      });

      expect(result.ok).toBe(false);
      expect(offenderSummaries(root, result.offenders)).toEqual([
        "core/src/deprecated-contracts.ts:3:patch:removeIn must be a future major or minor release",
        "core/src/deprecated-contracts.ts:4:same:removeIn must be a future major or minor release",
        "core/src/deprecated-contracts.ts:4:same:DeprecationStaleError: surface is still present at removeIn 4.2.0",
        "core/src/deprecated-contracts.ts:5:past:removeIn must be a future major or minor release",
        "core/src/deprecated-contracts.ts:5:past:DeprecationOverdueError: surface is still present after removeIn 4.1.0",
      ]);
    });
  });

  test("checks registry-style deprecated contract surfaces that are not exports", async () => {
    await withFixtureRoot(async (root) => {
      await write(
        root,
        "core/src/deprecation/built-in-contracts.ts",
        `
          export const BUILT_IN_CONTRACT_DEPRECATIONS = {
            commands: [
              { id: "meta:old", deprecated: { since: "4.1.0", removeIn: "5.0.0", note: "Use meta:new." } },
            ],
          };
        `,
      );

      const result = await checkDeprecationReleaseGate({
        root,
        releasedOrPending: ["4.1.0", "5.0.0"],
        targetRelease: "5.0.0",
      });

      expect(result.ok).toBe(false);
      expect(offenderSummaries(root, result.offenders)).toEqual([
        "core/src/deprecation/built-in-contracts.ts:4:meta:old:DeprecationStaleError: surface is still present at removeIn 5.0.0",
      ]);
    });
  });

  test("fails present surfaces at and after removeIn with stale and overdue errors", async () => {
    await withFixtureRoot(async (root) => {
      await write(
        root,
        "sdk/src/public.ts",
        `
          import { Effect } from "effect";
          import { markDeprecated } from "@lando/sdk/services";
          const staleNotice = { since: "4.1.0", removeIn: "5.0.0", note: "Use newApi instead." };
          const overdueNotice = { since: "4.1.0", removeIn: "4.2.0", note: "Use newerApi instead." };
          /** @deprecated Deprecated since 4.1.0; remove in 5.0.0. Use newApi instead. */
          export const staleApi = markDeprecated(staleNotice, "staleApi", () => Effect.succeed("ok"));
          /** @deprecated Deprecated since 4.1.0; remove in 4.2.0. Use newerApi instead. */
          export const overdueApi = markDeprecated(overdueNotice, "overdueApi", () => Effect.succeed("ok"));
        `,
      );

      const result = await checkDeprecationReleaseGate({
        root,
        releasedOrPending: ["4.1.0", "4.2.0", "5.0.0", "5.1.0"],
        targetRelease: "5.0.0",
      });

      expect(result.ok).toBe(false);
      expect(offenderSummaries(root, result.offenders)).toEqual([
        "sdk/src/public.ts:7:staleApi:DeprecationStaleError: surface is still present at removeIn 5.0.0",
        "sdk/src/public.ts:9:overdueApi:DeprecationOverdueError: surface is still present after removeIn 4.2.0",
      ]);
    });
  });
});
