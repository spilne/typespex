// Canonical Web File construction shared by raw and multipart bodies.
export function createFile(contents: Uint8Array, name: string, contentType: string): File {
  const ownedContents = new ArrayBuffer(contents.byteLength);
  new Uint8Array(ownedContents).set(contents);
  const file = new File([ownedContents], name, { type: contentType });
  // Bun currently omits `.name` for an empty filename; normalize to the Web
  // File contract so handlers see the same sentinel in every runtime.
  if (file.name !== name) {
    Object.defineProperty(file, "name", { value: name, enumerable: true });
  }
  if (file.type !== contentType) {
    Object.defineProperty(file, "type", { value: contentType, enumerable: true });
  }
  return file;
}
