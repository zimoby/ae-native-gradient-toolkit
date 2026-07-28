import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const DIST_ROOT = join(REPO_ROOT, "dist");

test("generated declarations use runtime .js specifiers for older consumers", () => {
  const declarations = readdirSync(DIST_ROOT)
    .filter((name) => name.endsWith(".d.ts"))
    .sort();
  assert.ok(declarations.length > 0);

  for (const name of declarations) {
    const source = readFileSync(join(DIST_ROOT, name), "utf8");
    assert.doesNotMatch(source, /(?:from\s+|import\s*\(\s*)["'][^"']+\.ts["']/);
  }
});
