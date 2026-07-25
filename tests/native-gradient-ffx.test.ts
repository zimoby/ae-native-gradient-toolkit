import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  parseGradientUtf8Payload,
  serializeGradientUtf8Payload,
  validateGeneratedGradient,
} from "../src/gcky-gradient.ts";
import {
  enumerateAepGradientCandidates,
  requireUniqueAepGradientCandidate,
} from "../src/aep-gradient-inventory.ts";
import {
  findSingleGradientUtf8,
  generateGradientFfx,
} from "../src/ffx-gradient.ts";
import type { NativeGradient } from "../src/native-gradient-types.ts";
import {
  parseRifx,
  replaceLeafPayload,
  type RiffDocument,
} from "../src/riff-rifx.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const CLI = join(ROOT, "bin/ae-native-gradient.mjs");
const NODE = process.execPath;
const encoder = new TextEncoder();

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function template(kind: "fill" | "stroke"): Uint8Array {
  return new Uint8Array(readFileSync(`${ROOT}fixtures/native-gradient/${kind}-template.ffx`));
}

function expected(kind: "fill" | "stroke"): NativeGradient {
  return JSON.parse(readFileSync(
    `${ROOT}tests/fixtures/native-gradient/${kind}-template.expected.json`,
    "utf8",
  )).candidate.gradient as NativeGradient;
}

function sampleGradient(count: 2 | 3 | 8): NativeGradient {
  const colorStops = Array.from({ length: count }, (_, index) => ({
    offset: index / (count - 1),
    midpoint: 0.17 + index * 0.03,
    rgb: [
      index / 7,
      1 - index / 9,
      (index + 1) / 11,
    ] as [number, number, number],
    extra: 1 - index / 13,
  }));
  const alphaStops = Array.from({ length: count }, (_, index) => ({
    offset: index / (count - 1),
    midpoint: 0.23 + index * 0.02,
    alpha: 1 - index / 10,
  }));
  return { schemaVersion: 1, colorStops, alphaStops };
}

function writeFourCC(bytes: Uint8Array, offset: number, value: string): void {
  assert.equal(value.length, 4);
  for (let index = 0; index < 4; index += 1) bytes[offset + index] = value.charCodeAt(index);
}

function uint32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, false);
  return bytes;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.byteLength, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function findBytes(haystack: Uint8Array, needle: Uint8Array, limit = haystack.byteLength): number {
  for (let offset = 0; offset + needle.byteLength <= limit; offset += 1) {
    let matches = true;
    for (let index = 0; index < needle.byteLength; index += 1) {
      if (haystack[offset + index] !== needle[index]) {
        matches = false;
        break;
      }
    }
    if (matches) return offset;
  }
  return -1;
}

function chunk(id: string, payload: Uint8Array): Uint8Array {
  return concat([
    encoder.encode(id),
    uint32(payload.byteLength),
    payload,
    ...(payload.byteLength % 2 === 1 ? [new Uint8Array([0])] : []),
  ]);
}

function list(formType: string, children: readonly Uint8Array[]): Uint8Array {
  return chunk("LIST", concat([encoder.encode(formType), ...children]));
}

function rifx(formType: string, children: readonly Uint8Array[]): Uint8Array {
  const payload = concat([encoder.encode(formType), ...children]);
  return concat([encoder.encode("RIFX"), uint32(payload.byteLength), payload]);
}

function syntheticFfx(gckyLists: readonly Uint8Array[]): Uint8Array {
  return rifx("FaFX", [
    chunk("Data", encoder.encode("ADBE Vector Graphic - G-Fill\0ADBE Vector Grad Colors")),
    ...gckyLists,
  ]);
}

function validGcky(): Uint8Array {
  return list("GCky", [chunk("Utf8", serializeGradientUtf8Payload(sampleGradient(2)))]);
}

function gradientCandidate(doc: RiffDocument) {
  return requireUniqueAepGradientCandidate(enumerateAepGradientCandidates(doc));
}

function assertPreserved(
  before: Uint8Array,
  after: Uint8Array,
  expectedGradient: NativeGradient,
): void {
  const oldDoc = parseRifx(before);
  const newDoc = parseRifx(after);
  const oldCandidate = gradientCandidate(oldDoc);
  const newCandidate = gradientCandidate(newDoc);
  const normalized = validateGeneratedGradient(expectedGradient);
  assert.deepEqual(newCandidate.gradient, normalized);

  const oldSpan = oldCandidate.utf8.span;
  const newSpan = newCandidate.utf8.span;
  assert.deepEqual(
    after.subarray(newSpan.dataStart, newSpan.dataEnd),
    serializeGradientUtf8Payload(expectedGradient),
  );
  assert.deepEqual(
    after.subarray(newSpan.paddedEnd),
    before.subarray(oldSpan.paddedEnd),
  );
  assert.deepEqual(
    after.subarray(newDoc.trailerStart),
    before.subarray(oldDoc.trailerStart),
  );
}

test("owned Fill and Stroke templates match frozen models and expose one kind-correct Utf8 target", () => {
  for (const kind of ["fill", "stroke"] as const) {
    const bytes = template(kind);
    const doc = parseRifx(bytes);
    assert.equal(doc.root.formType, "FaFX");
    const utf8 = findSingleGradientUtf8(doc, kind);
    assert.equal(utf8.id, "Utf8");
    assert.deepEqual(
      parseGradientUtf8Payload(bytes.subarray(utf8.span.dataStart, utf8.span.dataEnd)),
      expected(kind),
    );
  }
});

test("generates deterministic 2-, 3-, and 8-stop Fill and Stroke presets with exact structural preservation", () => {
  for (const kind of ["fill", "stroke"] as const) {
    for (const count of [2, 3, 8] as const) {
      const source = template(kind);
      const snapshot = source.slice();
      const gradient = sampleGradient(count);
      const first = generateGradientFfx(source, kind, gradient);
      const second = generateGradientFfx(source, kind, gradient);

      assert.deepEqual(source, snapshot, "generator must not mutate its template input");
      assert.deepEqual(first.bytes, second.bytes, "same inputs must produce identical bytes");
      assert.deepEqual(first.report, second.report, "same inputs must produce identical reports");
      assert.equal(first.report.schemaVersion, 1);
      assert.equal(first.report.kind, kind);
      assert.equal(first.report.rootFormType, "FaFX");
      assert.equal(first.report.verification.targetHeaderIdentity, true);
      assert.equal(first.report.verification.prefixExceptSizeFields, true);
      assert.equal(first.report.verification.outputGradient, true);
      assert.equal(first.report.verification.trailer.verified, true);
      assert.equal(first.report.patch.unchangedSuffix.verified, true);
      assert.equal(first.report.kindEvidence.expectedCount, 1);
      assert.equal(first.report.kindEvidence.oppositeCount, 0);
      assert.equal(first.report.kindEvidence.colorsCount, 1);
      assert.deepEqual(first.report.gradient, validateGeneratedGradient(gradient));

      const delta = first.report.payload.newPaddedByteLength - first.report.payload.oldPaddedByteLength;
      assert.equal(first.report.payload.paddedDelta, delta);
      for (const sizePatch of first.report.patch.ancestorSizePatches) {
        assert.equal(sizePatch.newSize, sizePatch.oldSize + delta);
      }

      const allowedSizeBytes = new Set<number>([
        ...first.report.patch.ancestorSizePatches.flatMap((entry) => [0, 1, 2, 3]
          .map((deltaByte) => entry.sizeFieldStart + deltaByte)),
        ...[0, 1, 2, 3].map((deltaByte) => first.report.patch.targetOldSpan.sizeFieldStart + deltaByte),
      ]);
      for (let index = 0; index < first.report.patch.targetOldSpan.dataStart; index += 1) {
        if (!allowedSizeBytes.has(index)) assert.equal(first.bytes[index], source[index]);
      }
      assert.deepEqual(
        first.bytes.subarray(
          first.report.patch.targetNewSpan.headerStart,
          first.report.patch.targetNewSpan.headerStart + 4,
        ),
        source.subarray(
          first.report.patch.targetOldSpan.headerStart,
          first.report.patch.targetOldSpan.headerStart + 4,
        ),
      );
      assertPreserved(source, first.bytes, gradient);
    }
  }
});

test("rejects wrong-kind and non-FFX templates", () => {
  assert.throws(() => findSingleGradientUtf8(parseRifx(template("fill")), "stroke"), /kind|stroke|G-Stroke/i);
  assert.throws(() => generateGradientFfx(template("stroke"), "fill", sampleGradient(2)), /kind|fill|G-Fill/i);

  const wrongRoot = template("fill").slice();
  writeFourCC(wrongRoot, 8, "Egg!");
  assert.throws(() => generateGradientFfx(wrongRoot, "fill", sampleGradient(2)), /FaFX|form type/i);
});

test("rejects kind evidence that exists only in the opaque RIFX trailer", () => {
  const source = template("fill");
  const doc = parseRifx(source);
  const fill = encoder.encode("ADBE Vector Graphic - G-Fill");
  const colors = encoder.encode("ADBE Vector Grad Colors");
  const fillOffset = findBytes(source, fill, doc.declaredEnd);
  const colorsOffset = findBytes(source, colors, doc.declaredEnd);
  assert.notEqual(fillOffset, -1);
  assert.notEqual(colorsOffset, -1);

  const corrupted = source.slice();
  corrupted[fillOffset] ^= 1;
  corrupted[colorsOffset] ^= 1;
  const trailerOnlyEvidence = concat([corrupted, fill, colors]);
  const parsed = parseRifx(trailerOnlyEvidence);
  assert.equal(parsed.trailerStart, doc.declaredEnd);
  assert.equal(source.byteLength >= parsed.trailerStart, true);
  assert.equal(gradientCandidate(parsed).status, "valid");
  assert.throws(
    () => generateGradientFfx(trailerOnlyEvidence, "fill", sampleGradient(2)),
    /kind evidence mismatch/i,
  );

  const unrelatedEvidence = syntheticFfx([validGcky()]);
  assert.equal(gradientCandidate(parseRifx(unrelatedEvidence)).status, "valid");
  assert.throws(
    () => generateGradientFfx(unrelatedEvidence, "fill", sampleGradient(2)),
    /kind evidence|owner|GCst/i,
  );
});

test("rejects missing, multiple, malformed, and ambiguous gradient candidates", () => {
  const missing = template("fill").slice();
  const missingDoc = parseRifx(missing);
  const candidate = gradientCandidate(missingDoc);
  writeFourCC(missing, candidate.list.span.dataStart, "BAD!");
  assert.throws(() => generateGradientFfx(missing, "fill", sampleGradient(2)), /unique|found 0/i);

  assert.throws(
    () => generateGradientFfx(syntheticFfx([validGcky(), validGcky()]), "fill", sampleGradient(2)),
    /unique|found 2/i,
  );

  const malformedDoc = parseRifx(template("fill"));
  const malformedLeaf = findSingleGradientUtf8(malformedDoc, "fill");
  const malformed = replaceLeafPayload(malformedDoc, malformedLeaf, encoder.encode("not XML")).bytes;
  assert.throws(() => generateGradientFfx(malformed, "fill", sampleGradient(2)), /malformed|XML/i);

  const ambiguous = syntheticFfx([list("GCky", [
    chunk("Utf8", serializeGradientUtf8Payload(sampleGradient(2))),
    chunk("Utf8", serializeGradientUtf8Payload(sampleGradient(2))),
  ])]);
  assert.throws(() => generateGradientFfx(ambiguous, "fill", sampleGradient(2)), /ambiguous|expected one/i);
});

test("CLI help exits successfully without stack traces", () => {
  const cases = [
    { args: ["--help"], usage: /Usage: ae-native-gradient inspect/ },
    { args: ["-h"], usage: /Usage: ae-native-gradient inspect/ },
    { args: ["inspect", "--help"], usage: /Usage: ae-native-gradient inspect/ },
    { args: ["inspect", "-h"], usage: /Usage: ae-native-gradient inspect/ },
    { args: ["generate", "--help"], usage: /Usage: ae-native-gradient generate/ },
    { args: ["generate", "-h"], usage: /Usage: ae-native-gradient generate/ },
  ];

  for (const fixture of cases) {
    const result = spawnSync(NODE, [CLI, ...fixture.args], { cwd: ROOT, encoding: "utf8" });
    assert.equal(result.status, 0, `${fixture.args.join(" ")} failed: ${result.stderr}`);
    assert.match(result.stdout, fixture.usage);
    assert.equal(result.stderr, "");
  }
});

test("generate CLI is explain-only by default and writes atomically only with explicit permission", () => {
  const root = mkdtempSync(join(tmpdir(), "ae-native-gradient-generate-"));
  try {
    const config = join(root, "gradient.json");
    const output = join(root, "generated.ffx");
    writeFileSync(config, `${JSON.stringify(sampleGradient(3), null, 2)}\n`);

    const explain = spawnSync(NODE, [CLI, "generate", "--kind", "fill", "--config", config], {
      cwd: ROOT,
      encoding: "utf8",
    });
    assert.equal(explain.status, 0, explain.stderr);
    const explainReport = JSON.parse(explain.stdout) as {
      command: string;
      kind: string;
      template: { sha256: string };
      config: { sha256: string };
      output: { byteLength: number; sha256: string };
      write: { requested: boolean; completed: boolean };
      structure: { verification: { trailer: { verified: boolean } } };
    };
    assert.equal(explainReport.command, "generate");
    assert.equal(explainReport.kind, "fill");
    assert.equal(explainReport.template.sha256, sha256(template("fill")));
    assert.equal(explainReport.config.sha256, sha256(readFileSync(config)));
    assert.match(explainReport.output.sha256, /^[a-f0-9]{64}$/);
    assert.equal(explainReport.output.byteLength > 0, true);
    assert.deepEqual(explainReport.write, { requested: false, completed: false });
    assert.equal(explainReport.structure.verification.trailer.verified, true);
    assert.equal(existsSync(output), false);

    const write = spawnSync(NODE, [
      CLI,
      "generate",
      "--kind",
      "fill",
      "--config",
      config,
      "--write",
      output,
    ], { cwd: ROOT, encoding: "utf8" });
    assert.equal(write.status, 0, write.stderr);
    const writeReport = JSON.parse(write.stdout) as {
      output: { sha256: string };
      write: { requested: boolean; completed: boolean };
    };
    assert.deepEqual(writeReport.write, { requested: true, completed: true });
    assert.equal(sha256(readFileSync(output)), writeReport.output.sha256);
    assert.equal(gradientCandidate(parseRifx(readFileSync(output))).gradient.colorStops.length, 3);

    const existingBytes = readFileSync(output);
    const refused = spawnSync(NODE, [
      CLI,
      "generate",
      "--kind",
      "fill",
      "--config",
      config,
      "--write",
      output,
    ], { cwd: ROOT, encoding: "utf8" });
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /exists|force/i);
    assert.deepEqual(readFileSync(output), existingBytes);

    writeFileSync(config, `${JSON.stringify(sampleGradient(8), null, 2)}\n`);
    const forced = spawnSync(NODE, [
      CLI,
      "generate",
      "--kind",
      "fill",
      "--config",
      config,
      "--write",
      output,
      "--force",
    ], { cwd: ROOT, encoding: "utf8" });
    assert.equal(forced.status, 0, forced.stderr);
    assert.equal(gradientCandidate(parseRifx(readFileSync(output))).gradient.colorStops.length, 8);
    assert.deepEqual(readdirSync(root).sort(), ["generated.ffx", "gradient.json"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("generate CLI rejects unsafe or invalid config, template, and output inputs without partial writes", () => {
  const root = mkdtempSync(join(tmpdir(), "ae-native-gradient-generate-fail-"));
  try {
    const validConfig = join(root, "valid.json");
    const invalidConfig = join(root, "invalid.json");
    const oversizedConfig = join(root, "oversized.json");
    const output = join(root, "generated.ffx");
    writeFileSync(validConfig, JSON.stringify(sampleGradient(2)));
    writeFileSync(invalidConfig, "{not-json");
    writeFileSync(oversizedConfig, new Uint8Array(1024 * 1024 + 1));

    const cases: Array<{ args: string[]; diagnostic: RegExp }> = [
      {
        args: ["generate", "--kind", "fill", "--config", root, "--write", output],
        diagnostic: /regular file/i,
      },
      {
        args: ["generate", "--kind", "fill", "--config", oversizedConfig, "--write", output],
        diagnostic: /byte limit/i,
      },
      {
        args: ["generate", "--kind", "fill", "--config", invalidConfig, "--write", output],
        diagnostic: /invalid gradient config JSON/i,
      },
      {
        args: [
          "generate",
          "--kind",
          "fill",
          "--config",
          validConfig,
          "--template",
          join(ROOT, "fixtures/native-gradient/stroke-template.ffx"),
          "--write",
          output,
        ],
        diagnostic: /kind evidence|G-Fill/i,
      },
      {
        args: [
          "generate",
          "--kind",
          "fill",
          "--config",
          validConfig,
          "--write",
          validConfig,
          "--force",
        ],
        diagnostic: /must not replace/i,
      },
    ];
    for (const fixture of cases) {
      const result = spawnSync(NODE, [CLI, ...fixture.args], { cwd: ROOT, encoding: "utf8" });
      assert.notEqual(result.status, 0, `${fixture.args.join(" ")} unexpectedly passed`);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, fixture.diagnostic);
      assert.equal(existsSync(output), false);
    }

    const symlinkOutput = join(root, "linked.ffx");
    symlinkSync(validConfig, symlinkOutput);
    const linked = spawnSync(NODE, [
      CLI,
      "generate",
      "--kind",
      "fill",
      "--config",
      validConfig,
      "--write",
      symlinkOutput,
      "--force",
    ], { cwd: ROOT, encoding: "utf8" });
    assert.notEqual(linked.status, 0);
    assert.match(linked.stderr, /non-symlink|regular/i);
    assert.equal(readFileSync(validConfig, "utf8"), JSON.stringify(sampleGradient(2)));

    const configAlias = join(root, "config-alias.json");
    symlinkSync(validConfig, configAlias);
    const aliasedInput = spawnSync(NODE, [
      CLI,
      "generate",
      "--kind",
      "fill",
      "--config",
      configAlias,
      "--write",
      validConfig,
      "--force",
    ], { cwd: ROOT, encoding: "utf8" });
    assert.notEqual(aliasedInput.status, 0);
    assert.match(aliasedInput.stderr, /must not replace/i);
    assert.equal(readFileSync(validConfig, "utf8"), JSON.stringify(sampleGradient(2)));
    assert.deepEqual(
      readdirSync(root).sort(),
      ["config-alias.json", "invalid.json", "linked.ffx", "oversized.json", "valid.json"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
