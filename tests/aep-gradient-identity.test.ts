import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  indexAepNativeGradientTargets,
  readAepProjectFormatVersion,
  resolveAepNativeGradientTarget,
  type AepNativeGradientTargetDescriptor,
} from "../src/aep-gradient-identity.ts";
import type { NativeGradient } from "../src/native-gradient-types.ts";
import { parseRifx, type RiffNode } from "../src/riff-rifx.ts";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const FIXTURE_PATH = join(REPO_ROOT, "tests/fixtures/native-gradient/exact-identity-ae25.aep");
const EXPECTED_PATH = join(REPO_ROOT, "tests/fixtures/native-gradient/exact-identity-ae25.expected.json");

type FrozenTarget = AepNativeGradientTargetDescriptor & {
  gckyHeaderStart: number;
  gradient: NativeGradient;
};

type FrozenExpected = {
  schemaVersion: 1;
  afterEffectsVersion: string;
  projectFormat: number;
  file: { byteLength: number; sha256: string };
  targetCount: number;
  targets: FrozenTarget[];
};

const source = new Uint8Array(readFileSync(FIXTURE_PATH));
const expected = JSON.parse(readFileSync(EXPECTED_PATH, "utf8")) as FrozenExpected;

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function descriptor(target: FrozenTarget): AepNativeGradientTargetDescriptor {
  return {
    compId: target.compId,
    layerId: target.layerId,
    layerIndex: target.layerIndex,
    kind: target.kind,
    propertyIndexPath: target.propertyIndexPath,
    matchNamePath: target.matchNamePath,
  };
}

function writeProjectFormat(value: Uint8Array, format: number): Uint8Array {
  const copy = value.slice();
  const document = parseRifx(copy);
  const head = document.root.children.filter((node) => node.id === "head");
  assert.equal(head.length, 1);
  new DataView(copy.buffer, copy.byteOffset, copy.byteLength).setUint16(head[0].span.dataStart, format, false);
  return copy;
}

function descendants(root: ReturnType<typeof parseRifx>["root"], id: string, formType?: string) {
  const matches = [] as typeof root[];
  const stack = [...root.children].reverse();
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.id === id && (formType === undefined || node.formType === formType)) matches.push(node);
    for (let index = node.children.length - 1; index >= 0; index -= 1) stack.push(node.children[index]);
  }
  return matches;
}

function parentOf(
  root: ReturnType<typeof parseRifx>["root"],
  target: ReturnType<typeof parseRifx>["root"],
) {
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.children.includes(target)) return node;
    for (let index = node.children.length - 1; index >= 0; index -= 1) stack.push(node.children[index]);
  }
  return null;
}

function writeFormType(
  value: Uint8Array,
  node: ReturnType<typeof parseRifx>["root"],
  formType: string,
): Uint8Array {
  assert.equal(formType.length, 4);
  const copy = value.slice();
  for (let index = 0; index < 4; index += 1) copy[node.span.dataStart + index] = formType.charCodeAt(index);
  return copy;
}

function decodeMatchName(value: Uint8Array, node: ReturnType<typeof parseRifx>["root"]): string {
  const bytes = value.subarray(node.span.dataStart, node.span.dataEnd);
  const terminator = bytes.indexOf(0);
  return new TextDecoder().decode(bytes.subarray(0, terminator));
}

function findPropertyRun(
  value: Uint8Array,
  container: ReturnType<typeof parseRifx>["root"],
  matchName: string,
) {
  for (let index = 0; index < container.children.length; index += 1) {
    const name = container.children[index];
    if (name.id !== "tdmn" || decodeMatchName(value, name) !== matchName) continue;
    const list = container.children[index + 1];
    if (list?.id === "LIST") return { name, list };
  }
  return null;
}

function findPropertyRunDescendant(
  value: Uint8Array,
  container: ReturnType<typeof parseRifx>["root"],
  matchName: string,
): { name: ReturnType<typeof parseRifx>["root"]; list: ReturnType<typeof parseRifx>["root"] } | null {
  const direct = findPropertyRun(value, container, matchName);
  if (direct) return direct;
  for (const child of container.children) {
    const nested = findPropertyRunDescendant(value, child, matchName);
    if (nested) return nested;
  }
  return null;
}

function ascii(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function writeU32(value: Uint8Array, offset: number, amount: number): void {
  new DataView(value.buffer, value.byteOffset, value.byteLength).setUint32(offset, amount, false);
}

function encodeChunk(id: string, payload: Uint8Array): Uint8Array {
  const size = new Uint8Array(4);
  writeU32(size, 0, payload.length);
  return concatBytes(
    ascii(id),
    size,
    payload,
    payload.length % 2 === 1 ? Uint8Array.of(0) : new Uint8Array(),
  );
}

function encodeList(formType: string, children: Uint8Array): Uint8Array {
  return encodeChunk("LIST", concatBytes(ascii(formType), children));
}

function encodeEmptyPropertyRun(matchName: string): Uint8Array {
  return concatBytes(
    encodeChunk("tdmn", concatBytes(ascii(matchName), Uint8Array.of(0))),
    encodeList("tdgp", new Uint8Array()),
  );
}

function findAncestors(node: RiffNode, target: RiffNode, path: RiffNode[] = []): RiffNode[] | null {
  if (node === target) return path;
  for (const child of node.children) {
    const found = findAncestors(child, target, [...path, node]);
    if (found) return found;
  }
  return null;
}

function replaceListChildren(
  sourceBytes: Uint8Array,
  documentRoot: RiffNode,
  target: RiffNode,
  children: Uint8Array,
): Uint8Array {
  assert.equal(target.id, "LIST");
  assert.notEqual(target.formType, null);
  const replacement = encodeList(target.formType!, children);
  const removedLength = target.span.paddedEnd - target.span.headerStart;
  const delta = replacement.length - removedLength;
  const output = new Uint8Array(sourceBytes.length + delta);
  output.set(sourceBytes.subarray(0, target.span.headerStart), 0);
  output.set(replacement, target.span.headerStart);
  output.set(sourceBytes.subarray(target.span.paddedEnd), target.span.headerStart + replacement.length);

  const ancestors = findAncestors(documentRoot, target);
  assert.notEqual(ancestors, null);
  for (const ancestor of ancestors!) {
    writeU32(output, ancestor.span.sizeFieldStart, ancestor.declaredSize + delta);
  }
  return output;
}

test("owned AE25 exact-identity fixture matches its frozen hash and project format", () => {
  assert.equal(source.byteLength, expected.file.byteLength);
  assert.equal(sha256(source), expected.file.sha256);
  assert.equal(readAepProjectFormatVersion(parseRifx(source)), expected.projectFormat);
});

test("indexes four immutable exact Fill/Stroke targets and their intended gradients", () => {
  const targets = indexAepNativeGradientTargets(parseRifx(source));
  assert.equal(targets.length, expected.targetCount);
  assert.equal(new Set(targets.map((target) => target.candidate.list.span.headerStart)).size, 4);
  assert.equal(Object.isFrozen(targets), true);

  const actual = targets.map((target) => {
    assert.equal(Object.isFrozen(target), true);
    assert.equal(Object.isFrozen(target.propertyIndexPath), true);
    assert.equal(Object.isFrozen(target.matchNamePath), true);
    assert.equal(target.candidate.status, "valid");
    assert.equal(target.candidate.list.span.headerStart > 0, true);
    if (target.candidate.status !== "valid") throw new Error("fixture candidate must be valid");
    return {
      compId: target.compId,
      layerId: target.layerId,
      layerIndex: target.layerIndex,
      kind: target.kind,
      propertyIndexPath: target.propertyIndexPath,
      matchNamePath: target.matchNamePath,
      gckyHeaderStart: target.candidate.list.span.headerStart,
      gradient: target.candidate.gradient,
    };
  });
  assert.deepEqual(actual, expected.targets);
});

test("exact resolver maps every host descriptor to one target", () => {
  const targets = indexAepNativeGradientTargets(parseRifx(source));
  for (let index = 0; index < expected.targets.length; index += 1) {
    const result = resolveAepNativeGradientTarget(targets, descriptor(expected.targets[index]));
    assert.equal(result.status, "resolved");
    if (result.status !== "resolved") continue;
    assert.equal(result.target.candidate.list.span.headerStart, expected.targets[index].gckyHeaderStart);
  }
});

test("exact resolver rejects every identity mismatch without fallback", () => {
  const targets = indexAepNativeGradientTargets(parseRifx(source));
  const exact = descriptor(expected.targets[0]);
  const mutations: AepNativeGradientTargetDescriptor[] = [
    { ...exact, compId: exact.compId + 1 },
    { ...exact, layerId: exact.layerId + 1 },
    { ...exact, layerIndex: exact.layerIndex + 1 },
    { ...exact, kind: "stroke" },
    { ...exact, propertyIndexPath: [2, 99, 2, 2, 9] },
    { ...exact, propertyIndexPath: [2, 1, 2, 2, 10] },
    { ...exact, matchNamePath: exact.matchNamePath.map((name, index) => index === 1 ? "ADBE Vector Group Wrong" : name) },
  ];
  for (const mutation of mutations) {
    assert.deepEqual(resolveAepNativeGradientTarget(targets, mutation), { status: "none" });
  }
});

test("exact resolver rejects duplicate exact candidates as ambiguous", () => {
  const targets = indexAepNativeGradientTargets(parseRifx(source));
  assert.deepEqual(
    resolveAepNativeGradientTarget([targets[0], targets[0]], descriptor(expected.targets[0])),
    { status: "ambiguous" },
  );
});

test("project formats 93 through 96 use payload indices 9 and 8, while 97 uses 11 and 10", () => {
  for (const format of [93, 94, 95, 96]) {
    const targets = indexAepNativeGradientTargets(parseRifx(writeProjectFormat(source, format)));
    assert.deepEqual(targets.map((target) => target.propertyIndexPath.at(-1)), [9, 8, 9, 8]);
  }
  const format97 = indexAepNativeGradientTargets(parseRifx(writeProjectFormat(source, 97)));
  assert.deepEqual(format97.map((target) => target.propertyIndexPath.at(-1)), [11, 10, 11, 10]);
});

test("unknown AEP project formats fail closed", () => {
  assert.throws(
    () => indexAepNativeGradientTargets(parseRifx(writeProjectFormat(source, 92))),
    /unsupported AEP project format 92/,
  );
});

test("non-comp items and non-shape layers never produce identity targets", () => {
  const nonComp = source.slice();
  const nonCompDocument = parseRifx(nonComp);
  const item = descendants(nonCompDocument.root, "LIST", "Item")[0];
  const itemData = item.children.filter((node) => node.id === "idta");
  assert.equal(itemData.length, 1);
  new DataView(nonComp.buffer, nonComp.byteOffset, nonComp.byteLength)
    .setUint16(itemData[0].span.dataStart, 0, false);
  assert.deepEqual(indexAepNativeGradientTargets(parseRifx(nonComp)), []);

  const nonShape = source.slice();
  const nonShapeDocument = parseRifx(nonShape);
  const layer = descendants(nonShapeDocument.root, "LIST", "Layr")[0];
  const layerData = layer.children.filter((node) => node.id === "ldta");
  assert.equal(layerData.length, 1);
  nonShape[layerData[0].span.dataStart + 131] = 0;
  const targets = indexAepNativeGradientTargets(parseRifx(nonShape));
  assert.equal(targets.length, 2);
  assert.equal(targets.every((target) => target.layerId === expected.targets[2].layerId), true);
});

test("malformed property/store structures fail closed while exact malformed payloads stay indexed", () => {
  const document = parseRifx(source);
  const folds = document.root.children.filter((node) => node.id === "LIST" && node.formType === "Fold");
  assert.equal(folds.length, 1);
  const firstStore = descendants(document.root, "LIST", "GCst")[0];
  const payloadList = parentOf(document.root, firstStore);
  assert.equal(payloadList?.id, "LIST");
  assert.equal(payloadList?.formType, "tdgp");
  const firstGradient = descendants(document.root, "LIST", "GCky")[0];
  const gradientPayloads = firstGradient.children.filter((node) => node.id === "Utf8");
  assert.equal(gradientPayloads.length, 1);

  const remainingOffsets = expected.targets.slice(1).map((target) => target.gckyHeaderStart);
  const malformedFold = indexAepNativeGradientTargets(parseRifx(writeFormType(source, folds[0], "NOPE")));
  assert.deepEqual(malformedFold, []);

  const malformedStore = indexAepNativeGradientTargets(parseRifx(writeFormType(source, firstStore, "NOPE")));
  assert.deepEqual(malformedStore.map((target) => target.candidate.list.span.headerStart), remainingOffsets);

  assert.notEqual(payloadList, null);
  const malformedPayload = indexAepNativeGradientTargets(parseRifx(writeFormType(source, payloadList!, "NOPE")));
  assert.deepEqual(malformedPayload.map((target) => target.candidate.list.span.headerStart), remainingOffsets);

  const malformedGradient = source.slice();
  malformedGradient[gradientPayloads[0].span.dataStart] = "!".charCodeAt(0);
  const malformedTargets = indexAepNativeGradientTargets(parseRifx(malformedGradient));
  assert.deepEqual(
    malformedTargets.map((target) => target.candidate.list.span.headerStart),
    expected.targets.map((target) => target.gckyHeaderStart),
  );
  assert.equal(malformedTargets[0].candidate.status, "malformed");
});

test("existing AE26 format-97 Fill and Stroke fixtures retain exact identity", () => {
  const fixtures: Array<[string, AepNativeGradientTargetDescriptor]> = [
    ["scratch-fill.aep", {
      compId: 1,
      layerId: 13,
      layerIndex: 1,
      kind: "fill",
      propertyIndexPath: [2, 1, 2, 2, 11],
      matchNamePath: ["ADBE Root Vectors Group", "ADBE Vector Group", "ADBE Vectors Group", "ADBE Vector Graphic - G-Fill", "ADBE Vector Grad Colors"],
    }],
    ["scratch-stroke.aep", {
      compId: 1,
      layerId: 15,
      layerIndex: 1,
      kind: "stroke",
      propertyIndexPath: [2, 1, 2, 2, 10],
      matchNamePath: ["ADBE Root Vectors Group", "ADBE Vector Group", "ADBE Vectors Group", "ADBE Vector Graphic - G-Stroke", "ADBE Vector Grad Colors"],
    }],
  ];
  for (const [name, exact] of fixtures) {
    const fixture = new Uint8Array(readFileSync(join(REPO_ROOT, `tests/fixtures/native-gradient/${name}`)));
    const targets = indexAepNativeGradientTargets(parseRifx(fixture));
    assert.equal(targets.length, 1);
    assert.equal(resolveAepNativeGradientTarget(targets, exact).status, "resolved");
  }
});

test("indexes serialized Fill and Stroke stored directly at root property index 8", () => {
  const cases = [
    ["scratch-fill.aep", "fill", "ADBE Vector Graphic - G-Fill", 11],
    ["scratch-stroke.aep", "stroke", "ADBE Vector Graphic - G-Stroke", 10],
  ] as const;
  for (const [name, kind, gradientMatchName, payloadIndex] of cases) {
    const fixture = new Uint8Array(readFileSync(join(REPO_ROOT, `tests/fixtures/native-gradient/${name}`)));
    const document = parseRifx(fixture);
    const originalTarget = indexAepNativeGradientTargets(document)[0];
    assert.notEqual(originalTarget, undefined);
    const layer = descendants(document.root, "LIST", "Layr")[0];
    const propertyRoot = layer.children.find((node) => node.id === "LIST" && node.formType === "tdgp");
    assert.notEqual(propertyRoot, undefined);
    const rootRun = findPropertyRun(fixture, propertyRoot!, "ADBE Root Vectors Group");
    assert.notEqual(rootRun, null);
    const gradientRun = findPropertyRunDescendant(fixture, rootRun!.list, gradientMatchName);
    assert.notEqual(gradientRun, null);
    assert.equal(gradientRun!.name.span.paddedEnd, gradientRun!.list.span.headerStart);

    const precedingRuns = Array.from(
      { length: 7 },
      (_, index) => encodeEmptyPropertyRun(`Native Gradient Test ${index + 1}`),
    );
    const exactGradientRun = fixture.subarray(
      gradientRun!.name.span.headerStart,
      gradientRun!.list.span.paddedEnd,
    );
    const transformed = replaceListChildren(
      fixture,
      document.root,
      rootRun!.list,
      concatBytes(...precedingRuns, exactGradientRun),
    );
    const reparsed = parseRifx(transformed);
    const targets = indexAepNativeGradientTargets(reparsed);

    assert.equal(targets.length, 1);
    assert.equal(targets[0].kind, kind);
    assert.deepEqual(targets[0].propertyIndexPath, [2, 8, payloadIndex]);
    assert.deepEqual(targets[0].matchNamePath, [
      "ADBE Root Vectors Group",
      gradientMatchName,
      "ADBE Vector Grad Colors",
    ]);
    assert.equal(targets[0].compId, originalTarget.compId);
    assert.equal(targets[0].layerId, originalTarget.layerId);
    assert.equal(resolveAepNativeGradientTarget(targets, {
      compId: targets[0].compId,
      layerId: targets[0].layerId,
      layerIndex: targets[0].layerIndex,
      kind,
      propertyIndexPath: [2, 8, payloadIndex],
      matchNamePath: ["ADBE Root Vectors Group", gradientMatchName, "ADBE Vector Grad Colors"],
    }).status, "resolved");
  }
});
