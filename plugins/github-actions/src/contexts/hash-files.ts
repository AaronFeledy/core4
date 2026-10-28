import * as data from "@actions/expressions/data/index";
import type { FunctionDefinition } from "@actions/expressions/funcs/info";
import { Effect } from "effect";
import { EventError, eventError } from "../events/errors.ts";
import { orderedMatch, validatePatterns } from "../events/glob.ts";
import type { LanguageSource } from "../language/errors.ts";
import { expressionDataFromUnknownSync } from "../language/expressions.ts";

// Host-authored immutable digest facts only. This module never reads files and
// cannot attest root canonicalization, no-follow acquisition, or replacement safety.
// An IO capture service proving those properties is still gated.
export interface HashCatalogueInput {
  readonly authorization: "explicit";
  readonly canonicalRoot: string;
  readonly caseSensitive: boolean;
  readonly files: readonly {
    readonly path: string;
    readonly sha256: string;
    readonly size: number;
    readonly identity: string;
  }[];
}
export interface HashFilesResolver {
  readonly ioCapture: "gated";
  readonly resolve: (patterns: readonly string[]) => string;
  readonly function: FunctionDefinition;
}
const safeRelative = (path: string) =>
  path.length > 0 &&
  path.length <= 2048 &&
  !/^(?:\/|[a-z]:)/iu.test(path) &&
  !/[\p{Cc}\p{Cf}\\:*?\[\]{}]/u.test(path) &&
  path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
export const admitHashCatalogue = (
  input: HashCatalogueInput,
  source: LanguageSource,
): Effect.Effect<HashFilesResolver, EventError> =>
  Effect.try({
    try: () => {
      expressionDataFromUnknownSync(input, { limits: { valueNodes: 50000, valueBytes: 262144 } });
      if (
        input.authorization !== "explicit" ||
        !input.canonicalRoot.startsWith("/") ||
        /[\p{Cc}\p{Cf}\\]/u.test(input.canonicalRoot) ||
        input.canonicalRoot.split("/").some((part) => part === "." || part === "..") ||
        typeof input.caseSensitive !== "boolean" ||
        input.files.length > 10000
      )
        throw eventError("event-invalid", source);
      const caseSensitive = input.caseSensitive;
      const paths = new Set<string>();
      let bytes = 0;
      const files = input.files
        .map((file) => {
          const path = caseSensitive ? file.path : file.path.toLowerCase();
          if (
            !safeRelative(path) ||
            paths.has(path) ||
            !/^[0-9a-f]{64}$/u.test(file.sha256) ||
            !Number.isSafeInteger(file.size) ||
            file.size < 0 ||
            typeof file.identity !== "string" ||
            !file.identity ||
            file.identity.length > 256
          )
            throw eventError("event-invalid", source);
          paths.add(path);
          bytes += file.size;
          if (bytes > 64 * 1024 * 1024) throw eventError("event-limit", source);
          return Object.freeze({ path, sha256: file.sha256 });
        })
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      const resolve = (patterns: readonly string[]): string => {
        expressionDataFromUnknownSync(patterns, { limits: { valueNodes: 256, valueBytes: 65536 } });
        validatePatterns(patterns, source, "hash");
        if (!patterns.length || !patterns.some((pattern) => !pattern.startsWith("!")))
          throw eventError("pattern-unsupported", source);
        const normalized = caseSensitive ? patterns : patterns.map((pattern) => pattern.toLowerCase());
        const budget = { remaining: 2_000_000 };
        const matched = files.filter((file) => orderedMatch(normalized, file.path, budget, source));
        if (!matched.length) return "";
        const hasher = new Bun.CryptoHasher("sha256");
        for (const file of matched) {
          const digest = new Uint8Array(32);
          for (let index = 0; index < 32; index++)
            digest[index] = Number.parseInt(file.sha256.slice(index * 2, index * 2 + 2), 16);
          hasher.update(digest);
        }
        return hasher.digest("hex");
      };
      const fn: FunctionDefinition = {
        name: "hashFiles",
        minArgs: 1,
        maxArgs: 128,
        call: (...args) => {
          if (args.some((arg) => !(arg instanceof data.StringData)))
            throw eventError("pattern-unsupported", source);
          return new data.StringData(resolve(args.map((arg) => arg.coerceString())));
        },
      };
      return Object.freeze({
        ioCapture: "gated" as const,
        resolve,
        function: Object.freeze(fn),
        toJSON: () => ({ ioCapture: "gated" }),
      });
    },
    catch: (error) => (error instanceof EventError ? error : eventError("event-invalid", source)),
  });
