import "@typespec/http";
import "./lib.js";

using TypeSpec.Http;
using TypeSpec.Reflection;

extern dec auth(target: Operation, scope: valueof string);

@service(#{ title: "PetStore" })
namespace PetStore {
  model Pet {
    id: string;
    name: string;
    tag?: string;
  }

  model CreatePetInput {
    name: string;
    tag?: string;
  }

  @error
  model NotFoundError {
    code: "NOT_FOUND";
    message: string;
  }

  @route("/pets")
  interface Pets {
    @get list(
        @query limit?: int32,
        @query offset?: int32
    ): Pet[];

    @post create(@body body: CreatePetInput): Pet;
    @get read(@path petId: string): Pet | NotFoundError;
    @auth("admin")
    @delete delete(@path petId: string): void | NotFoundError;
  }
}
