import "@typespex/mcp";

using TypeSpex.Mcp;

@mcpServer(#{ version: "1.0.0", instructions: "MCP tool conformance fixture" })
namespace ConformanceTools {
  model address {
    street?: string;
    city?: string;
  }

  model JsonSchemaInput {
    name?: string;
    address?: address;
  }

  @doc("Return a simple text content block.")
  @tool(#{ name: "test_simple_text" })
  op simpleText(): string;

  @doc("Return a validated image content block.")
  @tool(#{ name: "test_image_content" })
  op imageContent(): string;

  @doc("Return a validated audio content block.")
  @tool(#{ name: "test_audio_content" })
  op audioContent(): string;

  @doc("Return a validated embedded-resource content block.")
  @tool(#{ name: "test_embedded_resource" })
  op embeddedResource(): string;

  @doc("Return text, image, and embedded-resource content together.")
  @tool(#{ name: "test_multiple_content_types" })
  op multipleContentTypes(): string;

  @doc("Return an intentional operational tool error.")
  @tool(#{ name: "test_error_handling" })
  op errorHandling(): string;

  @doc("Report monotonically increasing progress before returning.")
  @tool(#{ name: "test_tool_with_progress" })
  op toolWithProgress(): string;

  @doc("Expose JSON Schema 2020-12 definitions and references.")
  @tool(#{ name: "json_schema_2020_12_tool" })
  op jsonSchema202012(...JsonSchemaInput): string;
}
