import {
  enumerateAepGradientCandidates,
  requireUniqueAepGradientCandidate,
} from "./aep-gradient-inventory.ts";
import {
  parseGradientUtf8Payload,
  serializeGradientUtf8Payload,
} from "./gcky-gradient.ts";
import type { NativeGradient } from "./native-gradient-types.ts";
import {
  findListsByFormType,
  parseRifx,
  replaceLeafPayload,
  type RiffDocument,
  type RiffNode,
  type SpanPatchReport,
} from "./riff-rifx.ts";

const MATCH_NAMES = Object.freeze({
  fill: "ADBE Vector Graphic - G-Fill",
  stroke: "ADBE Vector Graphic - G-Stroke",
  colors: "ADBE Vector Grad Colors",
} as const);
const MATCH_NAME_BYTES = Object.freeze({
  fill: new TextEncoder().encode(MATCH_NAMES.fill),
  stroke: new TextEncoder().encode(MATCH_NAMES.stroke),
  colors: new TextEncoder().encode(MATCH_NAMES.colors),
});
const MAX_KIND_EVIDENCE_NODES = 128;
const MAX_KIND_EVIDENCE_BYTES = 1024 * 1024;

export type GradientFfxKind = "fill" | "stroke";

export type GradientFfxStructuralReport = Readonly<{
  schemaVersion: 1;
  kind: GradientFfxKind;
  rootFormType: "FaFX";
  kindEvidence: Readonly<{
    expectedMatchName: string;
    expectedCount: 1;
    oppositeMatchName: string;
    oppositeCount: 0;
    colorsCount: 1;
  }>;
  payload: Readonly<{
    oldByteLength: number;
    newByteLength: number;
    oldPaddedByteLength: number;
    newPaddedByteLength: number;
    paddedDelta: number;
  }>;
  gradient: NativeGradient;
  patch: SpanPatchReport;
  verification: Readonly<{
    targetHeaderIdentity: true;
    prefixExceptSizeFields: true;
    outputGradient: true;
    trailer: Readonly<{
      oldStart: number;
      newStart: number;
      byteLength: number;
      verified: true;
    }>;
  }>;
}>;

type TargetEvidence = {
  utf8: RiffNode;
  expectedMatchName: string;
  expectedCount: 1;
  oppositeMatchName: string;
  oppositeCount: 0;
  colorsCount: 1;
};

function countBytes(
  source: Uint8Array,
  start: number,
  end: number,
  needle: Uint8Array,
): number {
  let count = 0;
  for (let offset = start; offset + needle.byteLength <= end; offset += 1) {
    let matches = true;
    for (let index = 0; index < needle.byteLength; index += 1) {
      if (source[offset + index] !== needle[index]) {
        matches = false;
        break;
      }
    }
    if (matches) count += 1;
  }
  return count;
}

function findParent(root: RiffNode, target: RiffNode): RiffNode | null {
  const stack: RiffNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    for (const child of node.children) {
      if (child === target) return node;
      stack.push(child);
    }
  }
  return null;
}

type KindEvidenceCounts = {
  expected: number;
  opposite: number;
  colors: number;
};

function countKindEvidence(
  source: Uint8Array,
  root: RiffNode,
  kind: GradientFfxKind,
  opposite: GradientFfxKind,
): KindEvidenceCounts {
  const counts = { expected: 0, opposite: 0, colors: 0 };
  const stack: RiffNode[] = [root];
  let nodeCount = 0;
  let scannedBytes = 0;
  while (stack.length > 0) {
    const node = stack.pop()!;
    nodeCount += 1;
    if (nodeCount > MAX_KIND_EVIDENCE_NODES) {
      throw new Error(`FFX kind evidence exceeds ${MAX_KIND_EVIDENCE_NODES} parsed nodes`);
    }
    if (node.children.length !== 0 || node.formType !== null) {
      for (let index = node.children.length - 1; index >= 0; index -= 1) stack.push(node.children[index]);
      continue;
    }
    scannedBytes += node.declaredSize;
    if (scannedBytes > MAX_KIND_EVIDENCE_BYTES) {
      throw new Error(`FFX kind evidence exceeds ${MAX_KIND_EVIDENCE_BYTES} parsed leaf bytes`);
    }
    counts.expected += countBytes(source, node.span.dataStart, node.span.dataEnd, MATCH_NAME_BYTES[kind]);
    counts.opposite += countBytes(source, node.span.dataStart, node.span.dataEnd, MATCH_NAME_BYTES[opposite]);
    counts.colors += countBytes(source, node.span.dataStart, node.span.dataEnd, MATCH_NAME_BYTES.colors);
  }
  return counts;
}

function bytesEqual(
  first: Uint8Array,
  firstStart: number,
  second: Uint8Array,
  secondStart: number,
  length: number,
): boolean {
  if (
    firstStart < 0
    || secondStart < 0
    || length < 0
    || firstStart + length > first.byteLength
    || secondStart + length > second.byteLength
  ) return false;
  for (let index = 0; index < length; index += 1) {
    if (first[firstStart + index] !== second[secondStart + index]) return false;
  }
  return true;
}

function gradientsEqual(first: NativeGradient, second: NativeGradient): boolean {
  if (
    first.schemaVersion !== second.schemaVersion
    || first.colorStops.length !== second.colorStops.length
    || first.alphaStops.length !== second.alphaStops.length
  ) return false;
  for (let index = 0; index < first.colorStops.length; index += 1) {
    const a = first.colorStops[index];
    const b = second.colorStops[index];
    if (
      a.offset !== b.offset
      || a.midpoint !== b.midpoint
      || a.extra !== b.extra
      || a.rgb[0] !== b.rgb[0]
      || a.rgb[1] !== b.rgb[1]
      || a.rgb[2] !== b.rgb[2]
    ) return false;
  }
  for (let index = 0; index < first.alphaStops.length; index += 1) {
    const a = first.alphaStops[index];
    const b = second.alphaStops[index];
    if (a.offset !== b.offset || a.midpoint !== b.midpoint || a.alpha !== b.alpha) return false;
  }
  return true;
}

function inspectTarget(doc: RiffDocument, kind: GradientFfxKind): TargetEvidence {
  if (doc.root.formType !== "FaFX") {
    throw new Error(`FFX template root form type must be FaFX, received ${doc.root.formType ?? "none"}`);
  }

  const candidate = requireUniqueAepGradientCandidate(enumerateAepGradientCandidates(doc));
  const lists = findListsByFormType(doc, "GCky");
  const list = lists.find((node) => node.span.headerStart === candidate.list.span.headerStart);
  if (list === undefined) throw new Error("internal FFX target lookup failed for the unique GCky list");
  const utf8 = list.children.find((node) => node.span.headerStart === candidate.utf8.span.headerStart);
  if (utf8 === undefined || utf8.id !== "Utf8" || utf8.children.length !== 0 || utf8.formType !== null) {
    throw new Error("internal FFX target lookup failed for the unique Utf8 leaf");
  }

  const opposite: GradientFfxKind = kind === "fill" ? "stroke" : "fill";
  const state = findParent(doc.root, list);
  const owner = state === null ? null : findParent(doc.root, state);
  if (
    state === null
    || state.id !== "LIST"
    || state.formType !== "GCst"
    || owner === null
    || owner.id !== "LIST"
    || owner.formType !== "besc"
  ) {
    throw new Error("FFX template kind evidence owner must be FaFX/besc with GCst/GCky payload");
  }

  const documentEvidence = countKindEvidence(doc.source, doc.root, kind, opposite);
  const identityGroups = owner.children.filter((node) => {
    if (node.id !== "LIST" || node.formType !== "tdsp") return false;
    const evidence = countKindEvidence(doc.source, node, kind, opposite);
    return evidence.expected === 1 && evidence.opposite === 0 && evidence.colors === 1;
  });
  const expectedCount = documentEvidence.expected;
  const oppositeCount = documentEvidence.opposite;
  const colorsCount = documentEvidence.colors;
  if (expectedCount !== 1 || oppositeCount !== 0 || colorsCount !== 1 || identityGroups.length !== 1) {
    throw new Error(
      `FFX template kind evidence mismatch for ${kind}: `
      + `${MATCH_NAMES[kind]}=${expectedCount}, ${MATCH_NAMES[opposite]}=${oppositeCount}, `
      + `${MATCH_NAMES.colors}=${colorsCount}, identityGroups=${identityGroups.length}`,
    );
  }

  return {
    utf8,
    expectedMatchName: MATCH_NAMES[kind],
    expectedCount: 1,
    oppositeMatchName: MATCH_NAMES[opposite],
    oppositeCount: 0,
    colorsCount: 1,
  };
}

function verifyPrefix(
  before: Uint8Array,
  after: Uint8Array,
  patch: SpanPatchReport,
): boolean {
  const allowed = new Set<number>();
  for (const sizePatch of patch.ancestorSizePatches) {
    for (let index = 0; index < 4; index += 1) allowed.add(sizePatch.sizeFieldStart + index);
  }
  for (let index = 0; index < 4; index += 1) {
    allowed.add(patch.targetOldSpan.sizeFieldStart + index);
  }
  for (let index = 0; index < patch.targetOldSpan.dataStart; index += 1) {
    if (!allowed.has(index) && before[index] !== after[index]) return false;
  }
  return true;
}

export function findSingleGradientUtf8(
  doc: RiffDocument,
  kind: GradientFfxKind,
): RiffNode {
  return inspectTarget(doc, kind).utf8;
}

export function generateGradientFfx(
  template: Uint8Array,
  kind: GradientFfxKind,
  gradient: NativeGradient,
): { bytes: Uint8Array; report: GradientFfxStructuralReport } {
  const doc = parseRifx(template);
  const target = inspectTarget(doc, kind);
  const replacement = serializeGradientUtf8Payload(gradient);
  const normalizedGradient = parseGradientUtf8Payload(replacement);
  const patched = replaceLeafPayload(doc, target.utf8, replacement);
  const outputDoc = parseRifx(patched.bytes);
  const outputTarget = inspectTarget(outputDoc, kind);
  const outputGradient = parseGradientUtf8Payload(
    patched.bytes.subarray(outputTarget.utf8.span.dataStart, outputTarget.utf8.span.dataEnd),
  );
  if (!gradientsEqual(outputGradient, normalizedGradient)) {
    throw new Error("internal FFX generation failure: output gradient verification failed");
  }

  const targetHeaderIdentity = bytesEqual(
    template,
    patched.report.targetOldSpan.headerStart,
    patched.bytes,
    patched.report.targetNewSpan.headerStart,
    4,
  );
  if (!targetHeaderIdentity) {
    throw new Error("internal FFX generation failure: target header identity changed");
  }
  if (!verifyPrefix(template, patched.bytes, patched.report)) {
    throw new Error("internal FFX generation failure: prefix changed outside declared size fields");
  }

  const oldTrailerByteLength = template.byteLength - doc.trailerStart;
  const newTrailerByteLength = patched.bytes.byteLength - outputDoc.trailerStart;
  const trailerVerified = oldTrailerByteLength === newTrailerByteLength && bytesEqual(
    template,
    doc.trailerStart,
    patched.bytes,
    outputDoc.trailerStart,
    oldTrailerByteLength,
  );
  if (!trailerVerified) {
    throw new Error("internal FFX generation failure: trailer verification failed");
  }

  const oldPaddedByteLength = target.utf8.span.paddedEnd - target.utf8.span.dataStart;
  const newPaddedByteLength = outputTarget.utf8.span.paddedEnd - outputTarget.utf8.span.dataStart;
  const report: GradientFfxStructuralReport = Object.freeze({
    schemaVersion: 1 as const,
    kind,
    rootFormType: "FaFX" as const,
    kindEvidence: Object.freeze({
      expectedMatchName: target.expectedMatchName,
      expectedCount: target.expectedCount,
      oppositeMatchName: target.oppositeMatchName,
      oppositeCount: target.oppositeCount,
      colorsCount: target.colorsCount,
    }),
    payload: Object.freeze({
      oldByteLength: target.utf8.declaredSize,
      newByteLength: outputTarget.utf8.declaredSize,
      oldPaddedByteLength,
      newPaddedByteLength,
      paddedDelta: newPaddedByteLength - oldPaddedByteLength,
    }),
    gradient: normalizedGradient,
    patch: patched.report,
    verification: Object.freeze({
      targetHeaderIdentity: true as const,
      prefixExceptSizeFields: true as const,
      outputGradient: true as const,
      trailer: Object.freeze({
        oldStart: doc.trailerStart,
        newStart: outputDoc.trailerStart,
        byteLength: oldTrailerByteLength,
        verified: true as const,
      }),
    }),
  });
  return { bytes: patched.bytes, report };
}
