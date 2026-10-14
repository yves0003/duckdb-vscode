#!/usr/bin/env node
/**
 * Verify the DuckDB native binding for a VS Code target.
 *
 *   node scripts/verify-native-binding.mjs [--target win32-x64] [--vsix file.vsix]
 *
 * Checks, for the target (default: this machine's platform-arch):
 *   1. node_modules has @duckdb/node-bindings-<target> with duckdb.node and
 *      the DuckDB shared library next to it.
 *   2. When the target matches this machine (and no --vsix is given), the
 *      binding loads through @duckdb/node-api and runs a query.
 *   3. With --vsix, the package ships that binding (and no other platform's),
 *      plus the JS packages that load it. On a matching host, the packaged
 *      @duckdb modules are extracted and loaded on their own, so the check
 *      covers what users install rather than the dev node_modules.
 *
 * `vsce package --target X` does not check any of this: packaging win32-x64
 * on macOS silently ships the darwin binary.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const SHARED_LIB = {
  win32: "duckdb.dll",
  darwin: "libduckdb.dylib",
  linux: "libduckdb.so",
};

function parseArgs(argv) {
  const args = { target: `${process.platform}-${process.arch}`, vsix: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--target") {
      args.target = argv[++i];
    } else if (argv[i] === "--vsix") {
      args.vsix = argv[++i];
    } else {
      throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }
  return args;
}

/** Read a zip's central directory (VSIX files are zips). */
function readZip(file) {
  const buf = fs.readFileSync(file);
  const minEocd = Math.max(0, buf.length - 0xffff - 22);
  let eocd = -1;
  for (let i = buf.length - 22; i >= minEocd; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    throw new Error(`${file} is not a zip archive`);
  }
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || offset === 0xffffffff) {
    throw new Error(`${file} uses zip64, which this script does not parse`);
  }
  const entries = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error(`Corrupt central directory in ${file}`);
    }
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    entries.push({
      name: buf.toString("utf8", offset + 46, offset + 46 + nameLen),
      method: buf.readUInt16LE(offset + 10),
      compressedSize: buf.readUInt32LE(offset + 20),
      localOffset: buf.readUInt32LE(offset + 42),
    });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return { buf, entries };
}

/** Extract entries under `prefix` (stored or deflated) into `destDir`. */
function extractZip({ buf, entries }, prefix, destDir) {
  for (const entry of entries) {
    if (!entry.name.startsWith(prefix) || entry.name.endsWith("/")) {
      continue;
    }
    const local = entry.localOffset;
    const dataStart =
      local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(dataStart, dataStart + entry.compressedSize);
    let data;
    if (entry.method === 0) {
      data = raw;
    } else if (entry.method === 8) {
      data = zlib.inflateRawSync(raw);
    } else {
      throw new Error(`Unsupported compression ${entry.method}: ${entry.name}`);
    }
    const out = path.join(destDir, ...entry.name.split("/"));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, data);
  }
}

/** Load @duckdb/node-api resolved from `fromDir` and run a query. */
async function runQuery(fromDir) {
  const require = createRequire(path.join(fromDir, "package.json"));
  const { DuckDBInstance } = require("@duckdb/node-api");
  const instance = await DuckDBInstance.create(":memory:");
  const conn = await instance.connect();
  const reader = await conn.runAndReadAll("SELECT 42 AS answer, version() AS v");
  const [row] = reader.getRowObjectsJS();
  conn.closeSync();
  instance.closeSync();
  return { ...row, from: path.dirname(require.resolve("@duckdb/node-api")) };
}

const failures = [];
function check(ok, message) {
  console.log(`${ok ? "ok  " : "FAIL"}  ${message}`);
  if (!ok) {
    failures.push(message);
  }
}

async function main() {
  const { target, vsix } = parseArgs(process.argv.slice(2));
  const [platform] = target.split("-");
  const sharedLib = SHARED_LIB[platform];
  if (!sharedLib) {
    throw new Error(`Unsupported target: ${target}`);
  }
  const bindingPkg = `@duckdb/node-bindings-${target}`;
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

  console.log(`Target: ${target} (host: ${process.platform}-${process.arch})`);

  // 1. Installed binding
  const bindingDir = path.join(root, "node_modules", ...bindingPkg.split("/"));
  check(
    fs.existsSync(path.join(bindingDir, "duckdb.node")),
    `${bindingPkg}/duckdb.node installed`
  );
  check(
    fs.existsSync(path.join(bindingDir, sharedLib)),
    `${bindingPkg}/${sharedLib} installed`
  );

  // 2. Load + query (only possible on a matching host). Skipped with --vsix:
  // loading the dev copy first could let the OS reuse its already-loaded
  // shared library and mask a broken packaged one.
  const hostMatches = target === `${process.platform}-${process.arch}`;
  if (hostMatches && vsix) {
    console.log("skip  dev load/query (checking the packaged binding instead)");
  } else if (hostMatches) {
    try {
      const row = await runQuery(root);
      check(Number(row.answer) === 42, `query ran on DuckDB ${row.v}`);
    } catch (e) {
      check(false, `binding load/query failed: ${e.message}`);
    }
  } else {
    console.log("skip  load/query (target differs from host)");
  }

  // 3. Packaged VSIX contents
  if (vsix) {
    const zip = readZip(vsix);
    const entries = new Set(zip.entries.map((e) => e.name));
    const mod = "extension/node_modules/@duckdb";
    for (const required of [
      "extension/out/extension.js",
      `${mod}/node-api/package.json`,
      `${mod}/node-bindings/duckdb.js`,
      `${mod}/node-bindings-${target}/duckdb.node`,
      `${mod}/node-bindings-${target}/${sharedLib}`,
    ]) {
      check(entries.has(required), `VSIX contains ${required}`);
    }
    const foreign = [...entries].filter(
      (e) =>
        /\/node-bindings-[^/]+\/duckdb\.node$/.test(e) &&
        !e.includes(`/node-bindings-${target}/`)
    );
    check(
      foreign.length === 0,
      `VSIX has no other platform bindings${foreign.length ? `: ${foreign.join(", ")}` : ""}`
    );

    if (hostMatches) {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "duckdb-vsix-"));
      try {
        extractZip(zip, "extension/node_modules/@duckdb/", tmp);
        const extDir = path.join(tmp, "extension");
        const row = await runQuery(extDir);
        check(
          Number(row.answer) === 42,
          `query ran from packaged binding (DuckDB ${row.v}, ${row.from})`
        );
      } catch (e) {
        check(false, `packaged binding load/query failed: ${e.message}`);
      } finally {
        try {
          fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
        } catch {
          // The loaded DLL stays locked on Windows until the process exits
        }
      }
    }
  }

  if (failures.length) {
    console.error(`\n${failures.length} check(s) failed for ${target}`);
    process.exit(1);
  }
  console.log(`\nNative binding OK for ${target}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
