#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const PACKAGE_MANIFEST_PATH = join(PROJECT_ROOT, "package.json");
const FIXTURE_MANIFEST_PATH = join(
  PROJECT_ROOT,
  "tests/fixtures/native-gradient/manifest.json",
);

function fail(message) {
  throw new Error(`package content check failed: ${message}`);
}

function loadJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function createPackStagingDirectory() {
  const parent = mkdtempSync(join(tmpdir(), "ae-native-gradient-pack-check-"));
  try {
    const root = join(parent, "package");
    cpSync(PROJECT_ROOT, root, {
      recursive: true,
      filter(source) {
        const path = relative(PROJECT_ROOT, source);
        if (path === "") return true;
        const rootName = path.split(sep)[0];
        return rootName !== ".git" && rootName !== "node_modules" && !source.endsWith(".tgz");
      },
    });

    const manifestPath = join(root, "package.json");
    const manifest = loadJson(manifestPath);
    for (const script of ["prepare", "prepack", "postpack"]) delete manifest.scripts[script];
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    return { parent, root };
  } catch (error) {
    rmSync(parent, { recursive: true, force: true });
    throw error;
  }
}

function runPackDryRun() {
  const staging = createPackStagingDirectory();
  const npmCli = process.env.npm_execpath;
  const command = npmCli
    ? process.execPath
    : process.platform === "win32"
      ? "npm.cmd"
      : "npm";
  const args = npmCli
    ? [npmCli, "pack", "--dry-run", "--json", "--loglevel=silent"]
    : ["pack", "--dry-run", "--json", "--loglevel=silent"];
  try {
    const result = spawnSync(command, args, {
      cwd: staging.root,
      encoding: "utf8",
      env: { ...process.env, npm_config_update_notifier: "false" },
      maxBuffer: 16 * 1024 * 1024,
    });
    if (result.error) fail(`npm pack could not start: ${result.error.message}`);
    if (result.status !== 0) {
      fail(`npm pack exited ${result.status}: ${(result.stderr || result.stdout).trim()}`);
    }

    const output = result.stdout.trim();
    const start = output.indexOf("[");
    const end = output.lastIndexOf("]");
    if (start === -1 || end < start) fail("npm pack did not emit a JSON array");
    const parsed = JSON.parse(output.slice(start, end + 1));
    if (!Array.isArray(parsed) || parsed.length !== 1 || !Array.isArray(parsed[0].files)) {
      fail("npm pack JSON had an unexpected result shape");
    }
    return parsed[0];
  } finally {
    rmSync(staging.parent, { recursive: true, force: true });
  }
}

function expectedPackagePaths() {
  const packageManifest = loadJson(PACKAGE_MANIFEST_PATH);
  const fixtureManifest = loadJson(FIXTURE_MANIFEST_PATH);
  const sourceModules = readdirSync(join(PROJECT_ROOT, "src"), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => basename(entry.name, ".ts"))
    .sort();
  const templates = fixtureManifest.fixtures
    .filter((fixture) => fixture.distribution === "npm-and-repository")
    .map((fixture) => fixture.path)
    .sort();

  if (templates.length !== 6 || templates.some((path) => !path.endsWith(".ffx"))) {
    fail("fixture manifest must expose exactly six package-shipped FFX templates");
  }

  const expected = new Set([
    "LICENSE",
    "README.md",
    "package.json",
    "bin/ae-native-gradient.mjs",
    "bin/generate.mjs",
    ...templates,
  ]);
  for (const moduleName of sourceModules) {
    expected.add(`dist/${moduleName}.js`);
    expected.add(`dist/${moduleName}.js.map`);
    expected.add(`dist/${moduleName}.d.ts`);
    expected.add(`dist/${moduleName}.d.ts.map`);
  }

  if (packageManifest.files.some((path) => path.includes("tests") || path.includes("scripts"))) {
    fail("package.json files allowlist includes a repository-only path");
  }
  return [...expected].sort();
}

function validateSourceMaps(paths) {
  for (const path of paths.filter((entry) => entry.endsWith(".map"))) {
    const sourceMap = loadJson(join(PROJECT_ROOT, path));
    const outputName = basename(path);
    const moduleName = outputName.endsWith(".d.ts.map")
      ? outputName.slice(0, -".d.ts.map".length)
      : outputName.slice(0, -".js.map".length);
    const expectedSource = `../src/${moduleName}.ts`;
    if (Object.hasOwn(sourceMap, "sourcesContent")) {
      fail(`${path} embeds sourcesContent`);
    }
    if (sourceMap.sourceRoot !== "" && sourceMap.sourceRoot !== undefined) {
      fail(`${path} has a non-empty sourceRoot`);
    }
    if (!Array.isArray(sourceMap.sources) || sourceMap.sources.length !== 1) {
      fail(`${path} must name exactly one relative source`);
    }
    for (const source of sourceMap.sources) {
      if (source !== expectedSource) {
        fail(`${path} exposes unexpected source path ${JSON.stringify(source)}`);
      }
    }
  }
}

function validateNoPrivateMarkers(paths) {
  const forbiddenMarkers = [
    "/Users/",
    ":\\Users\\",
    ":/Users/",
    "/home/",
    "/private/tmp/",
  ].map((value) => Buffer.from(value, "utf8"));

  for (const path of paths) {
    const bytes = readFileSync(join(PROJECT_ROOT, path));
    for (const marker of forbiddenMarkers) {
      if (bytes.includes(marker)) fail(`${path} contains a private/local marker`);
    }
  }
}

const pack = runPackDryRun();
const actual = pack.files.map((entry) => entry.path).sort();
const expected = expectedPackagePaths();
const missing = expected.filter((path) => !actual.includes(path));
const unexpected = actual.filter((path) => !expected.includes(path));
if (missing.length > 0 || unexpected.length > 0) {
  fail(`inventory mismatch; missing=${JSON.stringify(missing)} unexpected=${JSON.stringify(unexpected)}`);
}
if (actual.some((path) => path.endsWith(".aep") || /^(?:tests|docs|scripts)\//.test(path))) {
  fail("package contains repository-only tests, docs, scripts, or AEP fixtures");
}

validateSourceMaps(actual);
validateNoPrivateMarkers(actual);

console.log(JSON.stringify({
  package: pack.name,
  version: pack.version,
  fileCount: actual.length,
  templates: actual.filter((path) => path.endsWith(".ffx")),
}, null, 2));
