import {
  checkedAdd,
  paddingForLength,
  paddedLength,
  readFourCC,
  readUint32BE,
  writeUint32BE,
} from "./bytes.ts";

const UINT32_MAX = 0xffff_ffff;
const HARD_MAX_BYTES = 256 * 1024 * 1024;
const HARD_MAX_DEPTH = 256;
const HARD_MAX_NODES = 1_000_000;

function hasOpaqueListPayload(formType: string): boolean {
  return formType === "btdk";
}

export type RiffSpan = {
  headerStart: number;
  sizeFieldStart: number;
  dataStart: number;
  dataEnd: number;
  paddedEnd: number;
};

export type RiffNode = {
  id: string;
  declaredSize: number;
  formType: string | null;
  children: readonly RiffNode[];
  span: RiffSpan;
};

export type RiffDocument = {
  source: Uint8Array;
  root: RiffNode;
  declaredEnd: number;
  trailerStart: number;
};

export type RiffLimits = {
  maxDepth?: number;
  maxNodes?: number;
  maxBytes?: number;
};

export type AncestorSizePatch = {
  id: string;
  sizeFieldStart: number;
  oldSize: number;
  newSize: number;
};

export type SpanPatchReport = {
  ancestorSizePatches: readonly AncestorSizePatch[];
  targetOldSpan: RiffSpan;
  targetNewSpan: RiffSpan;
  oldDeclaredEnd: number;
  newDeclaredEnd: number;
  unchangedSuffix: {
    oldStart: number;
    newStart: number;
    byteLength: number;
    verified: true;
  };
};

type RequiredLimits = {
  maxDepth: number;
  maxNodes: number;
  maxBytes: number;
};

function boundedInteger(
  value: number | undefined,
  fallback: number,
  name: string,
  minimum: number,
  maximum: number
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new RangeError(`${name} must be an integer from ${minimum} through ${maximum}`);
  }
  return resolved;
}

function normalizeLimits(limits: RiffLimits | undefined): RequiredLimits {
  return {
    maxDepth: boundedInteger(limits?.maxDepth, 64, "maxDepth", 0, HARD_MAX_DEPTH),
    maxNodes: boundedInteger(limits?.maxNodes, 100_000, "maxNodes", 1, HARD_MAX_NODES),
    maxBytes: boundedInteger(limits?.maxBytes, HARD_MAX_BYTES, "maxBytes", 12, HARD_MAX_BYTES),
  };
}

function immutableSpan(span: RiffSpan): RiffSpan {
  return Object.freeze(span);
}

function immutableNode(
  id: string,
  declaredSize: number,
  formType: string | null,
  children: RiffNode[],
  span: RiffSpan
): RiffNode {
  return Object.freeze({
    id,
    declaredSize,
    formType,
    children: Object.freeze(children.slice()),
    span: immutableSpan(span),
  });
}

export function parseRifx(source: Uint8Array, limits?: RiffLimits): RiffDocument {
  const resolved = normalizeLimits(limits);
  if (source.byteLength > resolved.maxBytes) {
    throw new RangeError(`RIFX byte limit exceeded: ${source.byteLength} > ${resolved.maxBytes}`);
  }
  if (source.byteLength < 12) {
    throw new RangeError("truncated RIFX root: need a header and four-byte form type");
  }

  const rootId = readFourCC(source, 0);
  if (rootId === "RIFF") {
    throw new Error("little-endian RIFF is not supported; expected big-endian RIFX");
  }
  if (rootId !== "RIFX") {
    throw new Error(`root must be RIFX, received ${rootId}`);
  }

  const rootSize = readUint32BE(source, 4);
  if (rootSize < 4) {
    throw new Error("RIFX root declared size must include a four-byte form type");
  }
  const declaredEnd = checkedAdd(8, rootSize, "RIFX declared end");
  if (declaredEnd > source.byteLength) {
    throw new RangeError(`truncated RIFX root: declared end ${declaredEnd}, length ${source.byteLength}`);
  }
  if (declaredEnd > resolved.maxBytes) {
    throw new RangeError(`RIFX byte limit exceeded: declared end ${declaredEnd} > ${resolved.maxBytes}`);
  }

  const rootFormType = readFourCC(source, 8);
  let nodeCount = 1;

  const parseChildren = (
    start: number,
    end: number,
    depth: number,
    containerLabel: string
  ): RiffNode[] => {
    const children: RiffNode[] = [];
    let offset = start;
    while (offset < end) {
      const remaining = end - offset;
      if (remaining < 8) {
        throw new Error(`${containerLabel} has ${remaining} unexplained bytes inside its declared container`);
      }
      if (depth > resolved.maxDepth) {
        throw new RangeError(`RIFX depth limit exceeded at byte ${offset}`);
      }
      nodeCount += 1;
      if (nodeCount > resolved.maxNodes) {
        throw new RangeError(`RIFX node limit exceeded at byte ${offset}`);
      }

      const id = readFourCC(source, offset);
      if (id === "RIFX" || id === "RIFF") {
        throw new Error(`invalid nesting: ${id} is only valid as the root`);
      }
      const declaredSize = readUint32BE(source, offset + 4);
      const dataStart = checkedAdd(offset, 8, `${id} data start`);
      const dataEnd = checkedAdd(dataStart, declaredSize, `${id} data end`);
      if (dataEnd > end) {
        throw new RangeError(`truncated ${id} data: declared end ${dataEnd}, container ends ${end}`);
      }
      const paddedEnd = checkedAdd(dataEnd, paddingForLength(declaredSize), `${id} padded end`);
      if (paddedEnd > end) {
        throw new RangeError(`truncated ${id} pad: padded end ${paddedEnd}, container ends ${end}`);
      }

      let formType: string | null = null;
      let nestedChildren: RiffNode[] = [];
      if (id === "LIST") {
        if (declaredSize < 4) {
          throw new Error(`LIST at byte ${offset} is too small for a four-byte form type`);
        }
        formType = readFourCC(source, dataStart);
        if (!hasOpaqueListPayload(formType)) {
          nestedChildren = parseChildren(dataStart + 4, dataEnd, depth + 1, `LIST(${formType})`);
        }
      }

      children.push(
        immutableNode(id, declaredSize, formType, nestedChildren, {
          headerStart: offset,
          sizeFieldStart: offset + 4,
          dataStart,
          dataEnd,
          paddedEnd,
        })
      );
      offset = paddedEnd;
    }
    return children;
  };

  const rootChildren = parseChildren(12, declaredEnd, 1, `RIFX(${rootFormType})`);
  const root = immutableNode("RIFX", rootSize, rootFormType, rootChildren, {
    headerStart: 0,
    sizeFieldStart: 4,
    dataStart: 8,
    dataEnd: declaredEnd,
    paddedEnd: declaredEnd,
  });
  return Object.freeze({ source, root, declaredEnd, trailerStart: declaredEnd });
}

export function findListsByFormType(doc: RiffDocument, formType: string): RiffNode[] {
  const matches: RiffNode[] = [];
  const stack: RiffNode[] = [doc.root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.id === "LIST" && node.formType === formType) {
      matches.push(node);
    }
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      stack.push(node.children[index]);
    }
  }
  return matches;
}

function locateNodePath(root: RiffNode, target: RiffNode): RiffNode[] | null {
  const stack: Array<{ node: RiffNode; path: RiffNode[] }> = [{ node: root, path: [root] }];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.node === target) return current.path;
    for (let index = current.node.children.length - 1; index >= 0; index -= 1) {
      const child = current.node.children[index];
      stack.push({ node: child, path: [...current.path, child] });
    }
  }
  return null;
}

function addSignedUint32(value: number, delta: number, context: string): number {
  const result = value + delta;
  if (!Number.isSafeInteger(result) || result < 0 || result > UINT32_MAX) {
    throw new RangeError(`${context} size overflow`);
  }
  return result;
}

function suffixesEqual(
  before: Uint8Array,
  beforeStart: number,
  after: Uint8Array,
  afterStart: number
): boolean {
  if (before.length - beforeStart !== after.length - afterStart) return false;
  for (let index = 0; index < before.length - beforeStart; index += 1) {
    if (before[beforeStart + index] !== after[afterStart + index]) return false;
  }
  return true;
}

export function replaceLeafPayload(
  doc: RiffDocument,
  leaf: RiffNode,
  replacement: Uint8Array
): { bytes: Uint8Array; report: SpanPatchReport } {
  const path = locateNodePath(doc.root, leaf);
  if (path === null) {
    throw new Error("patch target does not belong to this RIFX document");
  }
  if (leaf.children.length !== 0 || leaf.formType !== null || leaf.id === "LIST" || leaf.id === "RIFX") {
    throw new Error("patch target must be a leaf chunk");
  }
  if (replacement.byteLength > UINT32_MAX) {
    throw new RangeError("replacement payload exceeds uint32 size");
  }

  const oldPaddedPayloadLength = leaf.span.paddedEnd - leaf.span.dataStart;
  const newPaddedPayloadLength = paddedLength(replacement.byteLength);
  const delta = newPaddedPayloadLength - oldPaddedPayloadLength;
  const outputLength = doc.source.byteLength + delta;
  if (!Number.isSafeInteger(outputLength) || outputLength < 0 || outputLength > HARD_MAX_BYTES) {
    throw new RangeError(`patched RIFX byte limit exceeded: ${outputLength} > ${HARD_MAX_BYTES}`);
  }

  const ancestors = path.slice(0, -1);
  const ancestorSizePatches: AncestorSizePatch[] = ancestors.map((ancestor) => ({
    id: ancestor.id,
    sizeFieldStart: ancestor.span.sizeFieldStart,
    oldSize: ancestor.declaredSize,
    newSize: addSignedUint32(ancestor.declaredSize, delta, `${ancestor.id} ancestor`),
  }));
  const newDeclaredEnd = doc.declaredEnd + delta;
  if (!Number.isSafeInteger(newDeclaredEnd) || newDeclaredEnd < 12 || newDeclaredEnd > outputLength) {
    throw new RangeError("patched RIFX declared end overflow");
  }

  const targetNewSpan = immutableSpan({
    headerStart: leaf.span.headerStart,
    sizeFieldStart: leaf.span.sizeFieldStart,
    dataStart: leaf.span.dataStart,
    dataEnd: leaf.span.dataStart + replacement.byteLength,
    paddedEnd: leaf.span.dataStart + newPaddedPayloadLength,
  });

  const bytes = new Uint8Array(outputLength);
  bytes.set(doc.source.subarray(0, leaf.span.dataStart), 0);
  writeUint32BE(bytes, leaf.span.sizeFieldStart, replacement.byteLength);
  bytes.set(replacement, leaf.span.dataStart);
  if (paddingForLength(replacement.byteLength) === 1) {
    bytes[targetNewSpan.dataEnd] = 0;
  }
  bytes.set(doc.source.subarray(leaf.span.paddedEnd), targetNewSpan.paddedEnd);
  for (const patch of ancestorSizePatches) {
    writeUint32BE(bytes, patch.sizeFieldStart, patch.newSize);
  }

  const suffixVerified = suffixesEqual(
    doc.source,
    leaf.span.paddedEnd,
    bytes,
    targetNewSpan.paddedEnd
  );
  if (!suffixVerified) {
    throw new Error("internal patch failure: unchanged suffix verification failed");
  }

  const report: SpanPatchReport = Object.freeze({
    ancestorSizePatches: Object.freeze(ancestorSizePatches.map((patch) => Object.freeze(patch))),
    targetOldSpan: leaf.span,
    targetNewSpan,
    oldDeclaredEnd: doc.declaredEnd,
    newDeclaredEnd,
    unchangedSuffix: Object.freeze({
      oldStart: leaf.span.paddedEnd,
      newStart: targetNewSpan.paddedEnd,
      byteLength: doc.source.length - leaf.span.paddedEnd,
      verified: true as const,
    }),
  });
  return { bytes, report };
}
