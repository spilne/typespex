import "@typespec/http";
import "@typespex/mcp";

using TypeSpec.Http;
using TypeSpex.Mcp;

@service(#{ title: "Pet Assistant HTTP API" })
@server("https://pets.example.test")
@mcpServer(#{
  name: "PetAssistant",
  version: "1.0.0",
  instructions: "Look up pets in the TypeSpex example store",
})
namespace PetAssistant {
  model Pet {
    id: string;

    @minLength(1)
    name: string;
  }

  @error
  model NotFoundError {
    code: "NOT_FOUND";
    message: string;
  }

  @doc("Return a pet by its stable identifier.")
  @tool(#{
    title: "Get pet",
    annotations: #{ readOnlyHint: true, idempotentHint: true },
  })
  @get
  @route("/pets/{id}")
  op getPet(@path id: string): Pet | NotFoundError;

  @tool(#{ title: "List pets", annotations: #{ readOnlyHint: true } })
  @get
  @route("/pets")
  op listPets(): Pet[];
}
