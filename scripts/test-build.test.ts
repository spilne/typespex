import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildFixturePackages, planFixtureBuilds } from "./test-support/package-builds.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "typespex-test-build-"));
  directories.push(root);
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ private: true, workspaces: ["packages/*"] }),
  );
  writeFileSync(join(root, "bun.lock"), "fixture lock");
  writeFileSync(join(root, "tsconfig.base.json"), "{}");
  function packageSource(
    name: string,
    dependencies: string[] = [],
    peerDependencies: string[] = [],
  ) {
    const path = join(root, "packages", name);
    mkdirSync(join(path, "src"), { recursive: true });
    writeFileSync(join(path, "src/index.ts"), "export const value = 1;");
    writeFileSync(join(path, "tsconfig.json"), "{}");
    writeFileSync(
      join(path, "package.json"),
      JSON.stringify({
        name: `@typespex/${name}`,
        scripts: { build: "bun build.ts" },
        dependencies: Object.fromEntries(
          dependencies.map((name) => [`@typespex/${name}`, "workspace:*"]),
        ),
        peerDependencies: Object.fromEntries(
          peerDependencies.map((name) => [`@typespex/${name}`, "workspace:*"]),
        ),
        exports: {
          ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
          "./unstable": "./dist/unstable.js",
        },
      }),
    );
    writeFileSync(
      join(path, "build.ts"),
      `
      import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
      appendFileSync("../../builds.log", ${JSON.stringify(name + "\n")});
      if (existsSync("../../fail")) process.exit(1);
      mkdirSync("dist", { recursive: true });
      if (existsSync("../../hold")) {
        writeFileSync("../../started", "");
        const deadline = Date.now() + 10000;
        while (!existsSync("../../release")) {
          if (Date.now() > deadline) throw new Error("Test did not release build");
          await Bun.sleep(5);
        }
      }
      writeFileSync("dist/index.js", readFileSync("src/index.ts"));
      writeFileSync("dist/index.d.ts", "export declare const value: number;");
      if (!existsSync("../../omit")) writeFileSync("dist/unstable.js", "export {};");
    `,
    );
    return path;
  }
  function builds() {
    return readFileSync(join(root, "builds.log"), "utf8").trim().split("\n");
  }
  return { root, packageSource, builds };
}

test("plans dependencies and peers once, without unrelated inputs", () => {
  const { root, packageSource } = fixture();
  packageSource("codec");
  packageSource("server", ["codec"]);
  packageSource("emitter", [], ["server"]);
  const builds = planFixtureBuilds(root, ["emitter", "server"]);
  expect(builds.map((build) => build.packageName)).toEqual([
    "@typespex/codec",
    "@typespex/server",
    "@typespex/emitter",
  ]);
  expect(builds[0]!.inputs).not.toContain(join(root, "packages/emitter/src"));
  expect(builds[2]!.inputs).toContain(join(root, "packages/codec/src"));
  expect(builds[2]!.artifacts).toContain(join(root, "packages/emitter/dist/unstable.js"));
});

test("reports dependency cycles", () => {
  const { root, packageSource } = fixture();
  packageSource("first", ["second"]);
  packageSource("second", ["first"]);
  expect(() => planFixtureBuilds(root, ["first"])).toThrow("dependency cycle: first");
});

test("reuses warm builds and invalidates dependents when a source changes", () => {
  const { root, packageSource, builds } = fixture();
  const codec = packageSource("codec");
  const emitter = packageSource("emitter", ["codec"]);
  buildFixturePackages(root, ["emitter"]);
  buildFixturePackages(root, ["emitter"]);
  expect(builds()).toEqual(["codec", "emitter"]);
  writeFileSync(join(emitter, "src/index.ts"), "export const value = 2;");
  buildFixturePackages(root, ["emitter"]);
  expect(builds()).toEqual(["codec", "emitter", "emitter"]);
  writeFileSync(join(codec, "src/index.ts"), "export const value = 3;");
  buildFixturePackages(root, ["emitter"]);
  expect(builds()).toEqual(["codec", "emitter", "emitter", "codec", "emitter"]);
});

test("rebuilds missing secondary entry points and rejects incomplete output", () => {
  const { root, packageSource, builds } = fixture();
  const path = packageSource("emitter");
  buildFixturePackages(root, ["emitter"]);
  rmSync(join(path, "dist/unstable.js"));
  writeFileSync(join(root, "omit"), "");
  expect(() => buildFixturePackages(root, ["emitter"])).toThrow("expected artifacts");
  expect(existsSync(join(path, "dist/.test-build-complete"))).toBe(false);
  rmSync(join(root, "omit"));
  buildFixturePackages(root, ["emitter"]);
  expect(builds()).toHaveLength(3);
});

test("releases failed builds for a subsequent retry", () => {
  const { root, packageSource } = fixture();
  const path = packageSource("emitter");
  writeFileSync(join(root, "fail"), "");
  expect(() => buildFixturePackages(root, ["emitter"])).toThrow("build failed");
  expect(existsSync(join(path, "dist/.test-build-complete"))).toBe(false);
  expect(existsSync(join(root, ".context/test-build-locks/emitter"))).toBe(false);
  rmSync(join(root, "fail"));
  buildFixturePackages(root, ["emitter"]);
  expect(existsSync(join(path, "dist/.test-build-complete"))).toBe(true);
});

test("reclaims a lock after its owner exits", async () => {
  const { root, packageSource } = fixture();
  packageSource("emitter");
  const owner = Bun.spawn(["bun", "-e", "process.exit(0)"]);
  await owner.exited;
  const lockDir = join(root, ".context/test-build-locks/emitter");
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(
    join(lockDir, "owner.json"),
    JSON.stringify({ pid: owner.pid, token: "abandoned", createdAt: Date.now() }),
  );
  buildFixturePackages(root, ["emitter"]);
  expect(existsSync(lockDir)).toBe(false);
});

async function waitFor(path: string) {
  const deadline = Date.now() + 10000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path}`);
    await Bun.sleep(5);
  }
}

test("coordinates concurrent processes and retries inputs changed during a build", async () => {
  const { root, packageSource, builds } = fixture();
  const path = packageSource("emitter");
  writeFileSync(join(root, "hold"), "");
  const helper = resolve(import.meta.dir, "test-support/package-builds.ts");
  const runner = join(root, "run.ts");
  writeFileSync(
    runner,
    `import { buildFixturePackages } from ${JSON.stringify(helper)}; buildFixturePackages(${JSON.stringify(root)}, ["emitter"]);`,
  );
  const first = Bun.spawn(["bun", runner], { stdout: "pipe", stderr: "pipe" });
  let second: ReturnType<typeof Bun.spawn> | undefined;
  try {
    await waitFor(join(root, "started"));
    // Age does not make a live owner's lock safe to steal.
    const ownerPath = join(root, ".context/test-build-locks/emitter/owner.json");
    const owner = JSON.parse(readFileSync(ownerPath, "utf8"));
    writeFileSync(ownerPath, JSON.stringify({ ...owner, createdAt: 0 }));
    second = Bun.spawn(["bun", runner], { stdout: "pipe", stderr: "pipe" });
    writeFileSync(join(path, "src/index.ts"), "export const value = 4;");
    writeFileSync(join(root, "release"), "");
    expect(await first.exited).toBe(0);
    expect(await second.exited).toBe(0);
    expect(builds()).toEqual(["emitter", "emitter"]);
    expect(readFileSync(join(path, "dist/index.js"), "utf8")).toContain("value = 4");
    buildFixturePackages(root, ["emitter"]);
    expect(builds()).toHaveLength(2);
  } finally {
    first.kill();
    second?.kill();
    await first.exited;
    await second?.exited;
  }
}, 30000);
