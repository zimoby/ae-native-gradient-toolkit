import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  enumerateAepGradientCandidates,
  requireUniqueAepGradientCandidate,
} from "../src/aep-gradient-inventory.ts";
import type { NativeGradient } from "../src/native-gradient-types.ts";
import { parseRifx } from "../src/riff-rifx.ts";

type FixtureKind = "fill" | "stroke" | "mixed";

type AcquisitionRun = {
  id: string;
  afterEffectsVersion: string;
  platform: string;
  method: string;
};

type ManifestFixture = {
  path: string;
  kind: FixtureKind;
  role: "ffx-template" | "unique-gradient-aep" | "exact-identity-aep";
  acquisitionRunId: string;
  ownership: string;
  distribution: "npm-and-repository" | "repository-test-only";
  byteLength: number;
  sha256: string;
  expectedPath: string;
  expectedSha256: string;
};

type FixtureManifest = {
  schemaVersion: 2;
  acquisitionRuns: AcquisitionRun[];
  fixtures: ManifestFixture[];
};

type FrozenExpected = {
  schemaVersion: 1;
  kind: FixtureKind;
  file: { byteLength: number; sha256: string };
  riff: {
    rootId: "RIFX";
    formType: string;
    declaredEnd: number;
    trailerStart: number;
    trailerByteLength: number;
  };
  candidateCount: 1;
  candidate: {
    sourceOrder: 0;
    status: "valid";
    listFormType: "GCky";
    utf8Count: 1;
    parentMatchName: string;
    colorsMatchName: "ADBE Vector Grad Colors";
    sourcePayloadSha256: string;
    gradient: NativeGradient;
  };
};

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const MANIFEST_PATH = join(REPO_ROOT, "tests/fixtures/native-gradient/manifest.json");
const manifest = loadJson<FixtureManifest>(MANIFEST_PATH);

function loadJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function repositoryPath(path: string): string {
  return relative(REPO_ROOT, path).split(sep).join("/");
}

function listBinaryFiles(path: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) files.push(...listBinaryFiles(child));
    else if (entry.isFile() && /\.(?:aep|ffx)$/i.test(entry.name)) files.push(repositoryPath(child));
  }
  return files;
}

function containsAscii(source: Uint8Array, value: string): boolean {
  const view = Buffer.from(source.buffer, source.byteOffset, source.byteLength);
  return view.includes(Buffer.from(value, "utf8"));
}

function oracleNumber(value: number): number {
  return Number(value.toFixed(8));
}

function normalizeGradient(gradient: NativeGradient): NativeGradient {
  return {
    schemaVersion: 1,
    colorStops: gradient.colorStops.map((stop) => ({
      offset: oracleNumber(stop.offset),
      midpoint: oracleNumber(stop.midpoint),
      rgb: [oracleNumber(stop.rgb[0]), oracleNumber(stop.rgb[1]), oracleNumber(stop.rgb[2])],
      extra: oracleNumber(stop.extra),
    })),
    alphaStops: gradient.alphaStops.map((stop) => ({
      offset: oracleNumber(stop.offset),
      midpoint: oracleNumber(stop.midpoint),
      alpha: oracleNumber(stop.alpha),
    })),
  };
}

test("frozen native-gradient manifest hashes every owned fixture and expected model", () => {
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.acquisitionRuns.length, 2);

  const acquisitionRunIds = new Set(manifest.acquisitionRuns.map((run) => run.id));
  assert.equal(acquisitionRunIds.size, manifest.acquisitionRuns.length);
  for (const run of manifest.acquisitionRuns) {
    assert.notEqual(run.afterEffectsVersion.trim(), "");
    assert.notEqual(run.platform.trim(), "");
    assert.notEqual(run.method.trim(), "");
  }

  const binaryPaths = [
    ...listBinaryFiles(join(REPO_ROOT, "fixtures/native-gradient")),
    ...listBinaryFiles(join(REPO_ROOT, "tests/fixtures/native-gradient")),
  ].sort();
  const manifestedPaths = manifest.fixtures.map((fixture) => fixture.path).sort();
  assert.equal(binaryPaths.length, 5);
  assert.deepEqual(manifestedPaths, binaryPaths);
  assert.equal(new Set(manifestedPaths).size, manifestedPaths.length);

  for (const fixture of manifest.fixtures) {
    assert.equal(acquisitionRunIds.has(fixture.acquisitionRunId), true, `${fixture.path} acquisition run`);
    assert.notEqual(fixture.ownership.trim(), "", `${fixture.path} ownership`);
    assert.equal(
      fixture.role === "ffx-template"
        ? fixture.distribution === "npm-and-repository"
        : fixture.distribution === "repository-test-only",
      true,
      `${fixture.path} distribution scope`,
    );
    const source = readFileSync(join(REPO_ROOT, fixture.path));
    const expected = readFileSync(join(REPO_ROOT, fixture.expectedPath));
    assert.equal(source.byteLength, fixture.byteLength, `${fixture.path} byte length`);
    assert.equal(sha256(source), fixture.sha256, `${fixture.path} SHA-256`);
    assert.equal(sha256(expected), fixture.expectedSha256, `${fixture.expectedPath} SHA-256`);
  }
});

test("static parser output matches every frozen normalized fixture model", () => {
  for (const fixture of manifest.fixtures.filter((entry) => entry.role !== "exact-identity-aep")) {
    assert.notEqual(fixture.kind, "mixed");
    const source = readFileSync(join(REPO_ROOT, fixture.path));
    const expected = loadJson<FrozenExpected>(join(REPO_ROOT, fixture.expectedPath));
    const document = parseRifx(source);
    const candidates = enumerateAepGradientCandidates(document);
    const candidate = requireUniqueAepGradientCandidate(candidates);
    const parentMatchName = fixture.kind === "fill"
      ? "ADBE Vector Graphic - G-Fill"
      : "ADBE Vector Graphic - G-Stroke";
    const oppositeMatchName = fixture.kind === "fill"
      ? "ADBE Vector Graphic - G-Stroke"
      : "ADBE Vector Graphic - G-Fill";

    assert.equal(containsAscii(source, parentMatchName), true, `${fixture.path} parent identity`);
    assert.equal(containsAscii(source, oppositeMatchName), false, `${fixture.path} opposite identity`);
    assert.equal(containsAscii(source, "ADBE Vector Grad Colors"), true, `${fixture.path} colors identity`);

    const actual: FrozenExpected = {
      schemaVersion: 1,
      kind: fixture.kind,
      file: {
        byteLength: source.byteLength,
        sha256: sha256(source),
      },
      riff: {
        rootId: document.root.id as "RIFX",
        formType: document.root.formType!,
        declaredEnd: document.declaredEnd,
        trailerStart: document.trailerStart,
        trailerByteLength: source.byteLength - document.trailerStart,
      },
      candidateCount: 1,
      candidate: {
        sourceOrder: candidate.sourceOrder as 0,
        status: "valid",
        listFormType: candidate.list.formType as "GCky",
        utf8Count: candidate.utf8Count as 1,
        parentMatchName,
        colorsMatchName: "ADBE Vector Grad Colors",
        sourcePayloadSha256: sha256(
          source.subarray(candidate.utf8.span.dataStart, candidate.utf8.span.dataEnd),
        ),
        gradient: normalizeGradient(candidate.gradient as NativeGradient),
      },
    };

    assert.deepEqual(actual, expected, fixture.expectedPath);
  }
});
