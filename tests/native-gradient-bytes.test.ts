import test from "node:test";
import assert from "node:assert/strict";
import {
  assertByteRange,
  checkedAdd,
  decodeUtf8,
  encodeUtf8,
  paddingForLength,
  paddedLength,
  readFourCC,
  readUint32BE,
  writeFourCC,
  writeUint32BE,
} from "../src/bytes.ts";

test("reads and writes unsigned 32-bit big-endian values", () => {
  const bytes = new Uint8Array([0x01, 0x23, 0x45, 0x67, 0, 0, 0, 0]);
  assert.equal(readUint32BE(bytes, 0), 0x01234567);
  writeUint32BE(bytes, 4, 0xfedcba98);
  assert.deepEqual([...bytes], [0x01, 0x23, 0x45, 0x67, 0xfe, 0xdc, 0xba, 0x98]);
});

test("reads and writes exact four-byte FourCC values", () => {
  const bytes = new Uint8Array(8);
  writeFourCC(bytes, 2, "RIFX");
  assert.equal(readFourCC(bytes, 2), "RIFX");
  assert.deepEqual([...bytes.slice(2, 6)], [0x52, 0x49, 0x46, 0x58]);
  assert.throws(() => writeFourCC(bytes, 0, "LISTS"), /FourCC/);
  assert.throws(() => writeFourCC(bytes, 0, "éABC"), /FourCC/);
});

test("round-trips strict UTF-8 without Buffer", () => {
  const text = "GCky → 色";
  assert.equal(decodeUtf8(encodeUtf8(text)), text);
  assert.throws(() => decodeUtf8(new Uint8Array([0xc3, 0x28])), /UTF-8/);
});

test("computes RIFF parity and padded lengths", () => {
  assert.equal(paddingForLength(0), 0);
  assert.equal(paddingForLength(1), 1);
  assert.equal(paddingForLength(2), 0);
  assert.equal(paddedLength(0), 0);
  assert.equal(paddedLength(3), 4);
  assert.equal(paddedLength(4), 4);
});

test("rejects invalid ranges, truncation, and arithmetic overflow", () => {
  const bytes = new Uint8Array(4);
  assert.doesNotThrow(() => assertByteRange(bytes, 0, 4, "whole"));
  assert.throws(() => assertByteRange(bytes, 2, 3, "payload"), /truncated.*payload/i);
  assert.throws(() => assertByteRange(bytes, -1, 1, "negative"), /offset/i);
  assert.throws(() => readUint32BE(bytes, 1), /truncated/i);
  assert.throws(() => writeUint32BE(bytes, 0, -1), /uint32/i);
  assert.throws(() => writeUint32BE(bytes, 0, 0x1_0000_0000), /uint32/i);
  assert.throws(() => checkedAdd(Number.MAX_SAFE_INTEGER, 1, "end"), /overflow/i);
  assert.throws(() => paddedLength(Number.MAX_SAFE_INTEGER), /overflow/i);
  assert.throws(() => paddingForLength(1.5), /length/i);
});
