/**
 * Native binding tests for DuckDBService
 *
 * Exercises the real @duckdb/node-api native binding (no VS Code host), so a
 * missing or wrong-platform binding fails here on every CI OS, including
 * Windows. Paths are built with `path` so Windows runs use backslashes.
 *
 * Run with: npx tsx --test src/test/duckdbNative.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DuckDBService, buildQueryFileSql } from "../services/duckdb";

const FIXTURES = path.join(__dirname, "fixtures");

// Apostrophe + space exercise SQL string escaping of local paths
function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix} it's-`));
}

function removeDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  } catch (e) {
    console.warn(`cleanup failed for ${dir}:`, e);
  }
}

describe("DuckDB native binding", () => {
  let service: DuckDBService;

  before(async () => {
    service = new DuckDBService();
    await service.initialize();
  });

  after(async () => {
    await service.close();
  });

  it("loads the binding for this platform and runs a query", async () => {
    const rows = await service.query("SELECT 42 AS answer, version() AS v");
    assert.strictEqual(Number(rows[0].answer), 42);
    assert.match(String(rows[0].v), /^v\d+\.\d+/);
  });

  it("executes multiple statements and caches SELECT results", async () => {
    const result = await service.executeQuery(
      "CREATE TABLE t AS SELECT * FROM range(250) r(i); SELECT i FROM t ORDER BY i;",
      100
    );
    assert.strictEqual(result.statements.length, 2);
    const select = result.statements[1];
    assert.strictEqual(select.meta.totalRows, 250);
    assert.strictEqual(select.page.rows.length, 100);
    assert.deepStrictEqual(select.meta.columns, ["i"]);
  });

  it("reads a local CSV file by OS-native path", async () => {
    const sql = buildQueryFileSql(path.join(FIXTURES, "users.csv"));
    const rows = await service.query(sql);
    assert.ok(rows.length > 0);
    assert.strictEqual(rows[0].name, "Alice");
  });

  it("attaches a database file whose path contains a quote", async () => {
    const dir = makeTempDir("duckdb-attach");
    const dbPath = path.join(dir, "test.duckdb");
    try {
      await service.run(
        `ATTACH '${dbPath.replace(/'/g, "''")}' AS "native_test"`
      );
      await service.run(
        `CREATE TABLE native_test.items AS SELECT 'x' AS k, 1 AS v`
      );
      const rows = await service.query("SELECT * FROM native_test.items");
      assert.deepStrictEqual(
        rows.map((r) => [r.k, Number(r.v)]),
        [["x", 1]]
      );
      await service.run(`DETACH "native_test"`);
      assert.ok(fs.existsSync(dbPath));
    } finally {
      removeDir(dir);
    }
  });
});

describe("DuckDBService lifecycle", () => {
  it("accepts a temp directory whose path contains a quote", async () => {
    const dir = makeTempDir("duckdb-spill");
    const service = new DuckDBService();
    try {
      await service.initialize({ tempDirectory: dir });
      const rows = await service.query(
        "SELECT current_setting('temp_directory') AS d"
      );
      assert.strictEqual(path.resolve(String(rows[0].d)), path.resolve(dir));
    } finally {
      await service.close();
      removeDir(dir);
    }
  });

  it("removes its own temp directory on close", async () => {
    const service = new DuckDBService();
    await service.initialize();
    const rows = await service.query(
      "SELECT current_setting('temp_directory') AS d"
    );
    const tempDir = String(rows[0].d);
    assert.ok(fs.existsSync(tempDir));
    await service.close();
    assert.ok(!fs.existsSync(tempDir));
  });
});
