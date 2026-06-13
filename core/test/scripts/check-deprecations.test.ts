import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import { describe, expect, test } from "bun:test";

import { checkDeprecationTsdoc } from "../../../scripts/check-deprecations.ts";

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
