import { decodeUtf8, encodeUtf8 } from "./bytes.ts";
import type {
  GradientAlphaStop,
  GradientColorStop,
  NativeGradient,
} from "./native-gradient-types.ts";

const MAX_XML_BYTES = 1_000_000;
const MAX_XML_ELEMENTS = 20_000;
const MAX_XML_DEPTH = 24;
const MAX_PARSED_STOPS = 1_024;
const XML_WHITESPACE = /[\t\n\r ]/;
const XML_WHITESPACE_ONLY = /^[\t\n\r ]*$/;
const XML_EDGE_WHITESPACE = /^[\t\n\r ]+|[\t\n\r ]+$/g;
const XML_NAME_START = /[A-Za-z_]/;
const XML_NAME_PART = /[A-Za-z0-9_.-]/;
const NUMBER_TEXT = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const UNSIGNED_INTEGER_TEXT = /^(?:0|[1-9]\d*)$/;

type XmlElement = {
  name: string;
  attributes: Map<string, string>;
  children: XmlElement[];
  text: string;
};

type PairEntry = {
  key: string;
  value: XmlElement;
};

function assertValidXmlCharacters(source: string): void {
  for (const character of source) {
    const codePoint = character.codePointAt(0)!;
    if (
      codePoint !== 0x09
      && codePoint !== 0x0a
      && codePoint !== 0x0d
      && !(codePoint >= 0x20 && codePoint <= 0xd7ff)
      && !(codePoint >= 0xe000 && codePoint <= 0xfffd)
      && !(codePoint >= 0x10000 && codePoint <= 0x10ffff)
    ) {
      throw new TypeError(`illegal XML 1.0 character U+${codePoint.toString(16).toUpperCase()}`);
    }
  }
}

function trimXmlWhitespace(value: string): string {
  return value.replace(XML_EDGE_WHITESPACE, "");
}

class NarrowXmlScanner {
  private index = 0;
  private elementCount = 0;
  private readonly source: string;

  constructor(source: string) {
    this.source = source;
  }

  parseDocument(): XmlElement {
    this.skipWhitespace();
    if (this.source.startsWith("<?xml", this.index)) {
      this.parseXmlDeclaration();
      this.skipWhitespace();
    }
    if (this.index >= this.source.length) {
      throw new TypeError("malformed XML: missing root element");
    }
    const root = this.parseElement(1);
    this.skipWhitespace();
    if (this.index !== this.source.length) {
      throw new TypeError("malformed XML: trailing unparsed structure");
    }
    return root;
  }

  private parseXmlDeclaration(): void {
    const end = this.source.indexOf("?>", this.index + 5);
    if (end < 0) throw new TypeError("malformed XML declaration");
    const declaration = this.source.slice(this.index, end + 2);
    if (!/^<\?xml[\t\n\r ]+version[\t\n\r ]*=[\t\n\r ]*(['"])1\.0\1[\t\n\r ]*\?>$/.test(declaration)) {
      throw new TypeError("unsupported XML declaration");
    }
    this.index = end + 2;
  }

  private parseElement(depth: number): XmlElement {
    if (depth > MAX_XML_DEPTH) throw new RangeError("XML depth limit exceeded");
    if (this.source[this.index] !== "<") throw new TypeError("malformed XML: expected element");
    if (this.source.startsWith("<!", this.index)) {
      throw new TypeError("DTD, entity, and other XML declarations are forbidden");
    }
    if (this.source.startsWith("<?", this.index)) {
      throw new TypeError("XML processing instructions are forbidden");
    }
    if (this.source.startsWith("</", this.index)) {
      throw new TypeError("malformed XML nesting: unexpected closing tag");
    }

    this.index += 1;
    const name = this.parseName();
    this.elementCount += 1;
    if (this.elementCount > MAX_XML_ELEMENTS) throw new RangeError("XML element limit exceeded");

    const attributes = new Map<string, string>();
    while (true) {
      const beforeWhitespace = this.index;
      this.skipWhitespace();
      if (this.source.startsWith("/>", this.index)) {
        this.index += 2;
        return { name, attributes, children: [], text: "" };
      }
      if (this.source[this.index] === ">") {
        this.index += 1;
        break;
      }
      if (this.index >= this.source.length) throw new TypeError("truncated XML start tag");
      if (this.index === beforeWhitespace) {
        throw new TypeError("malformed XML: attributes must be separated by whitespace");
      }
      const attributeName = this.parseName();
      if (attributes.has(attributeName)) {
        throw new TypeError(`duplicate XML attribute ${attributeName}`);
      }
      this.skipWhitespace();
      if (this.source[this.index] !== "=") {
        throw new TypeError(`malformed XML attribute ${attributeName}`);
      }
      this.index += 1;
      this.skipWhitespace();
      const quote = this.source[this.index];
      if (quote !== "'" && quote !== '"') {
        throw new TypeError(`malformed XML attribute ${attributeName}`);
      }
      this.index += 1;
      const valueStart = this.index;
      while (this.index < this.source.length && this.source[this.index] !== quote) {
        const character = this.source[this.index];
        if (character === "<" || character === ">" || character === "&") {
          throw new TypeError("XML entities and markup in attributes are forbidden");
        }
        this.index += 1;
      }
      if (this.index >= this.source.length) throw new TypeError("truncated XML attribute");
      attributes.set(attributeName, this.source.slice(valueStart, this.index));
      this.index += 1;
    }

    const children: XmlElement[] = [];
    let text = "";
    while (true) {
      if (this.index >= this.source.length) {
        throw new TypeError(`truncated XML: missing closing tag for ${name}`);
      }
      if (this.source.startsWith("</", this.index)) {
        this.index += 2;
        const closingName = this.parseName();
        this.skipWhitespace();
        if (this.source[this.index] !== ">") throw new TypeError("malformed XML closing tag");
        this.index += 1;
        if (closingName !== name) {
          throw new TypeError(`malformed XML nesting: expected </${name}> but found </${closingName}>`);
        }
        return { name, attributes, children, text };
      }
      if (this.source[this.index] === "<") {
        children.push(this.parseElement(depth + 1));
        continue;
      }

      const textStart = this.index;
      while (this.index < this.source.length && this.source[this.index] !== "<") {
        if (this.source[this.index] === "&") {
          throw new TypeError("XML entity references are forbidden");
        }
        this.index += 1;
      }
      text += this.source.slice(textStart, this.index);
    }
  }

  private parseName(): string {
    const start = this.index;
    if (!XML_NAME_START.test(this.source[this.index] ?? "")) {
      throw new TypeError("malformed XML name");
    }
    this.index += 1;
    while (this.index < this.source.length && XML_NAME_PART.test(this.source[this.index])) {
      this.index += 1;
    }
    return this.source.slice(start, this.index);
  }

  private skipWhitespace(): void {
    while (this.index < this.source.length && XML_WHITESPACE.test(this.source[this.index])) {
      this.index += 1;
    }
  }
}

function assertExactAttributes(
  element: XmlElement,
  expected: Readonly<Record<string, string>>,
  context: string,
): void {
  const entries = Object.entries(expected);
  if (element.attributes.size !== entries.length) {
    throw new TypeError(`${context} has unexpected or missing attributes`);
  }
  for (const [name, value] of entries) {
    if (element.attributes.get(name) !== value) {
      throw new TypeError(`${context} requires ${name}=${JSON.stringify(value)}`);
    }
  }
}

function assertElement(
  element: XmlElement,
  name: string,
  context: string,
  attributes: Readonly<Record<string, string>> = {},
): void {
  if (element.name !== name) throw new TypeError(`${context} must be <${name}>`);
  assertExactAttributes(element, attributes, context);
}

function requireContainer(element: XmlElement, name: string, context: string): void {
  assertElement(element, name, context);
  if (!XML_WHITESPACE_ONLY.test(element.text)) throw new TypeError(`${context} contains unexpected text`);
}

function requireLeafText(element: XmlElement, name: string, context: string): string {
  assertElement(element, name, context);
  if (element.children.length !== 0) throw new TypeError(`${context} must not contain child elements`);
  const value = trimXmlWhitespace(element.text);
  if (value.length === 0) throw new TypeError(`${context} must not be empty`);
  return value;
}

function readPairEntries(element: XmlElement, context: string): PairEntry[] {
  requireContainer(element, "prop.list", context);
  const entries: PairEntry[] = [];
  const seen = new Set<string>();
  for (const [index, pair] of element.children.entries()) {
    requireContainer(pair, "prop.pair", `${context} pair ${index}`);
    if (pair.children.length !== 2) {
      throw new TypeError(`${context} pair ${index} must contain exactly one key and one value`);
    }
    const key = requireLeafText(pair.children[0], "key", `${context} pair ${index} key`);
    if (seen.has(key)) throw new TypeError(`duplicate required key ${key} in ${context}`);
    seen.add(key);
    entries.push({ key, value: pair.children[1] });
  }
  return entries;
}

function requirePairMap(
  element: XmlElement,
  expectedKeys: readonly string[],
  context: string,
): Map<string, XmlElement> {
  const entries = readPairEntries(element, context);
  const expected = new Set(expectedKeys);
  const result = new Map<string, XmlElement>();
  for (const entry of entries) {
    if (!expected.has(entry.key)) throw new TypeError(`unexpected required key ${entry.key} in ${context}`);
    result.set(entry.key, entry.value);
  }
  for (const key of expectedKeys) {
    if (!result.has(key)) throw new TypeError(`missing required key ${key} in ${context}`);
  }
  return result;
}

function parseFiniteNumber(element: XmlElement, context: string): number {
  const text = requireLeafText(element, "float", context);
  if (!NUMBER_TEXT.test(text)) throw new TypeError(`${context} is not a well-formed number`);
  const value = Number(text);
  if (!Number.isFinite(value)) throw new TypeError(`${context} must be finite`);
  return value;
}

function parseStopArray(element: XmlElement, length: number, context: string): number[] {
  requireContainer(element, "array", context);
  if (element.children.length !== length + 1) {
    throw new TypeError(`${context} must contain array.type and exactly ${length} float values`);
  }
  const arrayType = element.children[0];
  requireContainer(arrayType, "array.type", `${context} array.type`);
  if (arrayType.children.length !== 1) throw new TypeError(`${context} array.type must contain one float type`);
  const floatType = arrayType.children[0];
  assertElement(floatType, "float", `${context} float type`);
  if (floatType.children.length !== 0 || !XML_WHITESPACE_ONLY.test(floatType.text)) {
    throw new TypeError(`${context} float type must be empty`);
  }
  return element.children.slice(1).map((child, index) =>
    parseFiniteNumber(child, `${context} value ${index}`));
}

function parseStopCount(element: XmlElement, context: string): number {
  assertElement(element, "int", context, { type: "unsigned", size: "32" });
  if (element.children.length !== 0) throw new TypeError(`${context} must not contain child elements`);
  const text = trimXmlWhitespace(element.text);
  if (!UNSIGNED_INTEGER_TEXT.test(text)) throw new TypeError(`${context} is not an unsigned count`);
  const count = Number(text);
  if (!Number.isSafeInteger(count) || count > MAX_PARSED_STOPS) {
    throw new RangeError(`${context} exceeds the parsed stop count limit`);
  }
  return count;
}

function parseStops(
  element: XmlElement,
  kind: "Color" | "Alpha",
): GradientColorStop[] | GradientAlphaStop[] {
  const context = `${kind} Stops`;
  const pairs = requirePairMap(element, ["Stops List", "Stops Size"], context);
  const count = parseStopCount(pairs.get("Stops Size")!, `${context} Stops Size`);
  const entries = readPairEntries(pairs.get("Stops List")!, `${context} Stops List`);
  if (entries.length !== count) {
    throw new TypeError(`${context} count mismatch: Stops Size is ${count}, list has ${entries.length}`);
  }

  const seenIndexes = new Set<number>();
  const values: (GradientColorStop | GradientAlphaStop)[] = [];
  for (const [position, entry] of entries.entries()) {
    const match = /^Stop-(0|[1-9]\d*)$/.exec(entry.key);
    if (match === null) throw new TypeError(`${context} has malformed stop key ${entry.key}`);
    const stopIndex = Number(match[1]);
    if (stopIndex >= count) throw new TypeError(`${context} stop key ${entry.key} exceeds Stops Size`);
    if (seenIndexes.has(stopIndex)) throw new TypeError(`${context} has duplicate stop index ${stopIndex}`);
    if (stopIndex !== position) {
      throw new TypeError(`${context} stop key ${entry.key} does not match list position ${position}`);
    }
    seenIndexes.add(stopIndex);

    const stopPairs = requirePairMap(
      entry.value,
      [`Stops ${kind}`],
      `${context} ${entry.key}`,
    );
    const arrayValues = parseStopArray(
      stopPairs.get(`Stops ${kind}`)!,
      kind === "Color" ? 6 : 3,
      `${context} ${entry.key} array at list position ${position}`,
    );
    if (kind === "Color") {
      values.push({
        offset: arrayValues[0],
        midpoint: arrayValues[1],
        rgb: [arrayValues[2], arrayValues[3], arrayValues[4]],
        extra: arrayValues[5],
      });
    } else {
      values.push({ offset: arrayValues[0], midpoint: arrayValues[1], alpha: arrayValues[2] });
    }
  }

  if (seenIndexes.size !== count) throw new TypeError(`${context} is missing required stop keys`);
  return kind === "Color"
    ? values as GradientColorStop[]
    : values as GradientAlphaStop[];
}

function parseGradientRoot(root: XmlElement): NativeGradient {
  assertElement(root, "prop.map", "gradient root", { version: "4" });
  if (!XML_WHITESPACE_ONLY.test(root.text)) throw new TypeError("gradient root contains unexpected text");
  if (root.children.length !== 1) {
    throw new TypeError("gradient root must contain exactly one prop.list");
  }

  const rootPairs = requirePairMap(
    root.children[0],
    ["Gradient Color Data", "Gradient Colors"],
    "gradient root list",
  );
  const gradientVersion = requireLeafText(
    rootPairs.get("Gradient Colors")!,
    "string",
    "Gradient Colors version",
  );
  if (gradientVersion !== "1.0") throw new TypeError(`unsupported Gradient Colors version ${gradientVersion}`);

  const dataPairs = requirePairMap(
    rootPairs.get("Gradient Color Data")!,
    ["Alpha Stops", "Color Stops"],
    "Gradient Color Data",
  );
  return {
    schemaVersion: 1,
    colorStops: parseStops(dataPairs.get("Color Stops")!, "Color") as GradientColorStop[],
    alphaStops: parseStops(dataPairs.get("Alpha Stops")!, "Alpha") as GradientAlphaStop[],
  };
}

function requireRecord(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${context} must be an object`);
  }
  return value as Record<string, unknown>;
}

function normalizeFiniteNumber(value: unknown, context: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${context} must be a finite number`);
  }
  const normalized = Math.fround(value);
  if (!Number.isFinite(normalized)) {
    throw new RangeError(`${context} is outside the finite float32 range`);
  }
  return normalized;
}

function normalizeUnitNumber(value: unknown, context: string): number {
  const normalized = normalizeFiniteNumber(value, context);
  if ((value as number) < 0 || (value as number) > 1) {
    throw new RangeError(`${context} must be in [0,1]`);
  }
  return normalized;
}

function requireStopArray(value: unknown, context: string): unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${context} must be an array`);
  const length = value.length;
  if (length < 2 || length > 8) {
    throw new RangeError(`${context} must contain 2..8 stops`);
  }
  const snapshot = new Array<unknown>(length);
  for (let index = 0; index < length; index += 1) snapshot[index] = value[index];
  return snapshot;
}

export function parseGradientUtf8Payload(data: Uint8Array): NativeGradient {
  if (!(data instanceof Uint8Array)) throw new TypeError("gradient payload must be a Uint8Array");
  if (data.byteLength > MAX_XML_BYTES) throw new RangeError("gradient XML exceeds the byte size limit");
  const xml = decodeUtf8(data);
  assertValidXmlCharacters(xml);
  if (xml.includes("<!") || /<!DOCTYPE/i.test(xml)) {
    throw new TypeError("DTD, entity, and other XML declarations are forbidden");
  }
  if (xml.includes("&")) throw new TypeError("XML entity references are forbidden");
  return parseGradientRoot(new NarrowXmlScanner(xml).parseDocument());
}

export function validateGeneratedGradient(value: unknown): NativeGradient {
  const gradient = requireRecord(value, "gradient");
  if (gradient.schemaVersion !== 1) throw new TypeError("gradient schemaVersion must be 1");

  const colorInput = requireStopArray(gradient.colorStops, "colorStops");
  const colorStops: GradientColorStop[] = [];
  let previousColorOffset = -Infinity;
  for (const [index, candidate] of colorInput.entries()) {
    const stop = requireRecord(candidate, `colorStops[${index}]`);
    const rawOffset = stop.offset;
    const rawMidpoint = stop.midpoint;
    const rawRgb = stop.rgb;
    const rawExtra = stop.extra;
    const offset = normalizeUnitNumber(rawOffset, `colorStops[${index}].offset`);
    if ((rawOffset as number) < previousColorOffset) {
      throw new RangeError("color stop offsets must be nondecreasing");
    }
    previousColorOffset = rawOffset as number;
    const midpoint = normalizeUnitNumber(rawMidpoint, `colorStops[${index}].midpoint`);
    if (!Array.isArray(rawRgb) || rawRgb.length !== 3) {
      throw new TypeError(`colorStops[${index}].rgb must be a three-number tuple`);
    }
    const red = rawRgb[0];
    const green = rawRgb[1];
    const blue = rawRgb[2];
    colorStops.push({
      offset,
      midpoint,
      rgb: [
        normalizeFiniteNumber(red, `colorStops[${index}].rgb[0]`),
        normalizeFiniteNumber(green, `colorStops[${index}].rgb[1]`),
        normalizeFiniteNumber(blue, `colorStops[${index}].rgb[2]`),
      ],
      extra: normalizeFiniteNumber(rawExtra, `colorStops[${index}].extra`),
    });
  }

  const alphaInput = requireStopArray(gradient.alphaStops, "alphaStops");
  const alphaStops: GradientAlphaStop[] = [];
  let previousAlphaOffset = -Infinity;
  for (const [index, candidate] of alphaInput.entries()) {
    const stop = requireRecord(candidate, `alphaStops[${index}]`);
    const rawOffset = stop.offset;
    const rawMidpoint = stop.midpoint;
    const rawAlpha = stop.alpha;
    const offset = normalizeUnitNumber(rawOffset, `alphaStops[${index}].offset`);
    if ((rawOffset as number) < previousAlphaOffset) {
      throw new RangeError("alpha stop offsets must be nondecreasing");
    }
    previousAlphaOffset = rawOffset as number;
    alphaStops.push({
      offset,
      midpoint: normalizeUnitNumber(rawMidpoint, `alphaStops[${index}].midpoint`),
      alpha: normalizeUnitNumber(rawAlpha, `alphaStops[${index}].alpha`),
    });
  }

  return { schemaVersion: 1, colorStops, alphaStops };
}

function formatFloat32(value: number): string {
  const text = String(Math.fround(value));
  if (!/[eE]/.test(text)) return text;

  const match = /^(-?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(text);
  if (match === null) throw new TypeError(`cannot serialize float32 value ${text}`);
  const [, sign, integer, fraction = "", exponentText] = match;
  const digits = `${integer}${fraction}`;
  const decimalPosition = integer.length + Number(exponentText);
  if (decimalPosition <= 0) return `${sign}0.${"0".repeat(-decimalPosition)}${digits}`;
  if (decimalPosition >= digits.length) {
    return `${sign}${digits}${"0".repeat(decimalPosition - digits.length)}`;
  }
  return `${sign}${digits.slice(0, decimalPosition)}.${digits.slice(decimalPosition)}`;
}

function stopLines(kind: "Alpha" | "Color", stops: readonly (GradientAlphaStop | GradientColorStop)[]): string[] {
  const lines = [
    "<prop.pair>",
    `<key>${kind} Stops</key>`,
    "<prop.list>",
    "<prop.pair>",
    "<key>Stops List</key>",
    "<prop.list>",
  ];
  for (const [index, stop] of stops.entries()) {
    const values = kind === "Alpha"
      ? [(stop as GradientAlphaStop).offset, (stop as GradientAlphaStop).midpoint, (stop as GradientAlphaStop).alpha]
      : [
          (stop as GradientColorStop).offset,
          (stop as GradientColorStop).midpoint,
          ...(stop as GradientColorStop).rgb,
          (stop as GradientColorStop).extra,
        ];
    lines.push(
      "<prop.pair>",
      `<key>Stop-${index}</key>`,
      "<prop.list>",
      "<prop.pair>",
      `<key>Stops ${kind}</key>`,
      "<array>",
      "<array.type><float/></array.type>",
      ...values.map((number) => `<float>${formatFloat32(number)}</float>`),
      "</array>",
      "</prop.pair>",
      "</prop.list>",
      "</prop.pair>",
    );
  }
  lines.push(
    "</prop.list>",
    "</prop.pair>",
    "<prop.pair>",
    "<key>Stops Size</key>",
    `<int type='unsigned' size='32'>${stops.length}</int>`,
    "</prop.pair>",
    "</prop.list>",
    "</prop.pair>",
  );
  return lines;
}

export function serializeGradientUtf8Payload(value: NativeGradient): Uint8Array {
  const gradient = validateGeneratedGradient(value);
  const lines = [
    "<?xml version='1.0'?>",
    "<prop.map version='4'>",
    "<prop.list>",
    "<prop.pair>",
    "<key>Gradient Color Data</key>",
    "<prop.list>",
    ...stopLines("Alpha", gradient.alphaStops),
    ...stopLines("Color", gradient.colorStops),
    "</prop.list>",
    "</prop.pair>",
    "<prop.pair>",
    "<key>Gradient Colors</key>",
    "<string>1.0</string>",
    "</prop.pair>",
    "</prop.list>",
    "</prop.map>",
  ];
  return encodeUtf8(`${lines.join("\n")}\n`);
}
