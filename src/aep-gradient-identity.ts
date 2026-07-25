import {
  enumerateAepGradientCandidates,
  type AepGradientCandidate,
} from "./aep-gradient-inventory.ts";
import type { RiffDocument, RiffNode } from "./riff-rifx.ts";

const MAX_PROPERTY_DEPTH = 32;
const MAX_PROPERTY_NODES = 100_000;
const MAX_MATCH_NAME_BYTES = 512;
const SUPPORTED_PROJECT_FORMAT_MIN = 93;
const SUPPORTED_PROJECT_FORMAT_MAX = 97;

const ROOT_VECTORS_MATCH_NAME = "ADBE Root Vectors Group";
const VECTOR_GROUP_MATCH_NAME = "ADBE Vector Group";
const VECTORS_GROUP_MATCH_NAME = "ADBE Vectors Group";
const GRADIENT_FILL_MATCH_NAME = "ADBE Vector Graphic - G-Fill";
const GRADIENT_STROKE_MATCH_NAME = "ADBE Vector Graphic - G-Stroke";
const GRADIENT_COLORS_MATCH_NAME = "ADBE Vector Grad Colors";
const GROUP_END_MATCH_NAME = "ADBE Group End";

export type AepNativeGradientKind = "fill" | "stroke";

export type AepNativeGradientTargetDescriptor = Readonly<{
  compId: number;
  layerId: number;
  layerIndex: number;
  kind: AepNativeGradientKind;
  propertyIndexPath: readonly number[];
  matchNamePath: readonly string[];
}>;

export type AepNativeGradientIndexedTarget = AepNativeGradientTargetDescriptor & Readonly<{
  projectFormat: number;
  candidate: AepGradientCandidate;
}>;

export type AepNativeGradientTargetResolution =
  | Readonly<{ status: "resolved"; target: AepNativeGradientIndexedTarget }>
  | Readonly<{ status: "none" }>
  | Readonly<{ status: "ambiguous" }>;

type PropertyRun = Readonly<{
  name: string;
  list: RiffNode;
}>;

type TraversalState = {
  propertyNodes: number;
};

function readUint16BE(source: Uint8Array, offset: number): number {
  return new DataView(source.buffer, source.byteOffset, source.byteLength).getUint16(offset, false);
}

function readUint32BE(source: Uint8Array, offset: number): number {
  return new DataView(source.buffer, source.byteOffset, source.byteLength).getUint32(offset, false);
}

function directChildren(node: RiffNode, id: string, formType?: string): RiffNode[] {
  return node.children.filter((child) => (
    child.id === id && (formType === undefined || child.formType === formType)
  ));
}

function decodeMatchName(source: Uint8Array, node: RiffNode): string {
  if (node.declaredSize < 2 || node.declaredSize > MAX_MATCH_NAME_BYTES) {
    throw new Error(`invalid tdmn byte length ${node.declaredSize}`);
  }
  const bytes = source.subarray(node.span.dataStart, node.span.dataEnd);
  const terminator = bytes.indexOf(0);
  const trailingBytes = terminator < 0 ? bytes : bytes.subarray(terminator + 1);
  if (terminator <= 0 || trailingBytes.some((value) => value !== 0)) {
    throw new Error("tdmn must contain one non-empty null-terminated match name with zero padding");
  }
  const value = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, terminator));
  if (value.length === 0) throw new Error("tdmn match name must not be empty");
  return value;
}

function propertyRuns(source: Uint8Array, container: RiffNode): readonly PropertyRun[] {
  const runs: PropertyRun[] = [];
  for (let index = 0; index < container.children.length; index += 1) {
    const child = container.children[index];
    if (child.id !== "tdmn") continue;
    const name = decodeMatchName(source, child);
    const list = container.children[index + 1];
    if (list === undefined || list.id !== "LIST") {
      if (name === GROUP_END_MATCH_NAME) continue;
      throw new Error(`tdmn at byte ${child.span.headerStart} is not followed by one property LIST`);
    }
    runs.push(Object.freeze({
      name,
      list,
    }));
    index += 1;
  }
  return Object.freeze(runs);
}

function payloadIndexForProjectFormat(kind: AepNativeGradientKind, projectFormat: number): number {
  if (projectFormat < SUPPORTED_PROJECT_FORMAT_MIN || projectFormat > SUPPORTED_PROJECT_FORMAT_MAX) {
    throw new Error(`unsupported AEP project format ${projectFormat}`);
  }
  if (projectFormat <= 96) return kind === "fill" ? 9 : 8;
  return kind === "fill" ? 11 : 10;
}

function exactPropertyIndex(
  parentMatchName: string | null,
  childMatchName: string,
  serializedIndex: number,
  projectFormat: number,
): number | null {
  if (parentMatchName === null) {
    return childMatchName === ROOT_VECTORS_MATCH_NAME ? 2 : null;
  }
  if (parentMatchName === ROOT_VECTORS_MATCH_NAME) {
    return childMatchName === VECTOR_GROUP_MATCH_NAME
      || childMatchName === GRADIENT_FILL_MATCH_NAME
      || childMatchName === GRADIENT_STROKE_MATCH_NAME
      ? serializedIndex
      : null;
  }
  if (parentMatchName === VECTOR_GROUP_MATCH_NAME) {
    return childMatchName === VECTORS_GROUP_MATCH_NAME ? 2 : null;
  }
  if (parentMatchName === VECTORS_GROUP_MATCH_NAME) {
    return childMatchName === VECTOR_GROUP_MATCH_NAME
      || childMatchName === GRADIENT_FILL_MATCH_NAME
      || childMatchName === GRADIENT_STROKE_MATCH_NAME
      ? serializedIndex
      : null;
  }
  if (parentMatchName === GRADIENT_FILL_MATCH_NAME) {
    return childMatchName === GRADIENT_COLORS_MATCH_NAME
      ? payloadIndexForProjectFormat("fill", projectFormat)
      : null;
  }
  if (parentMatchName === GRADIENT_STROKE_MATCH_NAME) {
    return childMatchName === GRADIENT_COLORS_MATCH_NAME
      ? payloadIndexForProjectFormat("stroke", projectFormat)
      : null;
  }
  return null;
}

function kindForMatchName(matchName: string): AepNativeGradientKind | null {
  if (matchName === GRADIENT_FILL_MATCH_NAME) return "fill";
  if (matchName === GRADIENT_STROKE_MATCH_NAME) return "stroke";
  return null;
}

function findGradientTargets(
  source: Uint8Array,
  container: RiffNode,
  compId: number,
  layerId: number,
  layerIndex: number,
  projectFormat: number,
  candidateByHeaderStart: ReadonlyMap<number, AepGradientCandidate>,
  state: TraversalState,
  indexPath: readonly number[] = [],
  matchNamePath: readonly string[] = [],
): AepNativeGradientIndexedTarget[] {
  if (indexPath.length >= MAX_PROPERTY_DEPTH) {
    throw new RangeError(`AEP identity property depth limit exceeded: ${indexPath.length} >= ${MAX_PROPERTY_DEPTH}`);
  }
  const targets: AepNativeGradientIndexedTarget[] = [];
  const runs = propertyRuns(source, container);
  for (let runIndex = 0; runIndex < runs.length; runIndex += 1) {
    state.propertyNodes += 1;
    if (state.propertyNodes > MAX_PROPERTY_NODES) {
      throw new RangeError(`AEP identity property node limit exceeded: ${state.propertyNodes} > ${MAX_PROPERTY_NODES}`);
    }
    const run = runs[runIndex];
    const parentMatchName = matchNamePath.length === 0
      ? null
      : matchNamePath[matchNamePath.length - 1];
    const propertyIndex = exactPropertyIndex(parentMatchName, run.name, runIndex + 1, projectFormat);
    if (propertyIndex === null) continue;
    const expectedListFormType = run.name === GRADIENT_COLORS_MATCH_NAME ? "GCst" : "tdgp";
    if (run.list.formType !== expectedListFormType) continue;
    const nextIndexPath = Object.freeze([...indexPath, propertyIndex]);
    const nextMatchNamePath = Object.freeze([...matchNamePath, run.name]);

    if (run.name === GRADIENT_COLORS_MATCH_NAME) {
      const parentKind = kindForMatchName(parentMatchName ?? "");
      if (parentKind === null) continue;
      const gradientLists = run.list.children.filter(
        (node) => node.id === "LIST" && node.formType === "GCky",
      );
      if (gradientLists.length !== 1) continue;
      const candidate = candidateByHeaderStart.get(gradientLists[0].span.headerStart);
      if (candidate === undefined) continue;
      targets.push(Object.freeze({
        projectFormat,
        compId,
        layerId,
        layerIndex,
        kind: parentKind,
        propertyIndexPath: nextIndexPath,
        matchNamePath: nextMatchNamePath,
        candidate,
      }));
      continue;
    }

    targets.push(...findGradientTargets(
      source,
      run.list,
      compId,
      layerId,
      layerIndex,
      projectFormat,
      candidateByHeaderStart,
      state,
      nextIndexPath,
      nextMatchNamePath,
    ));
  }
  return targets;
}

function equalArrays<T>(left: readonly T[], right: readonly T[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function sameDescriptor(
  target: AepNativeGradientIndexedTarget,
  descriptor: AepNativeGradientTargetDescriptor,
): boolean {
  return target.compId === descriptor.compId
    && target.layerId === descriptor.layerId
    && target.layerIndex === descriptor.layerIndex
    && target.kind === descriptor.kind
    && equalArrays(target.propertyIndexPath, descriptor.propertyIndexPath)
    && equalArrays(target.matchNamePath, descriptor.matchNamePath);
}

export function readAepProjectFormatVersion(document: RiffDocument): number {
  if (document.root.id !== "RIFX" || document.root.formType !== "Egg!") {
    throw new Error("AEP identity requires a RIFX/Egg! document");
  }
  const head = directChildren(document.root, "head");
  if (head.length !== 1 || head[0].declaredSize < 2) {
    throw new Error("AEP identity requires one valid head chunk");
  }
  return readUint16BE(document.source, head[0].span.dataStart);
}

export function indexAepNativeGradientTargets(
  document: RiffDocument,
): readonly AepNativeGradientIndexedTarget[] {
  const projectFormat = readAepProjectFormatVersion(document);
  payloadIndexForProjectFormat("fill", projectFormat);
  const candidates = enumerateAepGradientCandidates(document);
  const candidateByHeaderStart = new Map<number, AepGradientCandidate>();
  for (const candidate of candidates) {
    if (candidate.status !== "valid") continue;
    const offset = candidate.list.span.headerStart;
    if (candidateByHeaderStart.has(offset)) {
      throw new Error(`duplicate GCky candidate identity at byte ${offset}`);
    }
    candidateByHeaderStart.set(offset, candidate);
  }

  const targets: AepNativeGradientIndexedTarget[] = [];
  const folds = directChildren(document.root, "LIST", "Fold");
  if (folds.length !== 1) return Object.freeze(targets);
  const items = directChildren(folds[0], "LIST", "Item");
  const state: TraversalState = { propertyNodes: 0 };
  for (const item of items) {
    const itemData = directChildren(item, "idta");
    if (itemData.length !== 1 || itemData[0].declaredSize < 20) continue;
    const itemType = readUint16BE(document.source, itemData[0].span.dataStart);
    if (itemType !== 4) continue;
    const compId = readUint32BE(document.source, itemData[0].span.dataStart + 16);
    const layers = directChildren(item, "LIST", "Layr");
    for (let layerOffset = 0; layerOffset < layers.length; layerOffset += 1) {
      const layer = layers[layerOffset];
      const layerData = directChildren(layer, "ldta");
      const propertyRoots = directChildren(layer, "LIST", "tdgp");
      if (layerData.length !== 1 || layerData[0].declaredSize < 132 || propertyRoots.length !== 1) continue;
      const layerType = document.source[layerData[0].span.dataStart + 131];
      if (layerType !== 4) continue;
      const layerId = readUint32BE(document.source, layerData[0].span.dataStart);
      targets.push(...findGradientTargets(
        document.source,
        propertyRoots[0],
        compId,
        layerId,
        layerOffset + 1,
        projectFormat,
        candidateByHeaderStart,
        state,
      ));
    }
  }
  return Object.freeze(targets);
}

export function resolveAepNativeGradientTarget(
  targets: readonly AepNativeGradientIndexedTarget[],
  descriptor: AepNativeGradientTargetDescriptor,
): AepNativeGradientTargetResolution {
  let match: AepNativeGradientIndexedTarget | null = null;
  for (const target of targets) {
    if (!sameDescriptor(target, descriptor)) continue;
    if (match !== null) return Object.freeze({ status: "ambiguous" });
    match = target;
  }
  if (match === null) return Object.freeze({ status: "none" });
  return Object.freeze({ status: "resolved", target: match });
}
