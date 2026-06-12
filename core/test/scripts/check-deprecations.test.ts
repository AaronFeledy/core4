import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import { describe, expect, test } from "bun:test";

import { checkDeprecationTsdoc } from "../../../scripts/check-deprecations.ts";

const makeFixtureRoot = async (): Promise<string> => mkdtemp(join(tmpdir(), "lando-deprecations-"));

const write = async (root: string, path: string, content: string): Promise<void> => {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content, "utf8");
};

describe("deprecation TSDoc lint gate", () => {
  test("passes public deprecated exports with markDeprecated or tagged-error metadata", async () => {
    const root = await makeFixtureRoot();
    try {
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
          export const oldApi = markDeprecated(notice, () => Effect.succeed("ok"));
          /** @deprecated Deprecated since 4.2.0. Use NewError instead. */
          export class OldError extends Schema.TaggedError<OldError>()("OldError", { message: Schema.String }) {
            static readonly deprecation: DeprecationNotice = { since: "4.2.0", note: "Use NewError instead." };
          }
        `,
      );

      expect(await checkDeprecationTsdoc({ root })).toEqual({ ok: true, offenders: [] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("fails public deprecated exports without runtime metadata", async () => {
    const root = await makeFixtureRoot();
    try {
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
      expect(
        result.offenders.map(
          (offender) =>
            `${relative(root, offender.file)}:${offender.line}:${offender.exportName}:${offender.reason}`,
        ),
      ).toEqual([
        "sdk/src/public.ts:3:oldApi:missing markDeprecated(notice, impl) wrapper",
        "sdk/src/public.ts:5:OldError:missing static readonly deprecation metadata",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects non-tagged classes and stale TSDoc text", async () => {
    const root = await makeFixtureRoot();
    try {
      await write(
        root,
        "sdk/src/public.ts",
        `
          import { Effect } from "effect";
          import { markDeprecated } from "@lando/sdk/services";
          import type { DeprecationNotice } from "@lando/sdk/schema";
          /** @deprecated Deprecated since 4.2.0. Use oldApi instead. */
          export const oldApi = markDeprecated({ since: "4.2.0", note: "Use newApi instead.", replacement: "newApi" }, () => Effect.succeed("ok"));
          /** @deprecated Deprecated since 4.2.0. Use NewThing instead. */
          export class OldThing {
            static readonly deprecation: DeprecationNotice = { since: "4.2.0", note: "Use NewThing instead." };
          }
        `,
      );

      const result = await checkDeprecationTsdoc({ root });

      expect(result.ok).toBe(false);
      expect(
        result.offenders.map(
          (offender) =>
            `${relative(root, offender.file)}:${offender.line}:${offender.exportName}:${offender.reason}`,
        ),
      ).toEqual([
        "sdk/src/public.ts:6:oldApi:@deprecated text must include DeprecationNotice note/replacement",
        "sdk/src/public.ts:8:OldThing:static readonly deprecation metadata is only accepted on tagged errors",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("checks deprecated named export declarations against local runtime metadata", async () => {
    const root = await makeFixtureRoot();
    try {
      await write(
        root,
        "sdk/src/public.ts",
        `
          import { Effect } from "effect";
          import { markDeprecated } from "@lando/sdk/services";
          const goodNotice = { since: "4.2.0", note: "Use newApi instead.", replacement: "newApi" };
          const oldApi = markDeprecated(goodNotice, () => Effect.succeed("ok"));
          const missingRuntime = () => Effect.succeed("ok");
          /** @deprecated Deprecated since 4.2.0. Use newApi instead. */
          export { oldApi };
          /** @deprecated Deprecated since 4.2.0. Use missingRuntimeReplacement instead. */
          export { missingRuntime };
        `,
      );

      const result = await checkDeprecationTsdoc({ root });

      expect(result.ok).toBe(false);
      expect(
        result.offenders.map(
          (offender) =>
            `${relative(root, offender.file)}:${offender.line}:${offender.exportName}:${offender.reason}`,
        ),
      ).toEqual(["sdk/src/public.ts:10:missingRuntime:missing markDeprecated(notice, impl) wrapper"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("flags a deprecated local declaration exported via an untagged named export", async () => {
    const root = await makeFixtureRoot();
    try {
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
      expect(
        result.offenders.map(
          (offender) =>
            `${relative(root, offender.file)}:${offender.line}:${offender.exportName}:${offender.reason}`,
        ),
      ).toEqual(["sdk/src/public.ts:5:oldApi:missing markDeprecated(notice, impl) wrapper"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
