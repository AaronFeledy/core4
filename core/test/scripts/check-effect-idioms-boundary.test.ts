import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import { describe, expect, test } from "bun:test";

import { effectIdiomsRule } from "../../../scripts/boundary/rules/effect-idioms.ts";
import { checkEffectIdiomsBoundary } from "../../../scripts/check-effect-idioms-boundary.ts";

const write = async (root: string, path: string, content: string): Promise<void> => {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content, "utf8");
};

const wrapperMatch = "Named wrapper only returns Effect.gen; use Effect.fn or Effect.fnUntraced";
const importMatch = "Import @effect/platform; use effect subpaths";
const failingFixtures = [
  ...[
    "promise.catch(() => null)",
    "promise?.catch(() => (null))",
    "promise.catch(() => { return null; })",
  ].map(
    (code) =>
      [
        `null-swallow-${code.length}`,
        `const promise = Promise.resolve();\n${code};`,
        "Zero-argument .catch returns null; narrow expected failures and propagate the rest",
      ] as const,
  ),
  [
    "data-tagged",
    'import { Data } from "effect";\nclass Bad extends Data.TaggedError("Bad") {}',
    "Data.TaggedError; use Schema.TaggedError",
  ],
  [
    "data-error",
    'import { Data } from "effect";\nconst bad = new Data.Error({});',
    "Data.Error; use Schema.TaggedError",
  ],
  [
    "data-namespace",
    'import * as D from "effect/Data";\nconst bad = D.TaggedError("Bad");',
    "Data.TaggedError; use Schema.TaggedError",
  ],
  [
    "data-alias",
    'import { Data as D } from "effect";\nconst bad = D.Error;',
    "Data.Error; use Schema.TaggedError",
  ],
  [
    "data-named",
    'import { TaggedError as T } from "effect/Data";\nconst bad = T("Bad");',
    "Data.TaggedError; use Schema.TaggedError",
  ],
  [
    "data-named-error",
    'import { Error as E } from "effect/Data";\nconst bad = new E({});',
    "Data.Error; use Schema.TaggedError",
  ],
  [
    "date-now",
    'import { Effect } from "effect";\nconst time = Date.now();',
    "Date.now(); use Clock.currentTimeMillis",
  ],
  [
    "date-new",
    'import * as Clock from "effect/Clock";\nconst time = new Date(0);',
    "new Date; use DateTime in Effect modules",
  ],
  [
    "date-type-import",
    'import type { Effect } from "effect";\nconst time = Date.now();',
    "Date.now(); use Clock.currentTimeMillis",
  ],
  [
    "date-type-subpath",
    'import type { DateTime } from "effect/DateTime";\nconst time = new Date();',
    "new Date; use DateTime in Effect modules",
  ],
  [
    "date-side-effect",
    'import "effect";\nconst time = Date.now();',
    "Date.now(); use Clock.currentTimeMillis",
  ],
  [
    "gen-function",
    'import { Effect } from "effect";\nfunction work() { return Effect.gen(function* () {}); }',
    wrapperMatch,
  ],
  [
    "gen-arrow",
    'import { Effect } from "effect";\nconst work = () => Effect.gen(function* () {});',
    wrapperMatch,
  ],
  [
    "gen-block-arrow",
    'import { Effect } from "effect";\nconst work = () => { return Effect.gen(function* () {}); };',
    wrapperMatch,
  ],
  [
    "gen-function-expression",
    'import { Effect } from "effect";\nconst work = function () { return Effect.gen(function* () {}); };',
    wrapperMatch,
  ],
  [
    "gen-class-method",
    'import { Effect } from "effect";\nclass Worker { work() { return Effect.gen(function* () {}); } }',
    wrapperMatch,
  ],
  [
    "gen-object-method",
    'import { Effect } from "effect";\nconst worker = { work() { return Effect.gen(function* () {}); } };',
    wrapperMatch,
  ],
  [
    "gen-class-property",
    'import { Effect } from "effect";\nclass Worker { work = () => Effect.gen(function* () {}); }',
    wrapperMatch,
  ],
  [
    "gen-object-property",
    'import { Effect } from "effect";\nconst worker = { work: () => Effect.gen(function* () {}) };',
    wrapperMatch,
  ],
  [
    "gen-namespace-alias",
    'import * as E from "effect/Effect";\nconst work = () => E.gen(function* () {});',
    wrapperMatch,
  ],
  [
    "gen-named-alias",
    'import { Effect as Fx } from "effect";\nconst work = () => Fx.gen(function* () {});',
    wrapperMatch,
  ],
  [
    "gen-parentheses",
    'import { Effect } from "effect";\nconst work = () => ((Effect.gen(function* () {})));',
    wrapperMatch,
  ],
  [
    "gen-as",
    'import { Effect } from "effect";\nconst work = () => (Effect.gen(function* () {}) as unknown);',
    wrapperMatch,
  ],
  [
    "gen-satisfies",
    'import { Effect } from "effect";\nconst work = () => (Effect.gen(function* () {}) satisfies unknown);',
    wrapperMatch,
  ],
  ["guard-variable", "\nconst isRecord = (x) => true;", "Local isRecord definition; use Predicate.isObject"],
  [
    "guard-function",
    "\nfunction isPlainObject(x) { return true; }",
    "Local isPlainObject definition; use Predicate.isObject",
  ],
  ["guard-class", "\nclass isObject {}", "Local isObject definition; use Predicate.isObject"],
  [
    "guard-export",
    'import { Predicate } from "effect";\nexport const isRecord = Predicate.isObject;',
    "Local isRecord definition; use Predicate.isObject",
  ],
  [
    "guard-destructure",
    'import { Predicate } from "effect";\nconst { isObject } = Predicate;',
    "Local isObject definition; use Predicate.isObject",
  ],
  [
    "guard-nested-destructure",
    "\nconst { nested: [isPlainObject] } = value;",
    "Local isPlainObject definition; use Predicate.isObject",
  ],
  ["guard-type", "\ntype isRecord = object;", "Local isRecord definition; use Predicate.isObject"],
  ["live-const", "\nexport const FooLive = 1;", "Export FooLive; use layer or layer<Variant>"],
  ["live-let", "\nexport let FooLive = 1;", "Export FooLive; use layer or layer<Variant>"],
  ["live-function", "\nexport function makeFooLive() {}", "Export makeFooLive; use layer or layer<Variant>"],
  ["live-class", "\nexport class FooLive {}", "Export FooLive; use layer or layer<Variant>"],
  ["live-alias", "const x = 1;\nexport { x as FooLive };", "Export FooLive; use layer or layer<Variant>"],
  ["live-export", "const FooLive = 1;\nexport { FooLive };", "Export FooLive; use layer or layer<Variant>"],
  ["live-reexport", '\nexport { x as FooLive } from "./x";', "Export FooLive; use layer or layer<Variant>"],
  ["effect-import", '\nimport { X } from "@effect/platform";', importMatch],
  ["effect-type-import", '\nimport type { X } from "@effect/platform";', importMatch],
  ["effect-dynamic-import", '\nconst x = import("@effect/platform");', importMatch],
  ["effect-reexport", '\nexport { X } from "@effect/platform";', importMatch],
  ["effect-star-reexport", '\nexport * from "@effect/platform";', importMatch],
  [
    "cause-combine",
    'import { Cause } from "effect";\nCause.combine(a, b);',
    "Cause.combine; use role-aware failure helpers",
  ],
  [
    "cause-reasons",
    'import * as C from "effect/Cause";\nC.fromReasons([]);',
    "Cause.fromReasons; use role-aware failure helpers",
  ],
  [
    "cause-alias",
    'import { combine as merge } from "effect/Cause";\nmerge(a, b);',
    "Cause.combine; use role-aware failure helpers",
  ],
  [
    "cause-destructure",
    'import { Cause } from "effect";\nconst { combine } = Cause;\ncombine(a, b);',
    "Cause.combine; use role-aware failure helpers",
  ],
  [
    "cause-destructure-rename",
    'import * as C from "effect/Cause";\nconst { fromReasons: build } = C;\nbuild([]);',
    "Cause.fromReasons; use role-aware failure helpers",
  ],
  [
    "data-destructure",
    'import { Data } from "effect";\nconst { TaggedError } = Data;\nclass X extends TaggedError("X") {}',
    "Data.TaggedError; use Schema.TaggedError",
  ],
] as const;

describe("effect idioms boundary lint gate", () => {
  test("rejects error mapping forms in every shipped source root and accepts SDK helpers", async () => {
    const root = await mkdtemp(join(tmpdir(), "lando-provider-mapping-"));
    const prefixes = [
      "container-runtime/src",
      "sdk/src",
      "sdk/src/test",
      "core/src",
      "engine/src/operations",
      "landofile/src",
      "plugins/proxy-traefik/src",
      "plugins/sql/src",
    ];
    const forms = [
      'import { Effect } from "effect";\nEffect.mapError(value, f);',
      'import { Effect } from "effect";\nvalue.pipe(Effect.mapError(f));',
      'import { Stream } from "effect";\nStream.mapError(value, f);',
      'import { Stream } from "effect";\nvalue.pipe(Stream.mapError(f));',
      'import * as Fx from "effect/Effect";\nconst mapper = Fx.mapError;',
      'import * as S from "effect/Stream";\nconst mapper = S.mapError;',
      'import { mapError as map } from "effect/Effect";\nmap(value, f);',
      'import { mapError } from "effect/Stream";\nmapError(f);',
      'import { Effect } from "effect";\nconst { mapError } = Effect; mapError(value, f);',
      'import { Stream } from "effect";\nconst { mapError: map } = Stream; map(value, f);',
    ];
    try {
      for (const prefix of prefixes) {
        for (const [index, code] of forms.entries()) await write(root, `${prefix}/banned-${index}.ts`, code);
        await write(
          root,
          `${prefix}/supported.ts`,
          'import { mapFailures, mapStreamFailures } from "@lando/sdk/command-result";\nmapFailures(value, f); stream.pipe(mapStreamFailures(f));',
        );
      }
      for (const [index, code] of forms.entries()) await write(root, `scripts/allowed-${index}.ts`, code);
      await write(
        root,
        "sdk/src/other-idioms.ts",
        'import { Data } from "effect";\nData.Error(); Date.now();',
      );
      await write(
        root,
        "container-runtime/src/other-idioms.ts",
        'import { Cause, Data, Effect } from "effect";\nData.Error(); Cause.combine(a, b); Date.now(); const work = () => Effect.gen(function* () {}); export const FooLive = {}; promise.catch(() => null);',
      );

      const result = await checkEffectIdiomsBoundary({ root });

      expect(result.ok).toBe(false);
      expect(
        result.offenders
          .map((offender) => ({
            file: relative(root, offender.file).replaceAll("\\", "/"),
            line: offender.line,
            match: offender.match,
          }))
          .sort((a, b) => a.file.localeCompare(b.file)),
      ).toEqual(
        prefixes
          .flatMap((prefix) =>
            forms.map((_, index) => ({
              file: `${prefix}/banned-${index}.ts`,
              line: 2,
              match:
                "Use mapFailures/mapStreamFailures from @lando/sdk/command-result: Effect 4 mapError keeps only the first failure and drops cleanup reasons, defects, and interrupts.",
            })),
          )
          .sort((a, b) => a.file.localeCompare(b.file)),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("keeps the public gate messages stable", () => {
    expect(effectIdiomsRule.passMessage).toBe("Effect idioms boundary check passed.");
    expect(effectIdiomsRule.failureHeadline).toBe(
      "Effect idioms boundary check failed. Use Schema errors, Clock/DateTime, Effect.fn, Predicate.isObject, layer exports, and effect subpath imports instead of retired Effect idioms.",
    );
  });

  test("passes supported idioms, local Live names, shadowed APIs, and excluded tests", async () => {
    const root = await mkdtemp(join(tmpdir(), "lando-effect-idioms-boundary-"));
    try {
      const fixtures = [
        'import { Effect, Predicate } from "effect"; export const work = Effect.fn("work")(function* () {}); Predicate.isObject({}); export const layer = {};',
        'import { Effect } from "effect"; const work = () => Effect.gen(function* () {}).pipe(Effect.asVoid);',
        'import { Effect } from "effect"; use(() => Effect.gen(function* () {})); use(function namedCallback() { return Effect.gen(function* () {}); });',
        "export const time = Date.now(); const instant = new Date();",
        "const FooLive = {}; const makeFooLive = () => FooLive; export { FooLive as layer }; export default makeFooLive;",
        'import { Effect, Data } from "effect"; function work(Effect, Data, Date) { Data.Error(); Date.now(); return Effect.gen(function* () {}); }',
        'import { Effect } from "./custom"; const work = () => Effect.gen(function* () {});',
        'import { Data } from "./custom"; const x = Data.TaggedError("X");',
        'import { Effect } from "effect"; function work() { const value = 1; return Effect.gen(function* () { return value; }); }',
        'import { isObject } from "effect/Predicate"; isObject({}); const x = { isObject: true };',
        "export default class FooLive {}",
        'import("effect"); const now = Date.now();',
        'promise.catch((cause) => { if (cause.code === "ENOENT") return null; throw cause; }); promise.catch(() => undefined); promise.catch(() => []);',
      ];
      for (const [index, content] of fixtures.entries()) {
        await write(root, `core/src/x/pass-${index}.ts`, content);
      }
      await write(
        root,
        "plugins/y/src/pass.ts",
        'import * as E from "effect/Effect"; export const layer = E.succeed(1);',
      );
      await write(
        root,
        "core/src/x/ignored.test.ts",
        failingFixtures.map(([, content]) => content).join("\n"),
      );
      await write(
        root,
        "plugins/y/src/ignored.test.ts",
        'import { Data } from "effect"; export const FooLive = Data.Error;',
      );

      expect(await checkEffectIdiomsBoundary({ root })).toEqual({ ok: true, offenders: [] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("allows cause assembly only in the failure owners", async () => {
    const root = await mkdtemp(join(tmpdir(), "lando-cause-owners-"));
    try {
      await write(
        root,
        "engine/src/lifecycle/failure-compensation.ts",
        'import { Cause } from "effect"; Cause.combine(a, b);',
      );
      await write(
        root,
        "sdk/src/command-result/failure.ts",
        'import { Cause } from "effect"; Cause.fromReasons([]);',
      );
      expect(await checkEffectIdiomsBoundary({ root })).toEqual({ ok: true, offenders: [] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("ignores violations in derived output and dependency directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "lando-effect-idioms-boundary-"));
    try {
      await write(root, "plugins/y/dist/x.d.ts", "export declare const FooLive: unknown;");
      await write(root, "plugins/y/node_modules/z/x.ts", "export const FooLive = {};");

      const result = await checkEffectIdiomsBoundary({ root });

      expect(result).toEqual({ ok: true, offenders: [] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test.each(failingFixtures)(
    "reports %s with its exact file, line, and match",
    async (name, content, match) => {
      const root = await mkdtemp(join(tmpdir(), "lando-effect-idioms-boundary-"));
      const path = `plugins/y/src/${name}.ts`;
      try {
        await write(root, path, content);

        const result = await checkEffectIdiomsBoundary({ root });

        expect(result.ok).toBe(false);
        expect(
          result.offenders.map((offender) => ({
            file: relative(root, offender.file).replaceAll("\\", "/"),
            line: offender.line,
            match: offender.match,
          })),
        ).toEqual([{ file: path, line: 2, match }]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
