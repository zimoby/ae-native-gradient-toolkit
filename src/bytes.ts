const UINT32_MAX = 0xffff_ffff;

function requireNonNegativeSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
}

export function checkedAdd(left: number, right: number, context = "byte offset"): number {
  requireNonNegativeSafeInteger(left, "left operand");
  requireNonNegativeSafeInteger(right, "right operand");
  const result = left + right;
  if (!Number.isSafeInteger(result)) {
    throw new RangeError(`${context} overflow`);
  }
  return result;
}

export function assertByteRange(
  source: Uint8Array,
  offset: number,
  length: number,
  context = "byte range"
): void {
  requireNonNegativeSafeInteger(offset, "offset");
  requireNonNegativeSafeInteger(length, "length");
  const end = checkedAdd(offset, length, `${context} end`);
  if (end > source.byteLength) {
    throw new RangeError(`truncated ${context}: need bytes ${offset}..${end}, length is ${source.byteLength}`);
  }
}

export function readUint32BE(source: Uint8Array, offset: number): number {
  assertByteRange(source, offset, 4, "uint32");
  return new DataView(source.buffer, source.byteOffset, source.byteLength).getUint32(offset, false);
}

export function writeUint32BE(target: Uint8Array, offset: number, value: number): void {
  assertByteRange(target, offset, 4, "uint32");
  if (!Number.isInteger(value) || value < 0 || value > UINT32_MAX) {
    throw new RangeError("value must be a uint32");
  }
  new DataView(target.buffer, target.byteOffset, target.byteLength).setUint32(offset, value, false);
}

export function readFourCC(source: Uint8Array, offset: number): string {
  assertByteRange(source, offset, 4, "FourCC");
  let result = "";
  for (let index = 0; index < 4; index += 1) {
    const value = source[offset + index];
    if (value < 0x20 || value > 0x7e) {
      throw new Error(`invalid FourCC byte 0x${value.toString(16).padStart(2, "0")}`);
    }
    result += String.fromCharCode(value);
  }
  return result;
}

export function writeFourCC(target: Uint8Array, offset: number, value: string): void {
  assertByteRange(target, offset, 4, "FourCC");
  if (value.length !== 4) {
    throw new TypeError("FourCC must contain exactly four printable ASCII characters");
  }
  for (let index = 0; index < 4; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code > 0x7e) {
      throw new TypeError("FourCC must contain exactly four printable ASCII characters");
    }
    target[offset + index] = code;
  }
}

export function encodeUtf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

export function decodeUtf8(value: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch (error) {
    throw new TypeError(`invalid UTF-8: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function paddingForLength(length: number): 0 | 1 {
  requireNonNegativeSafeInteger(length, "length");
  return (length & 1) as 0 | 1;
}

export function paddedLength(length: number): number {
  return checkedAdd(length, paddingForLength(length), "padded length");
}
