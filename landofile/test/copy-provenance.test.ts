import { expect, test } from "bun:test";
import { getLandofileAppRoot, rememberLandofileAppRoot } from "@lando/landofile/app-root-provenance";
import { copyLandofileProvenance } from "@lando/landofile/copy-provenance";
import {
  getLandofileIncludeSources,
  getLocalIncludePaths,
  hasLandofileIncludeSources,
  hasLocalIncludePaths,
  rememberLandofileIncludeSources,
  rememberLocalIncludePaths,
} from "@lando/landofile/include-provenance";
import {
  getLandofileReferencedFiles,
  hasLandofileReferencedFiles,
  rememberLandofileReferencedFiles,
} from "@lando/landofile/load-expression-provenance";
import {
  getInternalToolingTasks,
  hasInternalToolingTasks,
  rememberInternalToolingTasks,
} from "@lando/landofile/tooling-include-provenance";
import {
  getVersionConstraintEntries,
  hasVersionConstraintEntries,
  rememberVersionConstraintEntries,
} from "@lando/landofile/version-constraint";

test("copies every remembered provenance entry from a frozen source", () => {
  const source = Object.freeze({ lando: ">=4" });
  rememberLandofileAppRoot(source, "/app");
  rememberLocalIncludePaths(source, ["/app/base.yml"]);
  rememberLandofileIncludeSources(source, [{ id: "base", sha256: "abc" }]);
  rememberLandofileReferencedFiles(source, [
    { absolutePath: "/app/config", size: 3, mtimeMs: 1, sha256: "def" },
  ]);
  rememberInternalToolingTasks(source, ["internal"]);
  rememberVersionConstraintEntries(source, [
    { range: ">=4", source: "/app/base.yml", layer: "base", order: 0 },
  ]);
  const target = { ...source };
  expect(copyLandofileProvenance(source, target)).toBe(target);
  expect(getLandofileAppRoot(target)).toBe("/app");
  expect(getLocalIncludePaths(target)).toEqual(["/app/base.yml"]);
  expect(getLandofileIncludeSources(target)).toEqual([{ id: "base", sha256: "abc" }]);
  expect(getLandofileReferencedFiles(target)).toEqual([
    { absolutePath: "/app/config", size: 3, mtimeMs: 1, sha256: "def" },
  ]);
  expect(getInternalToolingTasks(target)).toEqual(["internal"]);
  expect(getVersionConstraintEntries(target, "/fallback")).toEqual([
    { range: ">=4", source: "/app/base.yml", layer: "base", order: 0 },
  ]);
});

test("does not invent entries when source provenance is absent", () => {
  const target = { lando: ">=5" };
  copyLandofileProvenance({ lando: ">=4" }, target);
  expect(getLandofileAppRoot(target)).toBeUndefined();
  expect(hasLocalIncludePaths(target)).toBe(false);
  expect(hasLandofileIncludeSources(target)).toBe(false);
  expect(hasLandofileReferencedFiles(target)).toBe(false);
  expect(hasInternalToolingTasks(target)).toBe(false);
  expect(hasVersionConstraintEntries(target)).toBe(false);
  expect(getVersionConstraintEntries(target, "/fallback")).toEqual([
    { range: ">=5", source: "/fallback", layer: "canonical", order: 3 },
  ]);
});

test("preserves explicitly remembered empty entries", () => {
  const source = { lando: ">=4" };
  rememberLocalIncludePaths(source, []);
  rememberLandofileIncludeSources(source, []);
  rememberLandofileReferencedFiles(source, []);
  rememberInternalToolingTasks(source, []);
  rememberVersionConstraintEntries(source, []);
  const target = copyLandofileProvenance(source, { ...source });
  expect(hasLocalIncludePaths(target)).toBe(true);
  expect(hasLandofileIncludeSources(target)).toBe(true);
  expect(hasLandofileReferencedFiles(target)).toBe(true);
  expect(hasInternalToolingTasks(target)).toBe(true);
  expect(hasVersionConstraintEntries(target)).toBe(true);
  expect(getVersionConstraintEntries(target, "/fallback")).toEqual([]);
});
