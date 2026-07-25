import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

type PackageManifest = {
  private?: boolean;
  license: string;
  author: string;
  repository: { type: string; url: string };
  homepage: string;
  bugs: { url: string };
  publishConfig: { access: string };
  keywords: string[];
  exports: {
    ".": {
      types: string;
      import: string;
    };
  };
  files: string[];
  scripts: Record<string, string>;
};

type PackageLock = {
  packages: {
    "": { license: string };
  };
};

const PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(
  readFileSync(join(PROJECT_ROOT, "package.json"), "utf8"),
) as PackageManifest;
const packageLock = JSON.parse(
  readFileSync(join(PROJECT_ROOT, "package-lock.json"), "utf8"),
) as PackageLock;
const ignoredPaths = readFileSync(join(PROJECT_ROOT, ".gitignore"), "utf8")
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line !== "" && line[0] !== "#");

test("package metadata exports and packages generated dist while Git ignores it", () => {
  assert.equal(manifest.exports["."].types, "./dist/index.d.ts");
  assert.equal(manifest.exports["."].import, "./dist/index.js");
  assert.ok(manifest.files.includes("dist/"));
  assert.ok(ignoredPaths.includes("dist/"));
});

test("public package metadata and license use the approved MIT identity", () => {
  assert.equal(Object.hasOwn(manifest, "private"), false);
  assert.equal(manifest.license, "MIT");
  assert.equal(packageLock.packages[""].license, "MIT");
  assert.equal(manifest.author, "Zimoby");
  assert.deepEqual(manifest.repository, {
    type: "git",
    url: "git+https://github.com/zimoby/ae-native-gradient-toolkit.git",
  });
  assert.equal(manifest.homepage, "https://github.com/zimoby/ae-native-gradient-toolkit#readme");
  assert.deepEqual(manifest.bugs, {
    url: "https://github.com/zimoby/ae-native-gradient-toolkit/issues",
  });
  assert.deepEqual(manifest.publishConfig, { access: "public" });
  assert.deepEqual(manifest.keywords, [
    "after-effects",
    "aep",
    "ffx",
    "gradient",
    "typescript",
  ]);

  const license = readFileSync(join(PROJECT_ROOT, "LICENSE"), "utf8");
  assert.equal(license.startsWith("MIT License\n\nCopyright (c) 2026 Zimoby\n"), true);
});

test("Git dependency installs build dist during prepare", () => {
  assert.equal(manifest.scripts.prepare, "npm run build");
});

test("normal package archives continue to build dist during prepack", () => {
  assert.equal(manifest.scripts.prepack, "npm run build");
});

test("canonical check enforces the exact npm distribution surface", () => {
  assert.equal(
    manifest.scripts["check:package"],
    "npm run build && node scripts/check-package-contents.mjs",
  );
  assert.equal(manifest.scripts["pack:check"], "npm run check:package");
  assert.equal(manifest.scripts.check, "npm test && npm run check:package");
});
