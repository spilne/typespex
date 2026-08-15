import { describe, expect, test } from "bun:test";
import {
  Decoders,
  JsonSerializers,
  ResponseEncoders,
  ValidationError,
  Validators,
  XmlCodec,
  XmlCodecs,
  XmlSerializationError,
  decodeBody,
  isLeft,
} from "../src/server.js";

interface SimpleModel {
  name: string;
  age: number;
}

interface ArrayDocument {
  colors: string[];
  items: SimpleModel[];
  metadata: Record<string, string>;
}

const stringCodec = XmlCodecs.scalar("string", Decoders.string, JsonSerializers.identity<string>());
const int32Codec = XmlCodecs.scalar(
  "int32",
  Decoders.integer.validate(
    Validators.minValue(-2_147_483_648),
    Validators.maxValue(2_147_483_647),
  ),
  JsonSerializers.identity<number>(),
);
const simpleModelCodec = XmlCodecs.object<SimpleModel>(
  "SimpleModel",
  [
    { property: "name", name: "name", codec: stringCodec },
    { property: "age", name: "age", codec: int32Codec },
  ],
  { allowUnknown: true },
);

const arrayDocumentCodec = XmlCodecs.object<ArrayDocument>(
  "ArrayDocument",
  [
    {
      property: "colors",
      name: "Colors",
      codec: XmlCodecs.array("Array", stringCodec),
    },
    {
      property: "items",
      name: "ModelItem",
      codec: XmlCodecs.array("Array", simpleModelCodec),
      unwrapped: true,
    },
    {
      property: "metadata",
      name: "metadata",
      codec: XmlCodecs.record("Record", stringCodec),
    },
  ],
  { allowUnknown: true },
);

describe("XML codecs", () => {
  test("preserves wildcard fallback for textual and binary media families", async () => {
    const rawText = await decodeBody(
      new Request("http://localhost/raw", {
        method: "PUT",
        headers: { "content-type": "text/xml" },
        body: "<unmodeled />",
      }),
      { text: Decoders.string },
      { contentTypes: ["text/*"] },
    );
    expect(rawText).toEqual({ _tag: "Right", right: "<unmodeled />" });

    const rawBytes = await decodeBody(
      new Request("http://localhost/image", {
        method: "PUT",
        headers: { "content-type": "image/svg+xml" },
        body: "<svg />",
      }),
      { binary: Decoders.bytes },
      { contentTypes: ["image/*"] },
    );
    expect(rawBytes).toEqual({
      _tag: "Right",
      right: new TextEncoder().encode("<svg />"),
    });
  });

  test("decodes and encodes wrapped arrays, unwrapped model arrays, and records", async () => {
    const xml = `
      <ArrayDocument>
        <Colors><string>red</string><string>green</string></Colors>
        <ModelItem><name>one</name><age>1</age></ModelItem>
        <ModelItem><name>two</name><age>2</age></ModelItem>
        <metadata><Color>blue</Color><Enabled>false</Enabled></metadata>
      </ArrayDocument>`;
    const decoded = await decodeBody(
      new Request("http://localhost/items", {
        method: "PUT",
        headers: { "content-type": "application/xml" },
        body: xml,
      }),
      { xml: arrayDocumentCodec },
      { contentTypes: ["application/xml"] },
    );

    expect(decoded).toEqual({
      _tag: "Right",
      right: {
        colors: ["red", "green"],
        items: [
          { name: "one", age: 1 },
          { name: "two", age: 2 },
        ],
        metadata: { Color: "blue", Enabled: "false" },
      },
    });

    expect(
      arrayDocumentCodec.serialize({
        colors: [],
        items: [{ name: "one", age: 1 }],
        metadata: { Color: "blue", Enabled: "false" },
      }),
    ).toBe(
      "<ArrayDocument><Colors/><ModelItem><name>one</name><age>1</age></ModelItem><metadata><Color>blue</Color><Enabled>false</Enabled></metadata></ArrayDocument>",
    );

    const whitespace = await decodeBody(
      new Request("http://localhost/model", {
        method: "PUT",
        headers: { "content-type": "application/xml" },
        body: "<SimpleModel><name>  preserved  </name><age>\n  3  \n</age></SimpleModel>",
      }),
      { xml: simpleModelCodec },
    );
    expect(whitespace).toEqual({
      _tag: "Right",
      right: { name: "  preserved  ", age: 3 },
    });
  });

  test("matches namespaces by URI and emits configured prefixes on the document root", async () => {
    interface NamespacedDocument {
      id: number;
      title: string;
      author: string;
    }
    const codec = XmlCodecs.object<NamespacedDocument>(
      "Document",
      [
        { property: "id", name: "id", codec: int32Codec, attribute: true },
        {
          property: "title",
          name: "title",
          codec: stringCodec,
          namespace: { prefix: "smp", uri: "http://example.com/schema" },
        },
        {
          property: "author",
          name: "author",
          codec: stringCodec,
          namespace: { prefix: "ns2", uri: "http://example.com/authors" },
        },
      ],
      { namespace: { prefix: "smp", uri: "http://example.com/schema" } },
    );

    const decoded = await decodeBody(
      new Request("http://localhost/document", {
        method: "PUT",
        headers: { "content-type": "application/problem+xml" },
        body: '<x:Document xmlns:x="http://example.com/schema" xmlns:y="http://example.com/authors" id="7"><x:title>Book</x:title><y:author>Writer</y:author></x:Document>',
      }),
      { xml: codec },
      { contentTypes: ["application/problem+xml"] },
    );
    expect(decoded).toEqual({
      _tag: "Right",
      right: { id: 7, title: "Book", author: "Writer" },
    });

    expect(codec.serialize({ id: 7, title: "Book", author: "Writer" })).toBe(
      '<smp:Document xmlns:smp="http://example.com/schema" xmlns:ns2="http://example.com/authors" id="7"><smp:title>Book</smp:title><ns2:author>Writer</ns2:author></smp:Document>',
    );
  });

  test("supports attributes plus unwrapped text content", async () => {
    interface TextDocument {
      language: string;
      content: string;
    }
    const codec = XmlCodecs.object<TextDocument>("TextDocument", [
      { property: "language", name: "language", codec: stringCodec, attribute: true },
      { property: "content", name: "content", codec: stringCodec, unwrapped: true },
    ]);
    const decoded = await decodeBody(
      new Request("http://localhost/text", {
        method: "PUT",
        headers: { "content-type": "text/xml" },
        body: '<TextDocument language="en">\n  Some &amp; text.\n</TextDocument>',
      }),
      { xml: codec },
      { contentTypes: ["text/xml"] },
    );
    expect(decoded).toEqual({
      _tag: "Right",
      right: { language: "en", content: "Some & text." },
    });
    expect(codec.serialize({ language: "en", content: "Some & text." })).toBe(
      '<TextDocument language="en">Some &amp; text.</TextDocument>',
    );
    expect(codec.serialize({ language: "a\tb", content: "a\rb" })).toBe(
      '<TextDocument language="a&#9;b">a&#13;b</TextDocument>',
    );

    const normalizedWhitespace = await decodeBody(
      new Request("http://localhost/text", {
        method: "PUT",
        headers: { "content-type": "application/xml" },
        body: '<TextDocument language="a&#9;b">a&#13;b</TextDocument>',
      }),
      { xml: codec },
    );
    expect(normalizedWhitespace).toEqual({
      _tag: "Right",
      right: { language: "a\tb", content: "a\rb" },
    });

    const mixedContent = await decodeBody(
      new Request("http://localhost/text", {
        method: "PUT",
        headers: { "content-type": "application/xml" },
        body: '<TextDocument language="en">before<extra/>after</TextDocument>',
      }),
      { xml: codec },
    );
    expect(isLeft(mixedContent)).toBe(true);
    if (isLeft(mixedContent)) {
      expect(mixedContent.left.issues).toEqual([
        { path: "$body.extra", message: "Unexpected XML element." },
      ]);
    }

    const cdata = await decodeBody(
      new Request("http://localhost/text", {
        method: "PUT",
        headers: { "content-type": "application/xml" },
        body: '<TextDocument language="en"><![CDATA[&undeclared; <!DOCTYPE harmless>]]></TextDocument>',
      }),
      { xml: codec },
    );
    expect(cdata).toEqual({
      _tag: "Right",
      right: { language: "en", content: "&undeclared; <!DOCTYPE harmless>" },
    });

    const optionalTextCodec = XmlCodecs.object<{ content?: string }>("OptionalText", [
      {
        property: "content",
        name: "content",
        codec: stringCodec,
        optional: true,
        unwrapped: true,
      },
    ]);
    const whitespaceOnly = await decodeBody(
      new Request("http://localhost/text", {
        method: "PUT",
        headers: { "content-type": "application/xml" },
        body: "<OptionalText>\n  </OptionalText>",
      }),
      { xml: optionalTextCodec },
    );
    expect(whitespaceOnly).toEqual({ _tag: "Right", right: {} });
  });

  test("allows an attribute and child element to share a local name", async () => {
    interface AttributeAndElement {
      attribute: string;
      element: string;
    }
    const codec = XmlCodecs.object<AttributeAndElement>("AttributeAndElement", [
      { property: "attribute", name: "value", codec: stringCodec, attribute: true },
      { property: "element", name: "value", codec: stringCodec },
    ]);
    const decoded = await decodeBody(
      new Request("http://localhost/value", {
        method: "PUT",
        headers: { "content-type": "application/xml" },
        body: '<AttributeAndElement value="attribute"><value>element</value></AttributeAndElement>',
      }),
      { xml: codec },
    );
    expect(decoded).toEqual({
      _tag: "Right",
      right: { attribute: "attribute", element: "element" },
    });
    expect(codec.serialize({ attribute: "attribute", element: "element" })).toBe(
      '<AttributeAndElement value="attribute"><value>element</value></AttributeAndElement>',
    );
  });

  test("resolves recursive object codecs without eagerly traversing the cycle", async () => {
    interface Node {
      value: string;
      child?: Node;
    }
    let nodeCodec: XmlCodec<Node>;
    nodeCodec = XmlCodecs.lazy(() =>
      XmlCodecs.object<Node>("Node", [
        { property: "value", name: "value", codec: stringCodec },
        { property: "child", name: "child", codec: nodeCodec, optional: true },
      ]),
    );

    const decoded = await decodeBody(
      new Request("http://localhost/node", {
        method: "PUT",
        headers: { "content-type": "application/xml" },
        body: "<Node><value>root</value><child><value>leaf</value></child></Node>",
      }),
      { xml: nodeCodec },
    );
    expect(decoded).toEqual({
      _tag: "Right",
      right: { value: "root", child: { value: "leaf" } },
    });
    expect(nodeCodec.serialize({ value: "root", child: { value: "leaf" } })).toBe(
      "<Node><value>root</value><child><value>leaf</value></child></Node>",
    );
  });

  test("rejects malformed XML, DTDs, wrong roots, and invalid scalar values", async () => {
    for (const body of [
      "<SimpleModel><name>test</SimpleModel>",
      '<?xml version="1.1"?><SimpleModel><name>test</name><age>1</age></SimpleModel>',
      '<!DOCTYPE SimpleModel [<!ENTITY value "test">]><SimpleModel><name>&value;</name><age>1</age></SimpleModel>',
      "<SimpleModel><name>&undeclared;</name><age>1</age></SimpleModel>",
      "<SimpleModel><name>&#0;</name><age>1</age></SimpleModel>",
      "<SimpleModel><name>test</name><age>1</age></SimpleModel>trailing",
      '<SimpleModel xmlns:a="https://example.com" xmlns:b="https://example.com" a:x="1" b:x="2"><name>test</name><age>1</age></SimpleModel>',
      '<SimpleModel extra="&undeclared"><name>test</name><age>1</age></SimpleModel>',
      '<SimpleModel extra="<"><name>test</name><age>1</age></SimpleModel>',
      "<SimpleModel><name>bad\u0000</name><age>1</age></SimpleModel>",
      "<SimpleModel><name>]]></name><age>1</age></SimpleModel>",
    ]) {
      const result = await decodeBody(
        new Request("http://localhost/model", {
          method: "PUT",
          headers: { "content-type": "application/xml" },
          body,
        }),
        { xml: simpleModelCodec },
      );
      expect(isLeft(result)).toBe(true);
      if (isLeft(result)) {
        expect(result.left).toBeInstanceOf(ValidationError);
        expect(result.left.issues).toEqual([
          { path: "$body", message: "Body must contain valid XML." },
        ]);
      }
    }

    const wrongShape = await decodeBody(
      new Request("http://localhost/model", {
        method: "PUT",
        headers: { "content-type": "application/xml" },
        body: "<Other><name>test</name><age>bad</age></Other>",
      }),
      { xml: simpleModelCodec },
    );
    expect(isLeft(wrongShape)).toBe(true);
    if (isLeft(wrongShape)) {
      expect(wrongShape.left.issues[0]?.path).toBe("$body");
      expect(wrongShape.left.issues[0]?.message).toContain("SimpleModel");
    }

    const invalidScalar = await decodeBody(
      new Request("http://localhost/model", {
        method: "PUT",
        headers: { "content-type": "application/xml" },
        body: "<SimpleModel><name>test</name><age>bad</age></SimpleModel>",
      }),
      { xml: simpleModelCodec },
    );
    expect(isLeft(invalidScalar)).toBe(true);
    if (isLeft(invalidScalar)) {
      expect(invalidScalar.left.issues).toEqual([
        { path: "$body.age", message: "Expected a finite number." },
      ]);
    }
  });

  test("reports unexpected XML structure without losing array indexes", async () => {
    const arrayCodec = XmlCodecs.array("Numbers", int32Codec);
    const invalidArray = await decodeBody(
      new Request("http://localhost/numbers", {
        method: "PUT",
        headers: { "content-type": "application/xml" },
        body: '<Numbers extra="value">text<int32>bad</int32><other>1</other><int32>also-bad</int32></Numbers>',
      }),
      { xml: arrayCodec },
    );
    expect(isLeft(invalidArray)).toBe(true);
    if (isLeft(invalidArray)) {
      expect(invalidArray.left.issues).toEqual([
        { path: '$body["@extra"]', message: "Unexpected XML attribute." },
        { path: '$body["#text"]', message: "Unexpected XML text." },
        { path: "$body[0]", message: "Expected a finite number." },
        { path: "$body.other", message: "Unexpected XML element." },
        { path: "$body[1]", message: "Expected a finite number." },
      ]);
    }

    const sealedCodec = XmlCodecs.object<SimpleModel>("SimpleModel", [
      { property: "name", name: "name", codec: stringCodec },
      { property: "age", name: "age", codec: int32Codec },
    ]);
    const invalidObject = await decodeBody(
      new Request("http://localhost/model", {
        method: "PUT",
        headers: { "content-type": "application/xml" },
        body: '<SimpleModel extra="value">text<name>test</name><age>3</age></SimpleModel>',
      }),
      { xml: sealedCodec },
    );
    expect(isLeft(invalidObject)).toBe(true);
    if (isLeft(invalidObject)) {
      expect(invalidObject.left.issues).toEqual([
        { path: '$body["#text"]', message: "Unexpected XML text." },
        { path: '$body["@extra"]', message: "Unexpected XML attribute." },
      ]);
    }
  });

  test("rejects conflicting record properties and invalid dynamic element names", async () => {
    interface OpenModel {
      title?: string;
      [key: string]: string | undefined;
    }
    const codec = XmlCodecs.object<OpenModel>(
      "OpenModel",
      [{ property: "title", name: "DisplayName", codec: stringCodec, optional: true }],
      { additionalProperties: stringCodec },
    );
    const decoded = await decodeBody(
      new Request("http://localhost/open", {
        method: "PUT",
        headers: { "content-type": "application/xml" },
        body: "<OpenModel><title>unexpected</title></OpenModel>",
      }),
      { xml: codec },
    );
    expect(isLeft(decoded)).toBe(true);
    if (isLeft(decoded)) {
      expect(decoded.left.issues).toEqual([
        {
          path: "$body.title",
          message: "Additional XML element conflicts with another property.",
        },
      ]);
    }

    const namespacedAdditional = await decodeBody(
      new Request("http://localhost/open", {
        method: "PUT",
        headers: { "content-type": "application/xml" },
        body: '<OpenModel xmlns:n="https://example.com"><n:key>value</n:key></OpenModel>',
      }),
      { xml: codec },
    );
    expect(isLeft(namespacedAdditional)).toBe(true);
    if (isLeft(namespacedAdditional)) {
      expect(namespacedAdditional.left.issues).toEqual([
        {
          path: "$body.key",
          message: "Additional properties cannot use an XML namespace.",
        },
      ]);
    }

    expect(() => codec.serialize({ "bad:name": "value" })).toThrow(XmlSerializationError);
    expect(() =>
      XmlCodecs.scalar("bad name", Decoders.string, JsonSerializers.identity<string>()),
    ).toThrow(TypeError);
    expect(() =>
      XmlCodecs.object<{ value: string }>("ReservedAttribute", [
        {
          property: "value",
          name: "xmlns",
          codec: stringCodec,
          attribute: true,
        },
      ]),
    ).toThrow(TypeError);
    expect(() =>
      XmlCodecs.object<{ value: SimpleModel }>("InvalidAttribute", [
        {
          property: "value",
          name: "value",
          codec: simpleModelCodec,
          attribute: true,
        },
      ]),
    ).toThrow(TypeError);
    expect(() =>
      XmlCodecs.object<{ content: string; child: string }>("MixedContent", [
        {
          property: "content",
          name: "content",
          codec: stringCodec,
          unwrapped: true,
        },
        { property: "child", name: "child", codec: stringCodec },
      ]),
    ).toThrow(TypeError);
    const unicodeName = "\u200Cvalue";
    expect(
      XmlCodecs.scalar(unicodeName, Decoders.string, JsonSerializers.identity()).serialize("ok"),
    ).toBe(`<${unicodeName}>ok</${unicodeName}>`);
  });

  test("encodes XML responses and reports handler serialization paths", async () => {
    const encoder = ResponseEncoders.xml(201).mapInput((value: SimpleModel) =>
      simpleModelCodec.serialize(value),
    );
    const response = encoder.encode({ name: "test", age: 3 });
    expect(response.status).toBe(201);
    expect(response.headers.get("content-type")).toBe("application/xml");
    expect(await response.text()).toBe("<SimpleModel><name>test</name><age>3</age></SimpleModel>");

    class SimpleModelValue implements SimpleModel {
      constructor(
        readonly name: string,
        readonly age: number,
      ) {}
    }
    expect(simpleModelCodec.serialize(new SimpleModelValue("class", 4))).toBe(
      "<SimpleModel><name>class</name><age>4</age></SimpleModel>",
    );

    expect(() => simpleModelCodec.serialize({ name: "test" } as SimpleModel)).toThrow(
      XmlSerializationError,
    );
    expect(() => simpleModelCodec.serialize({ name: "bad\u0000", age: 3 })).toThrow(
      XmlSerializationError,
    );
    try {
      simpleModelCodec.serialize({ name: "test", age: "bad" } as unknown as SimpleModel);
      throw new Error("Expected invalid XML scalar serialization to fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(XmlSerializationError);
      expect((error as XmlSerializationError).path).toBe("$response.age");
    }
    try {
      simpleModelCodec.serialize({ name: "test" } as SimpleModel);
    } catch (error) {
      expect(error).toBeInstanceOf(XmlSerializationError);
      expect((error as XmlSerializationError).path).toBe("$response.age");
    }

    const sparse = new Array<string>(1);
    try {
      XmlCodecs.array("Strings", stringCodec).serialize(sparse);
      throw new Error("Expected sparse XML array serialization to fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(XmlSerializationError);
      expect((error as XmlSerializationError).path).toBe("$response[0]");
    }
  });
});
