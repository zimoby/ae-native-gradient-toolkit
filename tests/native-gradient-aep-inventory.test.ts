import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  closeSync,
  ftruncateSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  enumerateAepGradientCandidates,
  requireUniqueAepGradientCandidate,
  type AepGradientCandidate,
} from "../src/aep-gradient-inventory.ts";
import {
  parseRifx,
  type RiffDocument,
} from "../src/riff-rifx.ts";
import { serializeGradientUtf8Payload } from "../src/gcky-gradient.ts";
import type { NativeGradient } from "../src/native-gradient-types.ts";

type SyntheticNode =
  | { id: string; payload: Uint8Array; pad?: number }
  | { id: "LIST"; formType: string; children: SyntheticNode[]; pad?: number };

const NODE = process.execPath;
const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const INSPECT = join(REPO_ROOT, "bin/ae-native-gradient.mjs");
const encoder = new TextEncoder();

const gradient: NativeGradient = {
  schemaVersion: 1,
  colorStops: [
    { offset: 0, midpoint: 0.25, rgb: [1, 0, -0.25], extra: 1 },
    { offset: 1, midpoint: 0.75, rgb: [0, 0.5, 2], extra: 1 },
  ],
  alphaStops: [
    { offset: 0, midpoint: 0.4, alpha: 1 },
    { offset: 1, midpoint: 0.6, alpha: 0.25 },
  ],
};
const validPayload = serializeGradientUtf8Payload(gradient);

const ascii = (value: string): Uint8Array =>
  Uint8Array.from([...value].map((character) => character.charCodeAt(0)));

const u32 = (value: number): Uint8Array =>
  Uint8Array.of((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);

const concat = (...parts: readonly Uint8Array[]): Uint8Array => {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
};

function chunk(node: SyntheticNode): Uint8Array {
  const payload = "children" in node
    ? concat(ascii(node.formType), ...node.children.map(chunk))
    : node.payload;
  return concat(
    ascii(node.id),
    u32(payload.byteLength),
    payload,
    payload.byteLength % 2 === 1 ? Uint8Array.of(node.pad ?? 0) : new Uint8Array(),
  );
}

function rifx(children: readonly SyntheticNode[], trailer = Uint8Array.of(0xde, 0xad)): Uint8Array {
  const body = concat(ascii("Egg!"), ...children.map(chunk));
  return concat(ascii("RIFX"), u32(body.byteLength), body, trailer);
}

function leaf(id: string, payload: Uint8Array | string): SyntheticNode {
  return { id, payload: typeof payload === "string" ? encoder.encode(payload) : payload };
}

function gcky(...children: SyntheticNode[]): SyntheticNode {
  return { id: "LIST", formType: "GCky", children };
}

function oneGradientFixture(payload = validPayload): Uint8Array {
  return rifx([
    {
      id: "LIST",
      formType: "Layr",
      children: [
        leaf("Name", "Gradient Fill 1"),
        leaf("MNam", "ADBE Vector Graphic - G-Fill\0ADBE Vector Grad Colors\0"),
        gcky(leaf("Utf8", payload), leaf("Meta", Uint8Array.of(1, 2, 3))),
        leaf("Tail", Uint8Array.of(9)),
      ],
    },
  ]);
}

function documentSnapshot(doc: RiffDocument): string {
  return JSON.stringify(doc, (_key, value: unknown) =>
    value instanceof Uint8Array ? [...value] : value);
}

function assertDeeplyFrozenCandidate(candidate: AepGradientCandidate): void {
  assert.equal(Object.isFrozen(candidate), true);
  assert.equal(Object.isFrozen(candidate.list), true);
  assert.equal(Object.isFrozen(candidate.list.span), true);
  assert.equal(Object.isFrozen(candidate.utf8Candidates), true);
  assert.equal(Object.isFrozen(candidate.context), true);
  assert.equal(Object.isFrozen(candidate.context.ancestors), true);
  assert.equal(Object.isFrozen(candidate.context.nearbyNodes), true);
  assert.equal(Object.isFrozen(candidate.context.matchNameEvidence), true);
  if (candidate.status === "valid") {
    assert.equal(Object.isFrozen(candidate.gradient), true);
    assert.equal(Object.isFrozen(candidate.gradient.colorStops), true);
    assert.equal(Object.isFrozen(candidate.gradient.colorStops[0]), true);
    assert.equal(Object.isFrozen(candidate.gradient.colorStops[0].rgb), true);
    assert.equal(Object.isFrozen(candidate.gradient.alphaStops), true);
  }
}

test("enumerates zero candidates and unique enforcement rejects the empty inventory", () => {
  const source = rifx([leaf("Data", Uint8Array.of(1, 2, 3, 4))]);
  const candidates = enumerateAepGradientCandidates(parseRifx(source));
  assert.deepEqual(candidates, []);
  assert.equal(Object.isFrozen(candidates), true);
  assert.throws(
    () => requireUniqueAepGradientCandidate(candidates),
    /unique.*found 0|found 0.*unique/i,
  );
});

test("enumerates one immutable decoded candidate with bounded structural and exact match-name evidence", () => {
  const source = oneGradientFixture();
  const original = source.slice();
  const doc = parseRifx(source);
  const beforeDocument = documentSnapshot(doc);

  const candidates = enumerateAepGradientCandidates(doc, {
    maxContextNodes: 8,
    maxEvidenceBytes: 512,
    maxMatchNameEvidence: 8,
  });

  assert.equal(candidates.length, 1);
  const candidate = candidates[0];
  assert.equal(candidate.sourceOrder, 0);
  assert.equal(candidate.status, "valid");
  assert.equal(candidate.list.id, "LIST");
  assert.equal(candidate.list.formType, "GCky");
  assert.equal(candidate.list.childCount, 2);
  assert.equal(candidate.utf8Count, 1);
  assert.equal(candidate.utf8Candidates.length, 1);
  assert.equal(candidate.utf8Candidates[0].id, "Utf8");
  assert.equal(candidate.utf8?.id, "Utf8");
  assert.ok(candidate.list.span.headerStart < candidate.utf8!.span.headerStart);
  assert.deepEqual(candidate.gradient, {
    schemaVersion: 1,
    colorStops: [
      { offset: 0, midpoint: 0.25, rgb: [1, 0, -0.25], extra: 1 },
      { offset: 1, midpoint: 0.75, rgb: [0, 0.5, 2], extra: 1 },
    ],
    alphaStops: [
      { offset: 0, midpoint: Math.fround(0.4), alpha: 1 },
      { offset: 1, midpoint: Math.fround(0.6), alpha: 0.25 },
    ],
  });
  assert.deepEqual(
    candidate.context.matchNameEvidence.map((evidence) => evidence.matchName),
    ["ADBE Vector Graphic - G-Fill", "ADBE Vector Grad Colors"],
  );
  assert.equal(
    candidate.context.matchNameEvidence.some((evidence) => String(evidence.matchName) === "Gradient Fill 1"),
    false,
    "display names are not targeting evidence",
  );
  assert.ok(candidate.context.nearbyNodes.length <= 8);
  assert.ok(candidate.context.scannedEvidenceBytes <= 512);
  assert.deepEqual(candidate.context.ancestors.map((node) => node.formType), ["Egg!", "Layr"]);
  assert.equal(candidate.context.nearbyNodes.some((node) => node.id === "MNam"), true);
  assert.equal(candidate.context.nearbyNodes.some((node) => node.id === "Utf8"), true);
  assert.equal(requireUniqueAepGradientCandidate(candidates), candidate);
  assertDeeplyFrozenCandidate(candidate);

  assert.deepEqual(source, original, "inventory must not mutate input bytes");
  assert.equal(doc.source, source);
  assert.equal(documentSnapshot(doc), beforeDocument, "inventory must not mutate the RiffDocument tree");
  assert.throws(() => {
    (candidate.list.span as { headerStart: number }).headerStart = 999;
  }, TypeError);
  assert.throws(() => {
    if (candidate.status === "valid") {
      (candidate.gradient.colorStops[0].rgb as [number, number, number])[0] = 999;
    }
  }, TypeError);
});

test("candidate order is deterministic source order and unique mode rejects multiple candidates", () => {
  const source = rifx([
    gcky(leaf("Utf8", validPayload)),
    leaf("Gap!", Uint8Array.of(1, 2)),
    gcky(leaf("Utf8", validPayload)),
    gcky(leaf("Utf8", validPayload)),
  ]);
  const first = enumerateAepGradientCandidates(parseRifx(source));
  const second = enumerateAepGradientCandidates(parseRifx(source));
  assert.equal(first.length, 3);
  assert.deepEqual(first, second);
  assert.deepEqual(first.map((candidate) => candidate.sourceOrder), [0, 1, 2]);
  assert.equal(first.every((candidate) => candidate.status === "valid"), true);
  assert.equal(
    first.every((candidate, index) => index === 0 || first[index - 1].list.span.headerStart < candidate.list.span.headerStart),
    true,
  );
  assert.throws(
    () => requireUniqueAepGradientCandidate(first),
    /unique.*found 3|found 3.*unique/i,
  );
});

test("malformed payloads and missing Utf8 children are inventoried but rejected by unique mode", () => {
  const malformedXml = enumerateAepGradientCandidates(parseRifx(rifx([
    gcky(leaf("Utf8", "<prop.map version='4'>broken")),
  ])));
  assert.equal(malformedXml.length, 1);
  assert.equal(malformedXml[0].status, "malformed");
  assert.match(malformedXml[0].error, /XML|closing|truncated/i);
  assert.equal(malformedXml[0].gradient, null);
  assert.throws(
    () => requireUniqueAepGradientCandidate(malformedXml),
    /malformed/i,
  );

  const missingUtf8 = enumerateAepGradientCandidates(parseRifx(rifx([
    gcky(leaf("Data", validPayload)),
  ])));
  assert.equal(missingUtf8[0].status, "malformed");
  assert.equal(missingUtf8[0].utf8Count, 0);
  assert.match(missingUtf8[0].error, /Utf8/i);
  assert.throws(() => requireUniqueAepGradientCandidate(missingUtf8), /malformed|Utf8/i);
});

test("multiple or nested Utf8/GCky structures are marked structurally ambiguous", () => {
  const direct = enumerateAepGradientCandidates(parseRifx(rifx([
    gcky(leaf("Utf8", validPayload), leaf("Utf8", validPayload)),
  ])));
  assert.equal(direct.length, 1);
  assert.equal(direct[0].status, "ambiguous");
  assert.equal(direct[0].utf8Count, 2);
  assert.equal(direct[0].utf8Candidates.length, 2);
  assert.match(direct[0].error, /ambiguous|Utf8/i);
  assert.throws(() => requireUniqueAepGradientCandidate(direct), /ambiguous/i);

  const nested = enumerateAepGradientCandidates(parseRifx(rifx([
    gcky(
      leaf("Utf8", validPayload),
      { id: "LIST", formType: "Nest", children: [gcky(leaf("Utf8", validPayload))] },
    ),
  ])));
  assert.equal(nested.length, 2);
  assert.equal(nested[0].status, "ambiguous");
  assert.match(nested[0].error, /nested|ambiguous/i);
  assert.equal(nested[1].status, "valid");
  assert.throws(() => requireUniqueAepGradientCandidate(nested), /found 2|unique/i);
});

test("structural context and evidence scans enforce explicit hard bounds", () => {
  const neighbors = Array.from({ length: 20 }, (_, index) =>
    leaf(`N${index.toString().padStart(3, "0")}`.slice(0, 4), `ADBE Vector Graphic - G-Stroke ${"x".repeat(80)}`));
  const source = rifx([...neighbors, gcky(leaf("Utf8", validPayload)), ...neighbors]);
  const candidates = enumerateAepGradientCandidates(parseRifx(source), {
    maxContextNodes: 4,
    maxEvidenceBytes: 32,
    maxMatchNameEvidence: 1,
  });
  assert.equal(candidates.length, 1);
  assert.ok(candidates[0].context.nearbyNodes.length <= 4);
  assert.ok(candidates[0].context.scannedEvidenceBytes <= 32);
  assert.ok(candidates[0].context.matchNameEvidence.length <= 1);
  assert.equal(candidates[0].context.truncated, true);

  const doc = parseRifx(source);
  assert.throws(() => enumerateAepGradientCandidates(doc, { maxContextNodes: 0 }), /maxContextNodes/i);
  assert.throws(() => enumerateAepGradientCandidates(doc, { maxEvidenceBytes: 2_000_000 }), /maxEvidenceBytes/i);
  assert.throws(() => enumerateAepGradientCandidates(doc, { maxMatchNameEvidence: -1 }), /maxMatchNameEvidence/i);
});

test("inspect CLI emits path-independent deterministic pretty JSON with file and payload SHA-256", () => {
  const root = mkdtempSync(join(tmpdir(), "ae-native-gradient-inspect-"));
  try {
    const source = oneGradientFixture();
    const firstPath = join(root, "first.aep");
    const secondPath = join(root, "second.aep");
    writeFileSync(firstPath, source);
    writeFileSync(secondPath, source);

    const first = spawnSync(NODE, [INSPECT, "inspect", firstPath], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    const second = spawnSync(NODE, [INSPECT, "inspect", secondPath], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    assert.equal(first.status, 0, first.stderr);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(first.stdout, second.stdout, "normalized output must not depend on input path");
    assert.equal(first.stdout.endsWith("\n"), true);
    assert.match(first.stdout, /^\{\n  "schemaVersion": 1,/);

    const report = JSON.parse(first.stdout) as {
      file: { byteLength: number; sha256: string };
      candidates: Array<{
        status: string;
        payloads: Array<{ sha256: string }>;
      }>;
      uniqueProof?: unknown;
    };
    assert.deepEqual(report.file, {
      byteLength: source.byteLength,
      sha256: createHash("sha256").update(source).digest("hex"),
    });
    assert.equal(report.candidates.length, 1);
    assert.equal(report.candidates[0].status, "valid");
    assert.deepEqual(report.candidates[0].payloads, [{
      sha256: createHash("sha256").update(validPayload).digest("hex"),
    }]);
    assert.equal(report.uniqueProof, undefined);

    const unique = spawnSync(NODE, [INSPECT, "inspect", "--unique", firstPath], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    assert.equal(unique.status, 0, unique.stderr);
    const uniqueReport = JSON.parse(unique.stdout) as {
      uniqueProof: { passed: boolean; sourceOrder: number };
    };
    assert.deepEqual(uniqueReport.uniqueProof, { passed: true, sourceOrder: 0 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("inspect CLI unique proof and strict argument parser fail closed", () => {
  const root = mkdtempSync(join(tmpdir(), "ae-native-gradient-inspect-fail-"));
  try {
    const cases: Array<{ name: string; bytes: Uint8Array; diagnostic: RegExp }> = [
      { name: "zero", bytes: rifx([leaf("Data", "none")]), diagnostic: /found 0|unique/i },
      {
        name: "multiple",
        bytes: rifx([gcky(leaf("Utf8", validPayload)), gcky(leaf("Utf8", validPayload))]),
        diagnostic: /found 2|unique/i,
      },
      {
        name: "malformed",
        bytes: rifx([gcky(leaf("Utf8", "not XML"))]),
        diagnostic: /malformed|XML/i,
      },
      {
        name: "ambiguous",
        bytes: rifx([gcky(leaf("Utf8", validPayload), leaf("Utf8", validPayload))]),
        diagnostic: /ambiguous/i,
      },
    ];
    for (const fixture of cases) {
      const input = join(root, `${fixture.name}.aep`);
      writeFileSync(input, fixture.bytes);
      const result = spawnSync(NODE, [INSPECT, "inspect", "--unique", input], {
        cwd: REPO_ROOT,
        encoding: "utf8",
      });
      assert.notEqual(result.status, 0, `${fixture.name} unexpectedly passed`);
      assert.match(result.stderr, fixture.diagnostic);
      assert.equal(result.stdout, "");
    }

    const unknown = spawnSync(NODE, [INSPECT, "inspect", "--write", "nope.aep"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    assert.notEqual(unknown.status, 0);
    assert.match(unknown.stderr, /unknown option|usage/i);

    const missing = spawnSync(NODE, [INSPECT, "inspect"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /input|usage/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("inspect CLI rejects non-regular inputs before attempting an unbounded read", {
  skip: process.platform === "win32" ? "requires a POSIX character device" : false,
}, () => {
  const result = spawnSync(NODE, [INSPECT, "inspect", "/dev/zero"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 2_000,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /regular file/i);
});

test("inspect CLI rejects FIFOs before a blocking open", {
  skip: process.platform === "win32" ? "requires POSIX mkfifo" : false,
}, () => {
  const root = mkdtempSync(join(tmpdir(), "ae-native-gradient-inspect-fifo-"));
  const input = join(root, "input.aep");
  try {
    const created = spawnSync("mkfifo", [input], { encoding: "utf8" });
    assert.equal(created.status, 0, created.stderr);
    const result = spawnSync(NODE, [INSPECT, "inspect", input], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 2_000,
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /regular file/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("inspect CLI rejects oversized regular files before allocation", () => {
  const root = mkdtempSync(join(tmpdir(), "ae-native-gradient-inspect-limit-"));
  const input = join(root, "oversized.aep");
  const descriptor = openSync(input, "w");
  try {
    ftruncateSync(descriptor, 256 * 1024 * 1024 + 1);
  } finally {
    closeSync(descriptor);
  }
  try {
    const result = spawnSync(NODE, [INSPECT, "inspect", input], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 2_000,
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /byte limit/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
