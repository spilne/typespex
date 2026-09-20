/** TypeScript literals shared by emitted integer validation paths. */
const SCALAR_INTEGER_RANGES: Readonly<Record<string, readonly [string, string]>> = {
  int8: ["-128", "127"],
  uint8: ["0", "255"],
  int16: ["-32768", "32767"],
  uint16: ["0", "65535"],
  int32: ["-2147483648", "2147483647"],
  uint32: ["0", "4294967295"],
  int64: ["-9223372036854775808n", "9223372036854775807n"],
  uint64: ["0n", "18446744073709551615n"],
};

export function scalarIntegerRange(name: string): readonly [string, string] | undefined {
  return Object.hasOwn(SCALAR_INTEGER_RANGES, name) ? SCALAR_INTEGER_RANGES[name] : undefined;
}
