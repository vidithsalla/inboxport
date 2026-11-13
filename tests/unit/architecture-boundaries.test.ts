import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join, relative } from "node:path";
import test from "node:test";

const projectRoot = new URL("../../", import.meta.url).pathname;
const sourceRoots = ["app", "db", "lib", "worker"];
const sourceExtensions = new Set([".ts", ".tsx", ".mts", ".js", ".mjs"]);

function sourceFiles(directory: string): string[] {
  const absolute = join(projectRoot, directory);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const path = join(absolute, entry.name);
    if (entry.isDirectory()) return sourceFiles(relative(projectRoot, path));
    return sourceExtensions.has(extname(path)) ? [path] : [];
  });
}

test("provider SDK imports are confined to provider implementations", () => {
  const providerImport = /(?:from\s+|import\s*\()["'](?:googleapis|@googleapis\/|@microsoft\/microsoft-graph-client)/;
  const violations = sourceRoots
    .flatMap(sourceFiles)
    .filter((path) => !relative(projectRoot, path).startsWith("lib/relay/providers/"))
    .filter((path) => providerImport.test(readFileSync(path, "utf8")))
    .map((path) => relative(projectRoot, path));

  assert.deepEqual(violations, []);
});

test("the prototype does not claim controls the architecture cannot provide", () => {
  const page = readFileSync(join(projectRoot, "app/page.tsx"), "utf8");
  const forbiddenClaims = [
    /end-to-end encrypted/i,
    /credentials stay encrypted on this device/i,
    /local MCP endpoint/i,
    /immutable audit trail/i,
    /92\s*\/\s*100/,
  ];

  for (const claim of forbiddenClaims) {
    assert.doesNotMatch(page, claim);
  }
});
