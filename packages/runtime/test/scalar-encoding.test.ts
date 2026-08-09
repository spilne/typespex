import { describe, expect, test } from "bun:test";
import {
  Decoders,
  Either,
  JsonSerializationError,
  JsonSerializers,
  Validators,
} from "../src/server.js";

describe("scalar wire encodings", () => {
  test("wraps custom scalar conversions as boundary errors", () => {
    const decoder = Decoders.transform(Decoders.string, () => {
      throw new TypeError("Cannot decode custom scalar.");
    });
    expect(decoder.decode("wire")).toEqual(
      Either.left([{ path: "", message: "Cannot decode custom scalar." }]),
    );

    const serializer = JsonSerializers.transformInput(JsonSerializers.identity<string>(), () => {
      throw new TypeError("Cannot encode custom scalar.");
    });
    expect(() => serializer.serialize("handler", "$response.value")).toThrow(
      "$response.value: Cannot encode custom scalar.",
    );
  });

  test("decodes string-encoded numeric and boolean handler values", () => {
    expect(Decoders.encodedNumberString.decode("1.25")).toEqual(Either.right(1.25));
    expect(Decoders.encodedIntegerString.decode("42")).toEqual(Either.right(42));
    expect(Decoders.encodedBigIntString.decode("9223372036854775807")).toEqual(
      Either.right(9223372036854775807n),
    );
    expect(Decoders.encodedBooleanString.decode("TrUe")).toEqual(Either.right(true));
    expect(Decoders.encodedNumberString.decode(1)).toEqual(
      Either.left([{ path: "", message: "Expected a string." }]),
    );
    const constrainedWire = Decoders.string.validate(Validators.minLength(3));
    const constrainedInteger = Decoders.compose(constrainedWire, Decoders.encodedIntegerString);
    expect(constrainedInteger.decode("420")).toEqual(Either.right(420));
    expect(constrainedInteger.decode("42")).toEqual(
      Either.left([{ path: "", message: "Expected length greater than or equal to 3." }]),
    );
  });

  test("decodes date-time wire formats to semantic strings", () => {
    expect(Decoders.rfc3339DateTime.decode("2024-01-02T03:04:05Z")).toEqual(
      Either.right("2024-01-02T03:04:05Z"),
    );
    expect(Decoders.rfc3339DateTime.decode("2016-12-31t23:59:60z")).toEqual(
      Either.right("2016-12-31t23:59:60z"),
    );
    expect(Decoders.rfc3339DateTime.decode("2023-02-29T03:04:05Z")).toEqual(
      Either.left([{ path: "", message: "Expected a valid RFC 3339 wire date-time." }]),
    );
    expect(Decoders.rfc3339DateTime.decode("2024-01-02T03:04:05+24:00")).toEqual(
      Either.left([{ path: "", message: "Expected a valid RFC 3339 wire date-time." }]),
    );
    expect(Decoders.rfc7231DateTime.decode("Tue, 02 Jan 2024 03:04:05 GMT")).toEqual(
      Either.right("2024-01-02T03:04:05.000Z"),
    );
    expect(Decoders.unixTimestamp(Decoders.strictInteger).decode(0)).toEqual(
      Either.right("1970-01-01T00:00:00.000Z"),
    );
    expect(Decoders.dateTimeDate(Decoders.rfc3339DateTime).decode("2016-12-31T23:59:60Z")).toEqual(
      Either.right(new Date("2017-01-01T00:00:00.000Z")),
    );
  });

  test("decodes numeric durations and base64url bytes", () => {
    expect(Decoders.numericDuration(Decoders.strictNumber, "seconds").decode(1.5)).toEqual(
      Either.right("PT1.5S"),
    );
    expect(Decoders.numericDuration(Decoders.strictInteger, "milliseconds").decode(1500)).toEqual(
      Either.right("PT1.5S"),
    );
    expect(Decoders.isoDuration.decode("PT1,5S")).toEqual(Either.right("PT1,5S"));
    expect(Decoders.isoDuration.decode("P0.5Y")).toEqual(
      Either.left([{ path: "", message: "Expected an ISO 8601 wire duration string." }]),
    );
    expect(Decoders.isoDuration.decode("PT1.5H30M")).toEqual(
      Either.left([{ path: "", message: "Expected an ISO 8601 wire duration string." }]),
    );
    expect(Decoders.isoDuration.decode("PT1.1234567890S")).toEqual(
      Either.left([{ path: "", message: "Expected an ISO 8601 wire duration string." }]),
    );
    expect(Decoders.base64UrlBytes.decode("_w")).toEqual(Either.right(new Uint8Array([255])));
    expect(Decoders.base64UrlBytes.decode("_w==")).toEqual(Either.right(new Uint8Array([255])));
    expect(Decoders.base64UrlBytes.decode("_x")).toEqual(
      Either.left([{ path: "", message: "Expected a valid base64url string." }]),
    );
    expect(Decoders.base64UrlBytes.decode("_w=")).toEqual(
      Either.left([{ path: "", message: "Expected a valid base64url string." }]),
    );
  });

  test("serializes handler values to each standard wire format", () => {
    expect(JsonSerializers.encodedNumberString().serialize(1.25)).toBe("1.25");
    expect(JsonSerializers.encodedBigIntString().serialize(9223372036854775807n)).toBe(
      "9223372036854775807",
    );
    expect(() =>
      JsonSerializers.encodedBigIntString({ max: 9007199254740992 }).serialize(9007199254740993n),
    ).toThrow("Encoded value must be at most 9007199254740992.");
    expect(JsonSerializers.encodedBooleanString.serialize(false)).toBe("false");
    expect(JsonSerializers.rfc3339DateTime.serialize("2024-01-02T03:04:05Z")).toBe(
      "2024-01-02T03:04:05Z",
    );
    expect(JsonSerializers.rfc7231DateTime.serialize("2024-01-02T03:04:05Z")).toBe(
      "Tue, 02 Jan 2024 03:04:05 GMT",
    );
    expect(JsonSerializers.rfc7231DateTime.serialize("2016-12-31T23:59:60Z")).toBe(
      "Sun, 01 Jan 2017 00:00:00 GMT",
    );
    expect(JsonSerializers.unixTimestamp({ integer: true }).serialize("1970-01-01T00:00:00Z")).toBe(
      0,
    );
    expect(JsonSerializers.numericDuration("seconds", { integer: true }).serialize("PT1.5S")).toBe(
      1,
    );
    expect(JsonSerializers.numericDuration("seconds", { integer: true }).serialize("-PT1.5S")).toBe(
      -2,
    );
    expect(JsonSerializers.numericDuration("milliseconds").serialize("PT1.5S")).toBe(1500);
    expect(JsonSerializers.numericDuration("seconds").serialize("PT1.5H")).toBe(5400);
    expect(JsonSerializers.numericDuration("seconds").serialize("PT1H30,5M")).toBe(5430);
    expect(JsonSerializers.isoDuration.serialize("P1Y2M")).toBe("P1Y2M");
    expect(() => JsonSerializers.numericDuration("seconds").serialize("P1Y")).toThrow(
      "containing only weeks, days, hours, minutes, or seconds",
    );
    expect(JsonSerializers.base64Bytes.serialize(new Uint8Array([255]))).toBe("/w==");
    expect(JsonSerializers.base64UrlBytes.serialize(new Uint8Array([255]))).toBe("_w");
    const constrainedWire = JsonSerializers.validate(
      JsonSerializers.encodedNumberString(),
      Validators.minLength(3),
    );
    expect(constrainedWire.serialize(420)).toBe("420");
    expect(() => constrainedWire.serialize(42)).toThrow(
      "Expected length greater than or equal to 3.",
    );
  });

  test("reports path-aware response serialization errors", () => {
    const serializer = JsonSerializers.unixTimestamp({
      integer: true,
      min: -2147483648,
      max: 2147483647,
    });
    expect(() => serializer.serialize("2100-01-01T00:00:00Z", "$response.createdAt")).toThrow(
      JsonSerializationError,
    );
    try {
      serializer.serialize("2100-01-01T00:00:00Z", "$response.createdAt");
    } catch (error) {
      expect((error as JsonSerializationError).path).toBe("$response.createdAt");
      expect((error as Error).message).toContain("at most 2147483647");
    }
  });
});
