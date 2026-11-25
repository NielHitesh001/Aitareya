import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { stripTypeScriptTypes } from "node:module";

const source = "src";
const output = "dist";
const staging = await mkdtemp(".dist-build-");

async function build(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const input = join(directory, entry.name);
    if (entry.isDirectory()) { await build(input); continue; }
    if (!entry.name.endsWith(".ts")) continue;
    const destination = join(staging, relative(source, input).replace(/\.ts$/, ".js"));
    const code = stripTypeScriptTypes(await readFile(input, "utf8"), { mode: "strip" }).replace(/(["'])((?:\.\.?\/)+[^"']+)\.ts\1/g, "$1$2.js$1");
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, code);
  }
}

try {
  await build(source);
  await rm(output, { recursive: true, force: true });
  await rename(staging, output);
} catch (error) {
  await rm(staging, { recursive: true, force: true });
  throw error;
}
