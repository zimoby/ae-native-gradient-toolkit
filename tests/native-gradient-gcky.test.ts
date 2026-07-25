import test from "node:test";
import assert from "node:assert/strict";
import {
  parseGradientUtf8Payload,
  serializeGradientUtf8Payload,
  validateGeneratedGradient,
} from "../src/gcky-gradient.ts";
import type { NativeGradient } from "../src/native-gradient-types.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

type StopSpec = {
  key?: string;
  values: readonly (number | string)[];
};

type GradientXmlOptions = {
  mapVersion?: string;
  colorStops?: readonly StopSpec[];
  alphaStops?: readonly StopSpec[];
  colorCount?: number | string;
  alphaCount?: number | string;
  gradientVersion?: string;
  colorFirst?: boolean;
};

function stopsBlock(kind: "Color" | "Alpha", stops: readonly StopSpec[], count: number | string): string {
  const stopPairs = stops.map((stop, index) => `
<prop.pair>
<key>${stop.key ?? `Stop-${index}`}</key>
<prop.list>
<prop.pair>
<key>Stops ${kind}</key>
<array>
<array.type><float/></array.type>
${stop.values.map((value) => `<float>${String(value)}</float>`).join("\n")}
</array>
</prop.pair>
</prop.list>
</prop.pair>`).join("");

  return `<prop.pair>
<key>${kind} Stops</key>
<prop.list>
<prop.pair>
<key>Stops List</key>
<prop.list>${stopPairs}
</prop.list>
</prop.pair>
<prop.pair>
<key>Stops Size</key>
<int type='unsigned' size='32'>${String(count)}</int>
</prop.pair>
</prop.list>
</prop.pair>`;
}

function gradientXml(options: GradientXmlOptions = {}): string {
  const colorStops = options.colorStops ?? [
    { values: [0, 0.5, 1, 0, 0, 1] },
    { values: [1, 0.5, 0, 0, 1, 1] },
  ];
  const alphaStops = options.alphaStops ?? [
    { values: [0, 0.5, 1] },
    { values: [1, 0.5, 1] },
  ];
  const color = stopsBlock("Color", colorStops, options.colorCount ?? colorStops.length);
  const alpha = stopsBlock("Alpha", alphaStops, options.alphaCount ?? alphaStops.length);
  const orderedBlocks = options.colorFirst ? `${color}\n${alpha}` : `${alpha}\n${color}`;

  return `<?xml version='1.0'?>
<prop.map version='${options.mapVersion ?? "4"}'>
<prop.list>
<prop.pair>
<key>Gradient Color Data</key>
<prop.list>
${orderedBlocks}
</prop.list>
</prop.pair>
<prop.pair>
<key>Gradient Colors</key>
<string>${options.gradientVersion ?? "1.0"}</string>
</prop.pair>
</prop.list>
</prop.map>
`;
}

const bytes = (xml: string): Uint8Array => encoder.encode(xml);

const richGradient: NativeGradient = {
  schemaVersion: 1,
  colorStops: [
    { offset: 0, midpoint: 0.125, rgb: [-0.25, 1.5, 0.1], extra: 0.75 },
    { offset: 0.4, midpoint: 0.625, rgb: [2.25, -1, 0.3], extra: -4.5 },
    { offset: 0.4, midpoint: 0.875, rgb: [0, 0.5, 4], extra: 9.25 },
  ],
  alphaStops: [
    { offset: 0, midpoint: 0.2, alpha: 1 },
    { offset: 0.75, midpoint: 0.7, alpha: 0.35 },
    { offset: 1, midpoint: 0.9, alpha: 0 },
  ],
};

test("parses exact independent color/alpha lists without sorting or deduplicating", () => {
  const value = parseGradientUtf8Payload(bytes(gradientXml({
    colorFirst: true,
    colorStops: [
      { values: [0, 0.125, -0.25, 1.5, 0.1, 0.75] },
      { values: [0.4, 0.625, 2.25, -1, 0.3, -4.5] },
      { values: [0.4, 0.875, 0, 0.5, 4, 9.25] },
    ],
    alphaStops: [
      { values: [0, 0.2, 1] },
      { values: [0.75, 0.7, 0.35] },
      { values: [1, 0.9, 0] },
    ],
  })));

  assert.deepEqual(value, richGradient);
  assert.equal(value.colorStops[1].offset, value.colorStops[2].offset);
  assert.notDeepEqual(
    value.colorStops.map((stop) => stop.offset),
    value.alphaStops.map((stop) => stop.offset),
  );
});

test("parser preserves source stop-list order even when offsets decrease", () => {
  const value = parseGradientUtf8Payload(bytes(gradientXml({
    colorStops: [
      { values: [0.8, 0.3, 1, 0, 0, 1] },
      { values: [0.2, 0.7, 0, 0, 1, 1] },
    ],
  })));
  assert.deepEqual(value.colorStops.map((stop) => stop.offset), [0.8, 0.2]);
});

test("parser rejects malformed, duplicate, out-of-range, and out-of-order stop keys", () => {
  const values = [0, 0.5, 1, 0, 0, 1];
  const cases: Array<[string, readonly StopSpec[]]> = [
    ["leading zero", [{ key: "Stop-00", values }, { key: "Stop-1", values }]],
    ["non-numeric", [{ key: "Stop-x", values }, { key: "Stop-1", values }]],
    ["duplicate", [{ key: "Stop-0", values }, { key: "Stop-0", values }]],
    ["out of range", [{ key: "Stop-2", values }, { key: "Stop-1", values }]],
    ["out of order", [{ key: "Stop-1", values }, { key: "Stop-0", values }]],
  ];
  for (const [label, colorStops] of cases) {
    assert.throws(
      () => parseGradientUtf8Payload(bytes(gradientXml({ colorStops }))),
      /stop key|stop index|list position|duplicate required key/i,
      label,
    );
  }
});

test("serializes canonical UTF-8 XML with deterministic float32 strings only", () => {
  const first = serializeGradientUtf8Payload(richGradient);
  const second = serializeGradientUtf8Payload(richGradient);
  assert.deepEqual(first, second);

  const xml = decoder.decode(first);
  assert.match(xml, /^<\?xml version='1\.0'\?>\n<prop\.map version='4'>\n/);
  assert.match(xml, /<key>Alpha Stops<\/key>[\s\S]*<key>Color Stops<\/key>/);
  assert.match(xml, /<float>0\.10000000149011612<\/float>/);
  assert.match(xml, /<float>0\.4000000059604645<\/float>/);
  assert.match(xml, /<float>2\.25<\/float>/);
  assert.match(xml, /<float>-4\.5<\/float>/);
  assert.equal(xml.endsWith("</prop.map>\n"), true);
  assert.equal(xml.includes("RIFX"), false);
  assert.equal(xml.includes("GCky"), false);
  assert.equal(first.length, encoder.encode(xml).length, "payload contains exactly canonical UTF-8 bytes");
});

test("serializes finite float32 boundary values without exponent notation", () => {
  const boundaryGradient: NativeGradient = {
    schemaVersion: 1,
    colorStops: [
      { offset: 0, midpoint: 1e-8, rgb: [1e-8, 1e30, 1e-45], extra: -1e30 },
      { offset: 1, midpoint: 1, rgb: [0, 0, 0], extra: 0 },
    ],
    alphaStops: [
      { offset: 0, midpoint: 1e-8, alpha: 1e-8 },
      { offset: 1, midpoint: 1, alpha: 1 },
    ],
  };
  const serialized = serializeGradientUtf8Payload(boundaryGradient);
  const xml = decoder.decode(serialized);
  const floatTexts = [...xml.matchAll(/<float>([^<]+)<\/float>/g)].map((match) => match[1]);
  assert.ok(floatTexts.length > 0);
  assert.equal(floatTexts.some((text) => /[eE]/.test(text)), false);
  assert.ok(floatTexts.every((text) => /^-?\d+(?:\.\d+)?$/.test(text)));
  assert.deepEqual(parseGradientUtf8Payload(serialized), validateGeneratedGradient(boundaryGradient));
});

test("serialize/parse round-trip returns a normalized fresh model", () => {
  const expected = validateGeneratedGradient(richGradient);
  const parsed = parseGradientUtf8Payload(serializeGradientUtf8Payload(richGradient));
  assert.deepEqual(parsed, expected);
  assert.notEqual(parsed, richGradient);
  assert.notEqual(parsed.colorStops, richGradient.colorStops);
  assert.notEqual(parsed.colorStops[0], richGradient.colorStops[0]);
  assert.notEqual(parsed.colorStops[0].rgb, richGradient.colorStops[0].rgb);
  assert.notEqual(parsed.alphaStops, richGradient.alphaStops);
});

test("validator enforces generator limits and returns float32-normalized copies", () => {
  const caller = structuredClone(richGradient);
  const validated = validateGeneratedGradient(caller);
  assert.equal(validated.colorStops[0].rgb[2], Math.fround(0.1));
  assert.equal(validated.colorStops[1].offset, Math.fround(0.4));
  assert.notEqual(validated, caller);
  assert.notEqual(validated.colorStops, caller.colorStops);
  assert.notEqual(validated.colorStops[0].rgb, caller.colorStops[0].rgb);

  caller.colorStops[0].rgb[0] = 99;
  assert.equal(validated.colorStops[0].rgb[0], Math.fround(-0.25));

  const invalidValues: unknown[] = [
    null,
    {},
    { ...richGradient, schemaVersion: 2 },
    { ...richGradient, colorStops: richGradient.colorStops.slice(0, 1) },
    { ...richGradient, alphaStops: [...richGradient.alphaStops, ...richGradient.alphaStops, ...richGradient.alphaStops] },
    { ...richGradient, colorStops: [richGradient.colorStops[1], richGradient.colorStops[0]] },
    { ...richGradient, alphaStops: [richGradient.alphaStops[1], richGradient.alphaStops[0]] },
    { ...richGradient, colorStops: [{ ...richGradient.colorStops[0], offset: -0.1 }, ...richGradient.colorStops.slice(1)] },
    { ...richGradient, alphaStops: [{ ...richGradient.alphaStops[0], midpoint: 1.1 }, ...richGradient.alphaStops.slice(1)] },
    { ...richGradient, alphaStops: [{ ...richGradient.alphaStops[0], alpha: Number.NaN }, ...richGradient.alphaStops.slice(1)] },
    { ...richGradient, colorStops: [{ ...richGradient.colorStops[0], rgb: [0, Infinity, 0] }, ...richGradient.colorStops.slice(1)] },
    { ...richGradient, colorStops: [{ ...richGradient.colorStops[0], extra: Number.NaN }, ...richGradient.colorStops.slice(1)] },
  ];
  for (const invalid of invalidValues) {
    assert.throws(() => validateGeneratedGradient(invalid));
  }
});

test("validator snapshots bounded stop arrays and reads offsets once", () => {
  const colors: Record<string, unknown>[] = [
    { midpoint: 0.5, rgb: [1, 0, 0], extra: 1 },
    { offset: 1, midpoint: 0.5, rgb: [0, 0, 1], extra: 1 },
  ];
  let expanded = false;
  Object.defineProperty(colors[0], "offset", {
    enumerable: true,
    get() {
      if (!expanded) {
        expanded = true;
        colors.splice(1, 0, ...Array.from({ length: 8 }, (_, index) => ({
          offset: (index + 1) / 10,
          midpoint: 0.5,
          rgb: [0, 1, 0],
          extra: 1,
        })));
      }
      return 0;
    },
  });
  const bounded = validateGeneratedGradient({ ...richGradient, colorStops: colors });
  assert.equal(bounded.colorStops.length, 2);
  assert.deepEqual(bounded.colorStops.map((stop) => stop.offset), [0, 1]);

  let firstReads = 0;
  let secondReads = 0;
  const changingOffsets = [
    {
      get offset() {
        firstReads += 1;
        return firstReads < 3 ? 1 : -1;
      },
      midpoint: 0.5,
      rgb: [1, 0, 0],
      extra: 1,
    },
    {
      get offset() {
        secondReads += 1;
        return 0;
      },
      midpoint: 0.5,
      rgb: [0, 0, 1],
      extra: 1,
    },
  ];
  assert.throws(
    () => validateGeneratedGradient({ ...richGradient, colorStops: changingOffsets }),
    /nondecreasing|offset/i,
  );
  assert.equal(firstReads, 1);
  assert.equal(secondReads, 1);
});

test("rejects invalid UTF-8 and malformed XML/nesting", () => {
  assert.throws(() => parseGradientUtf8Payload(new Uint8Array([0xc3, 0x28])), /UTF-8/i);
  assert.throws(
    () => parseGradientUtf8Payload(bytes(gradientXml().replace("</array>", "</prop.list>"))),
    /XML|closing|nesting/i,
  );
  assert.throws(() => parseGradientUtf8Payload(bytes("<prop.map version='4'>")), /XML|closing|truncated/i);
});

test("rejects illegal XML characters and non-XML container whitespace", () => {
  const xml = gradientXml();
  assert.throws(
    () => parseGradientUtf8Payload(bytes(xml.replace("<prop.list>\n", "<prop.list>\u000b"))),
    /XML|character|text|malformed/i,
  );
  assert.throws(
    () => parseGradientUtf8Payload(bytes(xml.replace("<prop.list>\n", "<prop.list>\u00a0"))),
    /XML|character|text|malformed/i,
  );
});

test("rejects missing and duplicate required keys", () => {
  const xml = gradientXml();
  assert.throws(
    () => parseGradientUtf8Payload(bytes(xml.replace(/<prop.pair>\n<key>Gradient Colors<\/key>[\s\S]*?<\/prop.pair>\n(?=<\/prop.list>\n<\/prop.map>)/, ""))),
    /Gradient Colors|missing|required/i,
  );
  assert.throws(
    () => parseGradientUtf8Payload(bytes(xml.replace("<key>Stops Size</key>", "<key>Not Stops Size</key>"))),
    /Stops Size|missing|required|unexpected/i,
  );
  assert.throws(
    () => parseGradientUtf8Payload(bytes(xml.replace(
      "</prop.list>\n</prop.map>",
      "<prop.pair>\n<key>Gradient Colors</key>\n<string>1.0</string>\n</prop.pair>\n</prop.list>\n</prop.map>",
    ))),
    /duplicate.*Gradient Colors|Gradient Colors.*duplicate/i,
  );
});

test("rejects unsupported versions, count mismatch, huge counts, and malformed numbers", () => {
  assert.throws(() => parseGradientUtf8Payload(bytes(gradientXml({ mapVersion: "3" }))), /version/i);
  assert.throws(() => parseGradientUtf8Payload(bytes(gradientXml({ gradientVersion: "2.0" }))), /Gradient Colors|version/i);
  assert.throws(() => parseGradientUtf8Payload(bytes(gradientXml({ colorCount: 3 }))), /count|Stops Size/i);
  assert.throws(() => parseGradientUtf8Payload(bytes(gradientXml({ alphaCount: 1_000_000 }))), /count|limit/i);
  assert.throws(
    () => parseGradientUtf8Payload(bytes(gradientXml({ colorStops: [
      { values: [0, 0.5, "NaN", 0, 0, 1] },
      { values: [1, 0.5, 0, 0, 1, 1] },
    ] }))),
    /number|finite|float/i,
  );
  assert.throws(
    () => parseGradientUtf8Payload(bytes(gradientXml({ alphaStops: [
      { values: [0, 0.5, "Infinity"] },
      { values: [1, 0.5, 1] },
    ] }))),
    /number|finite|float/i,
  );
});

test("rejects DTD/entity declarations, oversized XML, and trailing structure", () => {
  assert.throws(
    () => parseGradientUtf8Payload(bytes(`<!DOCTYPE prop.map [<!ENTITY x "1">]>\n${gradientXml()}`)),
    /DTD|DOCTYPE|declaration|entity/i,
  );
  assert.throws(
    () => parseGradientUtf8Payload(bytes(gradientXml().replace("<float>1</float>", "<float>&x;</float>"))),
    /entity|ampersand|XML/i,
  );
  assert.throws(
    () => parseGradientUtf8Payload(bytes(`${gradientXml()}${gradientXml()}`)),
    /trailing|structure|XML/i,
  );
  const oversized = `${gradientXml()}${" ".repeat(1_100_000)}`;
  assert.throws(() => parseGradientUtf8Payload(bytes(oversized)), /size|large|limit/i);
});
