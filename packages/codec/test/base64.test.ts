import { describe, expect, test } from "bun:test";
import { bytesToBase64, encodeBytesToBase64 } from "../src/base64.js";

describe("base64 runtime capabilities", () => {
  test("encodes bytes through the ambient runtime", () => {
    expect(bytesToBase64(new Uint8Array([0, 127, 128, 255]))).toBe("AH+A/w==");
  });

  test("uses Buffer with the exact Uint8Array view when available", () => {
    const backing = new Uint8Array(0x8000 * 3 + 9);
    for (let index = 0; index < backing.length; index += 1) {
      backing[index] = index % 251;
    }
    const bytes = backing.subarray(1, -1);
    const expected = Buffer.from(bytes).toString("base64");
    let receivedBuffer: ArrayBufferLike | undefined;
    let receivedOffset: number | undefined;
    let receivedLength: number | undefined;

    const encoded = encodeBytesToBase64(bytes, {
      Buffer: {
        from(buffer, byteOffset, length) {
          receivedBuffer = buffer;
          receivedOffset = byteOffset;
          receivedLength = length;
          return {
            toString(encoding) {
              expect(encoding).toBe("base64");
              return expected;
            },
          };
        },
      },
      btoa() {
        throw new Error("btoa fallback should not run");
      },
    });

    expect(encoded).toBe(expected);
    expect(receivedBuffer).toBe(bytes.buffer);
    expect(receivedOffset).toBe(bytes.byteOffset);
    expect(receivedLength).toBe(bytes.byteLength);
  });

  test("falls back to chunked btoa when Buffer is unavailable", () => {
    const bytes = new Uint8Array(0x8000 * 3 + 7);
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = index % 251;
    }

    let binaryLength = 0;
    const encoded = encodeBytesToBase64(bytes, {
      btoa(binary) {
        binaryLength = binary.length;
        return btoa(binary);
      },
    });

    expect(encoded).toBe(Buffer.from(bytes).toString("base64"));
    expect(binaryLength).toBe(bytes.byteLength);
  });
});
