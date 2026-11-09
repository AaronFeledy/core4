import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sqliteCompletionReceiptSql, sqliteIntegritySql } from "../src/sqlite-integrity.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const database = (corrupt: boolean): string => {
  const root = mkdtempSync(join(tmpdir(), "lando-sqlite-receipt-"));
  roots.push(root);
  const path = join(root, "site.sqlite");
  const setup = new Database(path);
  setup.run("CREATE TABLE items(name TEXT)");
  for (let index = 0; index < 200; index += 1) setup.run("INSERT INTO items VALUES (?)", [`row-${index}`]);
  const rootPage = setup
    .query<{ rootpage: number }, []>("SELECT rootpage FROM sqlite_schema WHERE name='items'")
    .get()?.rootpage;
  setup.close();
  if (corrupt) {
    if (rootPage === undefined) throw new Error("Missing items root page");
    const bytes = readFileSync(path);
    bytes[(rootPage - 1) * bytes.readUInt16BE(16)] = 0;
    writeFileSync(path, bytes);
  }
  return path;
};

// Run every statement and ignore failures, as a sqlite3 CLI that keeps going after an error would.
const receipt = (path: string): ReadonlyArray<unknown> => {
  const db = new Database(path);
  try {
    for (const statement of sqliteIntegritySql.split(";").map((part) => part.trim())) {
      if (statement.length === 0) continue;
      try {
        db.run(statement);
      } catch {
        // A failed integrity statement must leave nothing for the receipt to report.
      }
    }
    return db.query(sqliteCompletionReceiptSql("'done'")).values();
  } finally {
    db.close();
  }
};

test("the completion receipt reports only after an ok integrity check", () => {
  expect(receipt(database(false))).toEqual([["done"]]);
});

test("the completion receipt stays empty for a corrupt database even when execution continues", () => {
  expect(receipt(database(true))).toEqual([]);
});
