import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";

import {
  LandofileExpressionEvalError,
  LandofileLoadLimitError,
  LandofileLoadOutsideRootError,
} from "@lando/sdk/errors";
import type { FileRef, ImportRefValue, LandofileLayer } from "@lando/sdk/schema";

import type { LandofileReferencedFile } from "./load-expression-provenance.ts";

export interface LandofileLoadPolicy {
  readonly allowOutsideRoot: boolean;
  readonly maxFileBytes: number;
  readonly maxFilesPerExpression: number;
  readonly maxRecursionDepth: number;
}

export const DEFAULT_LANDOFILE_LOAD_POLICY: LandofileLoadPolicy = {
  allowOutsideRoot: false,
  maxFileBytes: 1_048_576,
  maxFilesPerExpression: 16,
  maxRecursionDepth: 4,
};

export interface LandofileLoadSource {
  readonly appRoot: string;
  readonly sourcePath: string;
  readonly sourceRoot: string;
  readonly layer: LandofileLayer;
}

interface LoadedFile {
  readonly ref: FileRef;
  readonly bytes: Uint8Array;
}

export class LandofileFileSession {
  readonly dependencies: LandofileReferencedFile[] = [];
  readonly relaxedReads: Array<{ readonly authoredPath: string; readonly absolutePath: string }> = [];
  readonly #loaded = new Map<string, LoadedFile>();
  readonly #refs = new WeakMap<object, LoadedFile>();
  readonly #expressionPaths = new Set<string>();

  constructor(
    readonly source: LandofileLoadSource,
    readonly policy: LandofileLoadPolicy,
  ) {}

  beginExpression(): void {
    this.#expressionPaths.clear();
  }

  load(authoredPath: string): FileRef {
    const candidate = resolve(this.source.sourceRoot, authoredPath);
    let absolutePath: string;
    try {
      absolutePath = realpathSync(candidate);
    } catch (cause) {
      throw new LandofileExpressionEvalError({
        message: `Landofile load could not read ${authoredPath}.`,
        filePath: this.source.sourcePath,
        remediation: "Point load/import at a readable local file.",
        cause,
      });
    }
    const escapes = relative(this.source.appRoot, absolutePath);
    const outside = isAbsolute(authoredPath) || escapes === ".." || escapes.startsWith(`..${sep}`);
    if (outside && !this.policy.allowOutsideRoot) {
      throw new LandofileLoadOutsideRootError({
        message: `Landofile load path ${authoredPath} is outside the app root.`,
        sourcePath: this.source.sourcePath,
        authoredPath,
        resolvedPath: absolutePath,
        appRoot: this.source.appRoot,
        remediation: "Move the file under the app root or enable allowLoadOutsideRoot in global config.",
      });
    }
    this.#expressionPaths.add(absolutePath);
    if (this.#expressionPaths.size > this.policy.maxFilesPerExpression) {
      throw new LandofileLoadLimitError({
        message: "Landofile expression references too many files.",
        kind: "files-per-expression",
        limit: this.policy.maxFilesPerExpression,
        observed: this.#expressionPaths.size,
        sourcePath: this.source.sourcePath,
        authoredPath,
        remediation: "Raise loadMaxFilesPerExpression or split the expression.",
      });
    }
    const cached = this.#loaded.get(absolutePath);
    if (cached !== undefined) {
      if (outside) this.relaxedReads.push({ authoredPath, absolutePath });
      return cached.ref;
    }
    const stat = statSync(absolutePath);
    if (stat.size > this.policy.maxFileBytes) {
      throw new LandofileLoadLimitError({
        message: `Landofile load file ${authoredPath} exceeds the byte limit.`,
        kind: "file-bytes",
        limit: this.policy.maxFileBytes,
        observed: stat.size,
        sourcePath: this.source.sourcePath,
        authoredPath,
        remediation: "Raise loadMaxFileBytes or use a smaller local file.",
      });
    }
    const bytes = readFileSync(absolutePath);
    const checksum = createHash("sha256").update(bytes).digest("hex");
    let encoding: FileRef["encoding"] = "ascii";
    if (!bytes.every((byte) => byte < 128)) {
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        encoding = "utf-8";
      } catch (cause) {
        if (!(cause instanceof TypeError)) throw cause;
        encoding = "binary";
      }
    }
    const ref: FileRef = {
      _tag: "FileRef",
      path: absolutePath,
      size: bytes.byteLength,
      mime: Bun.file(absolutePath).type,
      checksum,
      encoding,
    };
    const dependency = { absolutePath, size: bytes.byteLength, mtimeMs: stat.mtimeMs, sha256: checksum };
    const loaded = { ref, bytes };
    this.#loaded.set(absolutePath, loaded);
    this.#refs.set(ref, loaded);
    this.dependencies.push(dependency);
    if (outside) this.relaxedReads.push({ authoredPath, absolutePath });
    return ref;
  }

  text(ref: FileRef): string {
    const loaded = this.#refs.get(ref);
    if (loaded === undefined) {
      throw new LandofileExpressionEvalError({
        message: "FileRef belongs to another Landofile evaluation session.",
        filePath: this.source.sourcePath,
        remediation: "Use FileRef values only within the expression that created them.",
      });
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(loaded.bytes);
    } catch (cause) {
      throw new LandofileExpressionEvalError({
        message: `Landofile load file ${ref.path} is not valid UTF-8 text.`,
        filePath: this.source.sourcePath,
        remediation: "Use the bytes decoder for binary content or provide UTF-8 text.",
        cause,
      });
    }
  }

  bytes(ref: FileRef): Uint8Array {
    const loaded = this.#refs.get(ref);
    if (loaded === undefined) {
      throw new LandofileExpressionEvalError({
        message: "FileRef belongs to another Landofile evaluation session.",
        filePath: this.source.sourcePath,
        remediation: "Use FileRef values only within the expression that created them.",
      });
    }
    return new Uint8Array(loaded.bytes);
  }

  import<A>(authoredPath: string, ref: FileRef, value: A): ImportRefValue<A> {
    return {
      _tag: "ImportRef",
      value,
      path: authoredPath,
      basename: basename(authoredPath),
      checksum: ref.checksum,
      layer: this.source.layer,
    };
  }
}
