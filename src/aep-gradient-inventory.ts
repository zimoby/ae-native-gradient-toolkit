import { parseGradientUtf8Payload } from "./gcky-gradient.ts";
import type {
  GradientAlphaStop,
  GradientColorStop,
  NativeGradient,
} from "./native-gradient-types.ts";
import type {
  RiffDocument,
  RiffNode,
  RiffSpan,
} from "./riff-rifx.ts";

const DEFAULT_MAX_CONTEXT_NODES = 16;
const DEFAULT_MAX_EVIDENCE_BYTES = 16 * 1024;
const DEFAULT_MAX_MATCH_NAME_EVIDENCE = 16;
const HARD_MAX_CONTEXT_NODES = 128;
const HARD_MAX_EVIDENCE_BYTES = 1024 * 1024;
const HARD_MAX_MATCH_NAME_EVIDENCE = 128;
const MAX_REPORTED_UTF8_IDENTITIES = 16;

const MATCH_NAMES = Object.freeze([
  "ADBE Vector Graphic - G-Fill",
  "ADBE Vector Graphic - G-Stroke",
  "ADBE Vector Grad Colors",
] as const);
const MATCH_NAME_BYTES = Object.freeze(MATCH_NAMES.map((matchName) => Object.freeze({
  matchName,
  bytes: new TextEncoder().encode(matchName),
})));

export type AepGradientInventoryLimits = {
  maxContextNodes?: number;
  maxEvidenceBytes?: number;
  maxMatchNameEvidence?: number;
};

export type ImmutableRiffSpan = Readonly<RiffSpan>;

export type AepRiffNodeIdentity = Readonly<{
  id: string;
  formType: string | null;
  declaredSize: number;
  childCount: number;
  span: ImmutableRiffSpan;
}>;

export type ImmutableGradientColorStop = Readonly<{
  offset: number;
  midpoint: number;
  rgb: readonly [number, number, number];
  extra: number;
}>;

export type ImmutableGradientAlphaStop = Readonly<GradientAlphaStop>;

export type ImmutableNativeGradient = Readonly<{
  schemaVersion: 1;
  colorStops: readonly ImmutableGradientColorStop[];
  alphaStops: readonly ImmutableGradientAlphaStop[];
}>;

export type AepGradientMatchNameEvidence = Readonly<{
  matchName: (typeof MATCH_NAMES)[number];
  sourceOffset: number;
  node: AepRiffNodeIdentity;
}>;

export type AepGradientStructuralContext = Readonly<{
  ancestors: readonly AepRiffNodeIdentity[];
  nearbyNodes: readonly AepRiffNodeIdentity[];
  matchNameEvidence: readonly AepGradientMatchNameEvidence[];
  scannedEvidenceBytes: number;
  truncated: boolean;
}>;

type AepGradientCandidateBase = Readonly<{
  sourceOrder: number;
  list: AepRiffNodeIdentity;
  utf8Count: number;
  utf8Candidates: readonly AepRiffNodeIdentity[];
  utf8IdentitiesTruncated: boolean;
  context: AepGradientStructuralContext;
}>;

export type AepGradientValidCandidate = AepGradientCandidateBase & Readonly<{
  status: "valid";
  utf8: AepRiffNodeIdentity;
  gradient: ImmutableNativeGradient;
  error: null;
}>;

export type AepGradientMalformedCandidate = AepGradientCandidateBase & Readonly<{
  status: "malformed";
  utf8: AepRiffNodeIdentity | null;
  gradient: null;
  error: string;
}>;

export type AepGradientAmbiguousCandidate = AepGradientCandidateBase & Readonly<{
  status: "ambiguous";
  utf8: null;
  gradient: null;
  error: string;
}>;

export type AepGradientCandidate =
  | AepGradientValidCandidate
  | AepGradientMalformedCandidate
  | AepGradientAmbiguousCandidate;

type RequiredInventoryLimits = {
  maxContextNodes: number;
  maxEvidenceBytes: number;
  maxMatchNameEvidence: number;
};

type FlatNode = {
  node: RiffNode;
  parentIndex: number;
};

function boundedInteger(
  value: number | undefined,
  fallback: number,
  name: string,
  minimum: number,
  maximum: number,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new RangeError(`${name} must be an integer from ${minimum} through ${maximum}`);
  }
  return resolved;
}

function normalizeLimits(limits: AepGradientInventoryLimits | undefined): RequiredInventoryLimits {
  return {
    maxContextNodes: boundedInteger(
      limits?.maxContextNodes,
      DEFAULT_MAX_CONTEXT_NODES,
      "maxContextNodes",
      1,
      HARD_MAX_CONTEXT_NODES,
    ),
    maxEvidenceBytes: boundedInteger(
      limits?.maxEvidenceBytes,
      DEFAULT_MAX_EVIDENCE_BYTES,
      "maxEvidenceBytes",
      0,
      HARD_MAX_EVIDENCE_BYTES,
    ),
    maxMatchNameEvidence: boundedInteger(
      limits?.maxMatchNameEvidence,
      DEFAULT_MAX_MATCH_NAME_EVIDENCE,
      "maxMatchNameEvidence",
      0,
      HARD_MAX_MATCH_NAME_EVIDENCE,
    ),
  };
}

function immutableIdentity(node: RiffNode): AepRiffNodeIdentity {
  const span = Object.freeze({
    headerStart: node.span.headerStart,
    sizeFieldStart: node.span.sizeFieldStart,
    dataStart: node.span.dataStart,
    dataEnd: node.span.dataEnd,
    paddedEnd: node.span.paddedEnd,
  });
  return Object.freeze({
    id: node.id,
    formType: node.formType,
    declaredSize: node.declaredSize,
    childCount: node.children.length,
    span,
  });
}

function immutableGradient(value: NativeGradient): ImmutableNativeGradient {
  const colorStops = value.colorStops.map((stop: GradientColorStop) => Object.freeze({
    offset: stop.offset,
    midpoint: stop.midpoint,
    rgb: Object.freeze([stop.rgb[0], stop.rgb[1], stop.rgb[2]]) as readonly [number, number, number],
    extra: stop.extra,
  }));
  const alphaStops = value.alphaStops.map((stop: GradientAlphaStop) => Object.freeze({
    offset: stop.offset,
    midpoint: stop.midpoint,
    alpha: stop.alpha,
  }));
  return Object.freeze({
    schemaVersion: 1 as const,
    colorStops: Object.freeze(colorStops),
    alphaStops: Object.freeze(alphaStops),
  });
}

function flattenDocument(root: RiffNode): FlatNode[] {
  const flat: FlatNode[] = [];
  const stack: Array<{ node: RiffNode; parentIndex: number }> = [{ node: root, parentIndex: -1 }];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const index = flat.length;
    flat.push({ node: current.node, parentIndex: current.parentIndex });
    for (let childIndex = current.node.children.length - 1; childIndex >= 0; childIndex -= 1) {
      stack.push({ node: current.node.children[childIndex], parentIndex: index });
    }
  }
  return flat;
}

function bytesMatchAt(source: Uint8Array, offset: number, limit: number, needle: Uint8Array): boolean {
  if (offset + needle.byteLength > limit) return false;
  for (let index = 0; index < needle.byteLength; index += 1) {
    if (source[offset + index] !== needle[index]) return false;
  }
  return true;
}

function buildContext(
  doc: RiffDocument,
  flat: readonly FlatNode[],
  listIndex: number,
  limits: RequiredInventoryLimits,
  identityFor: (node: RiffNode) => AepRiffNodeIdentity,
): AepGradientStructuralContext {
  const halfBefore = Math.floor((limits.maxContextNodes - 1) / 2);
  let start = Math.max(0, listIndex - halfBefore);
  let end = Math.min(flat.length, start + limits.maxContextNodes);
  start = Math.max(0, end - limits.maxContextNodes);

  const nearbyNodes = flat.slice(start, end).map((entry) => identityFor(entry.node));
  const ancestors: AepRiffNodeIdentity[] = [];
  let parentIndex = flat[listIndex].parentIndex;
  while (parentIndex >= 0) {
    ancestors.push(identityFor(flat[parentIndex].node));
    parentIndex = flat[parentIndex].parentIndex;
  }
  ancestors.reverse();

  const matchNameEvidence: AepGradientMatchNameEvidence[] = [];
  let scannedEvidenceBytes = 0;
  let evidenceScanTruncated = false;
  for (let index = start; index < end; index += 1) {
    const node = flat[index].node;
    if (node.children.length !== 0 || node.formType !== null) continue;
    const remaining = limits.maxEvidenceBytes - scannedEvidenceBytes;
    if (remaining <= 0) {
      if (node.declaredSize > 0) evidenceScanTruncated = true;
      continue;
    }
    const scanLength = Math.min(node.declaredSize, remaining);
    const scanStart = node.span.dataStart;
    const scanEnd = scanStart + scanLength;
    if (scanLength < node.declaredSize) evidenceScanTruncated = true;
    scannedEvidenceBytes += scanLength;

    for (let offset = scanStart; offset < scanEnd; offset += 1) {
      for (const match of MATCH_NAME_BYTES) {
        if (!bytesMatchAt(doc.source, offset, scanEnd, match.bytes)) continue;
        if (matchNameEvidence.length >= limits.maxMatchNameEvidence) {
          evidenceScanTruncated = true;
          continue;
        }
        matchNameEvidence.push(Object.freeze({
          matchName: match.matchName,
          sourceOffset: offset,
          node: identityFor(node),
        }));
      }
    }
  }

  return Object.freeze({
    ancestors: Object.freeze(ancestors),
    nearbyNodes: Object.freeze(nearbyNodes),
    matchNameEvidence: Object.freeze(matchNameEvidence),
    scannedEvidenceBytes,
    truncated: start > 0 || end < flat.length || evidenceScanTruncated,
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function enumerateAepGradientCandidates(
  doc: RiffDocument,
  limits?: AepGradientInventoryLimits,
): readonly AepGradientCandidate[] {
  const resolved = normalizeLimits(limits);
  const flat = flattenDocument(doc.root);
  const subtreeUtf8Counts = new Array<number>(flat.length).fill(0);
  const subtreeGckyCounts = new Array<number>(flat.length).fill(0);
  for (let index = flat.length - 1; index >= 0; index -= 1) {
    const node = flat[index].node;
    if (node.id === "Utf8") subtreeUtf8Counts[index] += 1;
    if (node.id === "LIST" && node.formType === "GCky") subtreeGckyCounts[index] += 1;
    const parentIndex = flat[index].parentIndex;
    if (parentIndex >= 0) {
      subtreeUtf8Counts[parentIndex] += subtreeUtf8Counts[index];
      subtreeGckyCounts[parentIndex] += subtreeGckyCounts[index];
    }
  }

  const identityCache = new Map<RiffNode, AepRiffNodeIdentity>();
  const identityFor = (node: RiffNode): AepRiffNodeIdentity => {
    const cached = identityCache.get(node);
    if (cached !== undefined) return cached;
    const identity = immutableIdentity(node);
    identityCache.set(node, identity);
    return identity;
  };

  const candidates: AepGradientCandidate[] = [];
  for (let index = 0; index < flat.length; index += 1) {
    const list = flat[index].node;
    if (list.id !== "LIST" || list.formType !== "GCky") continue;

    let directUtf8Count = 0;
    const reportedUtf8Nodes: RiffNode[] = [];
    for (const child of list.children) {
      if (child.id !== "Utf8" || child.formType !== null || child.children.length !== 0) continue;
      directUtf8Count += 1;
      if (reportedUtf8Nodes.length < MAX_REPORTED_UTF8_IDENTITIES) reportedUtf8Nodes.push(child);
    }
    const descendantUtf8Count = subtreeUtf8Counts[index];
    const nestedGckyCount = subtreeGckyCounts[index] - 1;
    const utf8Candidates = Object.freeze(reportedUtf8Nodes.map(identityFor));
    const common = {
      sourceOrder: candidates.length,
      list: identityFor(list),
      utf8Count: descendantUtf8Count,
      utf8Candidates,
      utf8IdentitiesTruncated: directUtf8Count > reportedUtf8Nodes.length,
      context: buildContext(doc, flat, index, resolved, identityFor),
    };

    if (nestedGckyCount > 0) {
      candidates.push(Object.freeze({
        ...common,
        status: "ambiguous" as const,
        utf8: null,
        gradient: null,
        error: `structurally ambiguous GCky list: contains ${nestedGckyCount} nested GCky list${nestedGckyCount === 1 ? "" : "s"}`,
      }));
      continue;
    }
    if (descendantUtf8Count !== directUtf8Count) {
      candidates.push(Object.freeze({
        ...common,
        status: "ambiguous" as const,
        utf8: null,
        gradient: null,
        error: "structurally ambiguous GCky list: contains nested Utf8 descendants",
      }));
      continue;
    }
    if (directUtf8Count > 1) {
      candidates.push(Object.freeze({
        ...common,
        status: "ambiguous" as const,
        utf8: null,
        gradient: null,
        error: `structurally ambiguous GCky list: expected one direct Utf8 child, found ${directUtf8Count}`,
      }));
      continue;
    }
    if (directUtf8Count === 0) {
      candidates.push(Object.freeze({
        ...common,
        status: "malformed" as const,
        utf8: null,
        gradient: null,
        error: "malformed GCky list: expected one direct Utf8 child, found 0",
      }));
      continue;
    }

    const utf8Node = reportedUtf8Nodes[0];
    const utf8 = identityFor(utf8Node);
    try {
      const payload = doc.source.subarray(utf8Node.span.dataStart, utf8Node.span.dataEnd);
      candidates.push(Object.freeze({
        ...common,
        status: "valid" as const,
        utf8,
        gradient: immutableGradient(parseGradientUtf8Payload(payload)),
        error: null,
      }));
    } catch (error) {
      candidates.push(Object.freeze({
        ...common,
        status: "malformed" as const,
        utf8,
        gradient: null,
        error: `malformed GCky Utf8 payload: ${errorMessage(error)}`,
      }));
    }
  }
  return Object.freeze(candidates);
}

export function requireUniqueAepGradientCandidate(
  candidates: readonly AepGradientCandidate[],
): AepGradientValidCandidate {
  if (candidates.length !== 1) {
    throw new Error(`unique gradient candidate required: found ${candidates.length} GCky lists`);
  }
  const candidate = candidates[0];
  if (candidate.status !== "valid") {
    throw new Error(
      `unique gradient candidate required: candidate ${candidate.sourceOrder} is ${candidate.status}: ${candidate.error}`,
    );
  }
  return candidate;
}
