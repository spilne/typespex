import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildEmitter,
  cleanupFixtures,
  compileFixture,
  compileFixtureExpectingDiagnostics,
} from "./compile-fixture.js";
import { getBodyMediaKinds } from "../src/body-media-kinds.js";

afterAll(cleanupFixtures);
beforeAll(buildEmitter);

const xmlSpec = `
import "@typespec/http";
import "@typespec/xml";
using TypeSpec.Http;
using TypeSpec.Xml;

@service(#{ title: "XmlApi" })
namespace XmlApi;

@nsDeclarations
enum Namespaces {
  doc: "https://example.com/document",
  meta: "https://example.com/metadata",
}

model Item {
  name: string;
  count: int32;
}

@name("TagValue")
scalar Tag extends string;

@name("XmlDocument")
@ns(Namespaces.doc)
model Document {
  @attribute
  @name("xml-id")
  id: int32;

  @name("DisplayName")
  title: string;

  @encodedName("application/xml", "Summary")
  summary: string;

  @ns("https://example.com/extra", "ext")
  extra: string;

  @unwrapped
  @name("Entry")
  items: Item[];

  @name("Tags")
  tags: Tag[];

  @ns(Namespaces.meta)
  metadata: Record<string>;

  optional?: string;
}

model TextDocument {
  @attribute language: string;
  @unwrapped content: string;
}

@route("/document")
interface Documents {
  @get read(): {
    @header("content-type") contentType: "application/xml";
    @body body: Document;
  };

  @put update(
    @header("content-type") contentType: "application/xml",
    @body input: Document,
  ): void;
}

@route("/text")
@get op readText(): {
  @header("content-type") contentType: "text/xml";
  @body body: TextDocument;
};

@route("/problem")
@get op readProblem(): {
  @header("content-type") contentType: "application/problem+xml";
  @body body: Document;
};
`;

describe("XML payloads", () => {
  test("classifies text wildcards for both plain text and XML dispatch", () => {
    expect(getBodyMediaKinds(["text/*"])).toEqual(["xml", "text"]);
  });

  test("emits bidirectional XML codecs from TypeSpec XML metadata", async () => {
    const result = compileFixture("xml-payloads", xmlSpec);
    const operations = result.readFile("xml-api", "server-operations.ts");
    const compact = operations.replace(/\s+/g, " ");

    expect(operations).toContain("XmlCodec<Document>");
    expect(compact).toContain('XmlCodecs.object<Document>( "XmlDocument"');
    expect(compact).toContain('namespace: { prefix: "doc", uri: "https://example.com/document" }');
    expect(compact).toContain('property: "id", name: "xml-id"');
    expect(operations).toContain("attribute: true");
    expect(compact).toContain('property: "title", name: "DisplayName"');
    expect(compact).toContain('property: "summary", name: "Summary"');
    expect(compact).toContain('namespace: { prefix: "ext", uri: "https://example.com/extra" }');
    expect(compact).toContain('property: "items", name: "Entry"');
    expect(operations).toContain("unwrapped: true");
    expect(compact).toContain('property: "tags", name: "Tags"');
    expect(compact).toContain('XmlCodecs.scalar<string>("TagValue"');
    expect(compact).toContain('property: "metadata", name: "metadata"');
    expect(compact).toContain('namespace: { prefix: "meta", uri: "https://example.com/metadata" }');
    expect(operations).toContain("optional: true");
    expect(compact).toContain("xml: _xml");
    expect(compact).toContain('contentTypes: ["application/xml"]');
    expect(compact).toContain("ResponseEncoders.variant<{ body: Document }>");
    expect(operations).toContain('kind: "xml"');
    expect(compact).toContain(".serialize(body as Document");
    expect(operations).toContain('contentType: "text/xml"');
    result.typecheck("xml-api");

    const generated = (await import(
      `${pathToFileURL(join(result.outputDir, "xml-api", "server-operations.ts")).href}?xml-test=${Date.now()}`
    )) as {
      DocumentsOperations: {
        update: {
          decodeInput(request: Request, pathParams: Record<string, string>): Promise<unknown>;
        };
        read: {
          encodeResult(result: { body: unknown }): Response;
        };
      };
      XmlApiOperations: {
        readText: { encodeResult(result: { body: unknown }): Response };
        readProblem: { encodeResult(result: { body: unknown }): Response };
      };
    };
    const decoded = await generated.DocumentsOperations.update.decodeInput(
      new Request("http://localhost/document", {
        method: "PUT",
        headers: { "content-type": "application/xml" },
        body: '<x:XmlDocument xmlns:x="https://example.com/document" xmlns:q="https://example.com/extra" xmlns:m="https://example.com/metadata" xml-id="7"><DisplayName>Guide</DisplayName><Summary>Reference</Summary><q:extra>value</q:extra><Entry><name>one</name><count>1</count></Entry><Tags><TagValue>docs</TagValue></Tags><m:metadata><Color>blue</Color></m:metadata></x:XmlDocument>',
      }),
      {},
    );
    expect(decoded).toEqual({
      _tag: "Right",
      right: {
        contentType: "application/xml",
        id: 7,
        title: "Guide",
        summary: "Reference",
        extra: "value",
        items: [{ name: "one", count: 1 }],
        tags: ["docs"],
        metadata: { Color: "blue" },
      },
    });

    const response = generated.DocumentsOperations.read.encodeResult({
      body: {
        id: 7,
        title: "Guide",
        summary: "Reference",
        extra: "value",
        items: [{ name: "one", count: 1 }],
        tags: ["docs"],
        metadata: { Color: "blue" },
      },
    });
    expect(response.headers.get("content-type")).toBe("application/xml");
    expect(await response.text()).toBe(
      '<doc:XmlDocument xmlns:doc="https://example.com/document" xmlns:ext="https://example.com/extra" xmlns:meta="https://example.com/metadata" xml-id="7"><DisplayName>Guide</DisplayName><Summary>Reference</Summary><ext:extra>value</ext:extra><Entry><name>one</name><count>1</count></Entry><Tags><TagValue>docs</TagValue></Tags><meta:metadata><Color>blue</Color></meta:metadata></doc:XmlDocument>',
    );

    const textResponse = generated.XmlApiOperations.readText.encodeResult({
      body: { language: "en", content: "Hello" },
    });
    expect(textResponse.headers.get("content-type")).toBe("text/xml");
    expect(await textResponse.text()).toBe('<TextDocument language="en">Hello</TextDocument>');

    const problemResponse = generated.XmlApiOperations.readProblem.encodeResult({
      body: {
        id: 7,
        title: "Guide",
        summary: "Reference",
        extra: "value",
        items: [],
        tags: [],
        metadata: {},
      },
    });
    expect(problemResponse.headers.get("content-type")).toBe("application/problem+xml");
    expect(await problemResponse.text()).toContain("<doc:XmlDocument");
  });

  test("reports XML shapes without a defined TypeSpec representation", () => {
    const result = compileFixtureExpectingDiagnostics(
      "unsupported-xml-payload",
      `
        import "@typespec/http";
        import "@typespec/xml";
        using TypeSpec.Http;

        @service(#{ title: "UnsupportedXml" })
        namespace UnsupportedXml;

        model Payload { values: [string, int32]; }

        @route("/values")
        @put op update(@header("content-type") contentType: "application/xml", @body value: Payload): void;
      `,
    );
    const diagnostics = `${result.diagnostics.stdout}\n${result.diagnostics.stderr}`;
    expect(diagnostics).toContain("unsupported-request-body");
    expect(diagnostics).toContain("XML tuple bodies are not supported");
  });

  test("reports ambiguous or invalid XML element names", () => {
    const result = compileFixtureExpectingDiagnostics(
      "invalid-xml-names",
      `
        import "@typespec/http";
        import "@typespec/xml";
        using TypeSpec.Http;
        using TypeSpec.Xml;

        @service(#{ title: "InvalidXmlNames" })
        namespace InvalidXmlNames;

        model DuplicateElements {
          @name("same") first: string;
          @name("same") second: string;
        }

        @name("bad:name")
        model InvalidRoot { value: string; }

        model ConflictingNamespaces {
          @ns("https://example.com/one", "p") first: string;
          @ns("https://example.com/two", "p") second: string;
        }

        model ReservedAttribute {
          @attribute @name("xmlns") value: string;
        }

        model MixedContent {
          @unwrapped content: string;
          child: string;
        }

        model NamespacedText {
          @unwrapped @ns("https://example.com/text", "txt") content: string;
        }

        @route("/duplicates")
        @put op duplicates(
          @header("content-type") contentType: "application/xml",
          @body value: DuplicateElements,
        ): void;

        @route("/root")
        @put op root(
          @header("content-type") contentType: "application/xml",
          @body value: InvalidRoot,
        ): void;

        @route("/namespaces")
        @put op namespaces(
          @header("content-type") contentType: "application/xml",
          @body value: ConflictingNamespaces,
        ): void;

        @route("/reserved-attribute")
        @put op reservedAttribute(
          @header("content-type") contentType: "application/xml",
          @body value: ReservedAttribute,
        ): void;

        @route("/mixed-content")
        @put op mixedContent(
          @header("content-type") contentType: "application/xml",
          @body value: MixedContent,
        ): void;

        @route("/namespaced-text")
        @put op namespacedText(
          @header("content-type") contentType: "application/xml",
          @body value: NamespacedText,
        ): void;
      `,
    );
    const diagnostics = `${result.diagnostics.stdout}\n${result.diagnostics.stderr}`;
    expect(diagnostics).toContain("multiple XML elements use name");
    expect(diagnostics).toContain("bad:name");
    expect(diagnostics).toContain("not a valid unqualified XML name");
    expect(diagnostics).toContain("maps to conflicting namespace URIs");
    expect(diagnostics).toContain('cannot use the reserved name "xmlns"');
    expect(diagnostics).toContain("unwrapped text cannot also contain child elements");
    expect(diagnostics).toContain("unwrapped XML text property");
    expect(diagnostics).toContain("cannot declare a namespace");
  });

  test("rejects XML multipart parts until multipart XML decoding is supported", () => {
    const result = compileFixtureExpectingDiagnostics(
      "unsupported-multipart-xml-part",
      `
        import "@typespec/http";
        import "@typespec/xml";
        using TypeSpec.Http;

        @service(#{ title: "UnsupportedMultipartXml" })
        namespace UnsupportedMultipartXml;

        model Payload { value: string; }
        model XmlPart {
          @header contentType: "application/xml";
          @body value: Payload;
        }

        @route("/values")
        @post op update(@multipartBody body: { value: HttpPart<XmlPart> }): void;
      `,
    );
    const diagnostics = `${result.diagnostics.stdout}\n${result.diagnostics.stderr}`;
    expect(diagnostics).toContain("unsupported-request-body");
    expect(diagnostics).toContain('multipart part "value"');
    expect(diagnostics).toContain("multipart parts support JSON, text, binary, or File content");
  });
});
