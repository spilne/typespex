import "@typespec/http";
import "./lib.js";

using TypeSpec.Http;
using TypeSpec.Reflection;

extern dec auth(target: Operation, scope: valueof string);


model PetNoContentResponse {
  ...NoContentResponse;
}

@service(#{ title: "PetStore" })
namespace PetStore {
  model Pet {
    @minLength(1)
    id: string;

    @minLength(1)
    @maxLength(80)
    name: string;

    @maxLength(40)
    tag?: string;
  }

  model CreatePetInput {
    @minLength(1)
    @maxLength(80)
    @pattern("^[A-Za-z].*", "Must start with a letter.")
    name: string;

    @maxLength(40)
    tag?: string;
  }

  @error
  model NotFoundError {
    @statusCode _: 404;
    code: "NOT_FOUND";
    message: string;
  }

  @error
  model ForbiddenError {
    @statusCode _: 403;
    code: "FORBIDDEN";
    message: string;
  }

  @error
  model ConflictError {
    @statusCode _: 409;
    code: "CONFLICT";
    message: string;
  }

  model UploadResult {
    id: string;
    filename: string;
    size: int32;
  }

  @route("/pets")
  interface Pets {
    @get list(
        @minValue(1)
        @maxValue(100)
        @query limit?: int32,

        @minValue(0)
        @query offset?: int32
    ): Pet[];

    @post create(@body body: CreatePetInput): Pet | ConflictError;
    @get read(
        @minLength(1)
        @path petId: string
    ): Pet | NotFoundError;
    @auth("admin")
    @delete delete(
        @minLength(1)
        @path petId: string
    ): void | NotFoundError | ForbiddenError;

    @route("/{petId}/photo")
    @post uploadPhoto(
        @path petId: string,
        @multipartBody body: {
          caption?: HttpPart<string>;
          photo: HttpPart<File>;
        },
    ): UploadResult | NotFoundError;
  }
}
