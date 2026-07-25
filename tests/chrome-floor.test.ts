import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));

test("built identity traversal does not require Array.prototype.at", () => {
  const emitted = readFileSync(join(REPO_ROOT, "dist/aep-gradient-identity.js"), "utf8");
  assert.equal(emitted.includes(".at("), false);
});
