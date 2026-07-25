import test from "node:test";
import assert from "node:assert/strict";
import {
  findListsByFormType,
  parseRifx,
  replaceLeafPayload,
  type RiffNode,
} from "../src/riff-rifx.ts";

type SyntheticNode =
  | { id: string; payload: Uint8Array; pad?: number }
  | { id: "LIST"; formType: string; children: SyntheticNode[]; pad?: number };

const ascii = (value: string): Uint8Array =>
  Uint8Array.from([...value].map((character) => character.charCodeAt(0)));

const u32 = (value: number): Uint8Array =>
  Uint8Array.of((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
};

function chunk(node: SyntheticNode): Uint8Array {
  const payload = "children" in node
    ? concat(ascii(node.formType), ...node.children.map(chunk))
    : node.payload;
  return concat(
    ascii(node.id),
    u32(payload.length),
    payload,
    payload.length % 2 === 1 ? Uint8Array.of(node.pad ?? 0) : new Uint8Array()
  );
}

function rifx(children: SyntheticNode[], trailer = new Uint8Array(), formType = "AEfx"): Uint8Array {
  const body = concat(ascii(formType), ...children.map(chunk));
  return concat(ascii("RIFX"), u32(body.length), body, trailer);
}

function leaf(id: string, values: number[], pad?: number): SyntheticNode {
  return { id, payload: Uint8Array.from(values), pad };
}

function nestedFixture(): Uint8Array {
  return rifx(
    [
      {
        id: "LIST",
        formType: "OUTR",
        children: [
          leaf("HEAD", [1], 0x7f),
          {
            id: "LIST",
            formType: "GCky",
            children: [leaf("Utf8", [0x61, 0x62, 0x63], 0xaa), leaf("TAIL", [9, 8])],
          },
          leaf("AFTR", []),
        ],
      },
      leaf("LAST", [0xee], 0x5a),
    ],
    Uint8Array.of(0xde, 0xad, 0xbe, 0xef)
  );
}

function findLeafById(root: RiffNode, id: string): RiffNode {
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.id === id && node.children.length === 0) return node;
    stack.push(...node.children);
  }
  throw new Error(`missing leaf ${id}`);
}

function assertPrefixOnlySizeWordsChanged(
  before: Uint8Array,
  after: Uint8Array,
  prefixEnd: number,
  sizeOffsets: readonly number[],
  diagnostic = ""
): void {
  const allowed = new Set<number>();
  for (const offset of sizeOffsets) {
    for (let index = 0; index < 4; index += 1) allowed.add(offset + index);
  }
  for (let offset = 0; offset < prefixEnd; offset += 1) {
    if (!allowed.has(offset)) {
      assert.equal(after[offset], before[offset], `${diagnostic} unexpected prefix change at ${offset}`);
    }
  }
}

test("parses nested root/LIST/leaf spans, odd/even pads, and a legal trailer", () => {
  const source = nestedFixture();
  const doc = parseRifx(source);
  assert.equal(doc.source, source);
  assert.equal(doc.declaredEnd, 86);
  assert.equal(doc.trailerStart, 86);
  assert.deepEqual([...source.subarray(doc.trailerStart)], [0xde, 0xad, 0xbe, 0xef]);
  assert.deepEqual(doc.root.span, {
    headerStart: 0,
    sizeFieldStart: 4,
    dataStart: 8,
    dataEnd: 86,
    paddedEnd: 86,
  });
  assert.equal(doc.root.formType, "AEfx");

  const outer = doc.root.children[0];
  assert.deepEqual(outer.span, {
    headerStart: 12,
    sizeFieldStart: 16,
    dataStart: 20,
    dataEnd: 76,
    paddedEnd: 76,
  });
  const gradient = findListsByFormType(doc, "GCky")[0];
  assert.deepEqual(gradient.span, {
    headerStart: 34,
    sizeFieldStart: 38,
    dataStart: 42,
    dataEnd: 68,
    paddedEnd: 68,
  });
  const utf8 = gradient.children[0];
  assert.deepEqual(utf8.span, {
    headerStart: 46,
    sizeFieldStart: 50,
    dataStart: 54,
    dataEnd: 57,
    paddedEnd: 58,
  });
  assert.equal(source[33], 0x7f, "nonzero pad on untouched HEAD is represented in its span");
  assert.equal(source[57], 0xaa, "nonzero target pad is accepted");
  assert.equal(source[85], 0x5a, "nonzero pad after the target is accepted");
  assert.equal(findListsByFormType(doc, "NONE").length, 0);
});

test("preserves AE binary btdk LIST payloads as opaque data", () => {
  const opaquePayload = concat(
    ascii("btdk"),
    ascii(" /98"),
    u32(540_818_464),
    Uint8Array.of(1, 2, 3)
  );
  const opaqueList = concat(
    ascii("LIST"),
    u32(opaquePayload.length),
    opaquePayload,
    opaquePayload.length % 2 === 1 ? Uint8Array.of(0) : new Uint8Array()
  );
  const next = chunk(leaf("NEXT", [7, 8]));
  const body = concat(ascii("Egg!"), opaqueList, next);
  const source = concat(ascii("RIFX"), u32(body.length), body);
  const doc = parseRifx(source);

  const opaque = findListsByFormType(doc, "btdk")[0];
  assert.ok(opaque);
  assert.equal(opaque.children.length, 0);
  assert.equal(opaque.span.paddedEnd - opaque.span.dataEnd, 1);
  assert.equal(source[opaque.span.dataEnd], 0);
  assert.equal(doc.root.children[1].span.headerStart, opaque.span.paddedEnd);
  assert.equal(doc.root.children[1].id, "NEXT");
});

test("expands a nested leaf by splicing spans and preserving suffix plus trailer exactly", () => {
  const source = nestedFixture();
  const original = source.slice();
  const doc = parseRifx(source);
  const leafNode = findListsByFormType(doc, "GCky")[0].children[0];
  const replacement = Uint8Array.of(10, 11, 12, 13, 14, 15);
  const { bytes, report } = replaceLeafPayload(doc, leafNode, replacement);

  assert.deepEqual(source, original, "source remains untouched");
  assert.equal(bytes.length, source.length + 2);
  assert.deepEqual(
    [...bytes.subarray(report.unchangedSuffix.newStart)],
    [...source.subarray(report.unchangedSuffix.oldStart)]
  );
  assert.deepEqual([...bytes.subarray(bytes.length - 4)], [0xde, 0xad, 0xbe, 0xef]);
  assert.deepEqual(report.unchangedSuffix, {
    oldStart: 58,
    newStart: 60,
    byteLength: source.length - 58,
    verified: true,
  });
  assert.equal(report.oldDeclaredEnd, 86);
  assert.equal(report.newDeclaredEnd, 88);
  assert.deepEqual(report.targetOldSpan, leafNode.span);
  assert.deepEqual(report.targetNewSpan, {
    headerStart: 46,
    sizeFieldStart: 50,
    dataStart: 54,
    dataEnd: 60,
    paddedEnd: 60,
  });
  assert.deepEqual(
    report.ancestorSizePatches.map(({ id, sizeFieldStart, oldSize, newSize }) => ({
      id,
      sizeFieldStart,
      oldSize,
      newSize,
    })),
    [
      { id: "RIFX", sizeFieldStart: 4, oldSize: 78, newSize: 80 },
      { id: "LIST", sizeFieldStart: 16, oldSize: 56, newSize: 58 },
      { id: "LIST", sizeFieldStart: 38, oldSize: 26, newSize: 28 },
    ]
  );
  assertPrefixOnlySizeWordsChanged(source, bytes, leafNode.span.dataStart, [4, 16, 38, 50]);

  const reparsed = parseRifx(bytes);
  const reparsedLeaf = findListsByFormType(reparsed, "GCky")[0].children[0];
  assert.deepEqual([...bytes.subarray(reparsedLeaf.span.dataStart, reparsedLeaf.span.dataEnd)], [...replacement]);
  assert.equal(reparsed.declaredEnd, 88);
});

test("shrinks to a zero-length leaf and handles odd replacement padding", () => {
  const source = nestedFixture();
  const doc = parseRifx(source);
  const target = findListsByFormType(doc, "GCky")[0].children[0];

  const zero = replaceLeafPayload(doc, target, new Uint8Array());
  assert.equal(zero.bytes.length, source.length - 4);
  const zeroDoc = parseRifx(zero.bytes);
  const zeroLeaf = findListsByFormType(zeroDoc, "GCky")[0].children[0];
  assert.equal(zeroLeaf.declaredSize, 0);
  assert.equal(zeroLeaf.span.dataEnd, zeroLeaf.span.paddedEnd);
  assert.deepEqual(
    [...zero.bytes.subarray(zero.report.unchangedSuffix.newStart)],
    [...source.subarray(target.span.paddedEnd)]
  );

  const odd = replaceLeafPayload(doc, target, Uint8Array.of(4, 5, 6, 7, 8));
  const oddDoc = parseRifx(odd.bytes);
  const oddLeaf = findListsByFormType(oddDoc, "GCky")[0].children[0];
  assert.equal(oddLeaf.declaredSize, 5);
  assert.equal(odd.bytes[oddLeaf.span.dataEnd], 0, "new odd payload gets a deterministic pad");
  assert.equal(oddLeaf.span.paddedEnd - oddLeaf.span.dataEnd, 1);
  assert.equal(odd.bytes[33], 0x7f, "untouched prefix pad is preserved");
  assert.equal(odd.bytes[87], 0x5a, "untouched displaced suffix pad is preserved");
});

test("rejects malformed roots, sizes, pads, nesting, and unexplained container bytes", () => {
  assert.throws(() => parseRifx(new Uint8Array()), /truncated.*RIFX/i);
  assert.throws(
    () => parseRifx(concat(ascii("RIFF"), u32(4), ascii("AEfx"))),
    /little-endian RIFF/i
  );
  assert.throws(
    () => parseRifx(concat(ascii("NOPE"), u32(4), ascii("AEfx"))),
    /root.*RIFX/i
  );
  assert.throws(
    () => parseRifx(concat(ascii("RIFX"), u32(100), ascii("AEfx"))),
    /truncated.*root/i
  );
  assert.throws(
    () => parseRifx(concat(ascii("RIFX"), u32(3), ascii("ABC"))),
    /form type/i
  );

  const unexplainedBody = concat(ascii("AEfx"), Uint8Array.of(1, 2, 3));
  assert.throws(
    () => parseRifx(concat(ascii("RIFX"), u32(unexplainedBody.length), unexplainedBody)),
    /unexplained bytes/i
  );

  const oddLeafWithoutPad = concat(ascii("ODD!"), u32(1), Uint8Array.of(9));
  const missingPadBody = concat(ascii("AEfx"), oddLeafWithoutPad);
  assert.throws(
    () => parseRifx(concat(ascii("RIFX"), u32(missingPadBody.length), missingPadBody)),
    /truncated.*pad/i
  );

  const tinyList = concat(ascii("LIST"), u32(3), ascii("ABC"), Uint8Array.of(0));
  const tinyListBody = concat(ascii("AEfx"), tinyList);
  assert.throws(
    () => parseRifx(concat(ascii("RIFX"), u32(tinyListBody.length), tinyListBody)),
    /LIST.*form type/i
  );

  const shortList = chunk({ id: "LIST", formType: "ABCD", children: [] }).slice(0, 11);
  const shortListBody = concat(ascii("AEfx"), shortList);
  assert.throws(
    () => parseRifx(concat(ascii("RIFX"), u32(shortListBody.length), shortListBody)),
    /LIST|truncated/i
  );

  const nestedRoot = chunk({ id: "RIFX", payload: ascii("AEfx") } as SyntheticNode);
  const nestedBody = concat(ascii("AEfx"), nestedRoot);
  assert.throws(
    () => parseRifx(concat(ascii("RIFX"), u32(nestedBody.length), nestedBody)),
    /invalid nesting/i
  );
});

test("enforces explicit depth, node-count, and byte limits", () => {
  const source = rifx([
    {
      id: "LIST",
      formType: "L001",
      children: [
        { id: "LIST", formType: "L002", children: [leaf("DATA", [1, 2])] },
      ],
    },
  ]);
  assert.doesNotThrow(() => parseRifx(source, { maxDepth: 3, maxNodes: 4, maxBytes: source.length }));
  assert.throws(() => parseRifx(source, { maxDepth: 2 }), /depth limit/i);
  assert.throws(() => parseRifx(source, { maxNodes: 3 }), /node limit/i);
  assert.throws(() => parseRifx(source, { maxBytes: source.length - 1 }), /byte limit/i);
  assert.throws(() => parseRifx(source, { maxDepth: 0 }), /depth limit/i);
  assert.throws(() => parseRifx(source, { maxNodes: -1 }), /maxNodes/i);
});

test("rejects non-leaf and foreign patch targets", () => {
  const doc = parseRifx(nestedFixture());
  const list = findListsByFormType(doc, "GCky")[0];
  assert.throws(() => replaceLeafPayload(doc, list, Uint8Array.of(1)), /leaf/i);
  const other = parseRifx(rifx([leaf("DATA", [1])])).root.children[0];
  assert.throws(() => replaceLeafPayload(doc, other, Uint8Array.of(1)), /belong/i);
});

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
  };
}

test("seeded bounded synthetic trees preserve patch invariants", () => {
  const seed = 0x5eedc0de;
  const random = mulberry32(seed);
  let serial = 0;
  const nextCode = (prefix: string): string => `${prefix}${(serial++).toString(36).padStart(3, "0")}`.slice(-4);

  const buildNode = (depth: number): SyntheticNode => {
    if (depth < 3 && random() < 0.45) {
      const count = 1 + Math.floor(random() * 3);
      return {
        id: "LIST",
        formType: nextCode("F"),
        children: Array.from({ length: count }, () => buildNode(depth + 1)),
      };
    }
    const length = Math.floor(random() * 12);
    return {
      id: nextCode("C"),
      payload: Uint8Array.from({ length }, () => Math.floor(random() * 256)),
      pad: Math.floor(random() * 256),
    };
  };

  for (let iteration = 0; iteration < 48; iteration += 1) {
    try {
      serial = 0;
      const children = Array.from({ length: 1 + Math.floor(random() * 4) }, () => buildNode(1));
      const trailer = Uint8Array.from(
        { length: Math.floor(random() * 8) },
        () => Math.floor(random() * 256)
      );
      const source = rifx(children, trailer, "TEST");
      const original = source.slice();
      const doc = parseRifx(source, { maxDepth: 8, maxNodes: 256, maxBytes: 1_000_000 });
      const leaves: RiffNode[] = [];
      const stack = [doc.root];
      while (stack.length > 0) {
        const node = stack.pop()!;
        if (node.children.length === 0 && node.formType === null) leaves.push(node);
        else stack.push(...node.children);
      }
      const target = leaves[Math.floor(random() * leaves.length)];
      const replacement = Uint8Array.from(
        { length: Math.floor(random() * 16) },
        () => Math.floor(random() * 256)
      );
      const { bytes, report } = replaceLeafPayload(doc, target, replacement);
      assert.deepEqual(source, original, `seed=${seed} iteration=${iteration} source mutation`);
      assert.deepEqual(
        [...bytes.subarray(report.unchangedSuffix.newStart)],
        [...source.subarray(report.unchangedSuffix.oldStart)],
        `seed=${seed} iteration=${iteration} suffix`
      );
      assert.deepEqual(
        [...bytes.subarray(report.newDeclaredEnd)],
        [...source.subarray(report.oldDeclaredEnd)],
        `seed=${seed} iteration=${iteration} trailer`
      );
      assertPrefixOnlySizeWordsChanged(
        source,
        bytes,
        target.span.dataStart,
        [target.span.sizeFieldStart, ...report.ancestorSizePatches.map((patch) => patch.sizeFieldStart)],
        `seed=${seed} iteration=${iteration}`
      );
      const reparsed = parseRifx(bytes, { maxDepth: 8, maxNodes: 256, maxBytes: 1_000_000 });
      const reparsedTarget = findLeafById(reparsed.root, target.id);
      assert.deepEqual(
        [...bytes.subarray(reparsedTarget.span.dataStart, reparsedTarget.span.dataEnd)],
        [...replacement],
        `seed=${seed} iteration=${iteration} payload`
      );
    } catch (error) {
      throw new Error(`seed=${seed} iteration=${iteration}: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      });
    }
  }
});
