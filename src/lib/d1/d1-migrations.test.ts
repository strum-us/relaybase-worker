import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  d1ErrorText,
  isSchemaAlreadyPresentError,
  normalizeMigrationName,
} from "./d1-migration-names.ts";

describe("normalizeMigrationName", () => {
  it("strips wrangler .sql suffix", () => {
    assert.equal(normalizeMigrationName("0000_normal_terrax.sql"), "0000_normal_terrax");
    assert.equal(normalizeMigrationName("0000_normal_terrax"), "0000_normal_terrax");
  });
});

describe("isSchemaAlreadyPresentError", () => {
  it("matches D1 already-exists and duplicate-column", () => {
    assert.equal(
      isSchemaAlreadyPresentError(
        "D1_ERROR: table 'domains' already exists at offset 13: SQLITE_ERROR",
      ),
      true,
    );
    assert.equal(
      isSchemaAlreadyPresentError("duplicate column name: admin_token"),
      true,
    );
    assert.equal(isSchemaAlreadyPresentError("FOREIGN KEY constraint failed"), false);
  });
});

describe("d1ErrorText", () => {
  it("includes cause when message is only D1_ERROR", () => {
    const err = new Error("D1_ERROR");
    err.cause = new Error("table 'domains' already exists at offset 13");
    const text = d1ErrorText(err);
    assert.match(text, /already exists/);
    assert.equal(isSchemaAlreadyPresentError(text), true);
  });
});
