interface Base64Buffer {
  toString(encoding: "base64"): string;
}

interface Base64BufferConstructor {
  from(buffer: ArrayBufferLike, byteOffset: number, length: number): Base64Buffer;
}

interface Base64Globals {
  readonly Buffer?: Base64BufferConstructor;
  readonly btoa: (value: string) => string;
}

export function encodeBytesToBase64(value: Uint8Array, globals: Base64Globals): string {
  const Buffer = globals.Buffer;
  if (typeof Buffer?.from === "function") {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("base64");
  }

  const binaryChunks: string[] = [];
  const chunkSize = 0x8000;
  for (let offset = 0; offset < value.length; offset += chunkSize) {
    binaryChunks.push(String.fromCharCode(...value.subarray(offset, offset + chunkSize)));
  }
  return globals.btoa(binaryChunks.join(""));
}

export function bytesToBase64(value: Uint8Array): string {
  const globals = globalThis as typeof globalThis & {
    readonly Buffer?: Base64BufferConstructor;
  };
  return encodeBytesToBase64(value, globals);
}
