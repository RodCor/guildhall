import { execFile } from "node:child_process";
import {
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { build } from "esbuild";

const CONNECTOR_NAME = "@kimetsu-ai/guildhall-mcp";
const CONNECTOR_VERSION = "0.1.1";
const execFileAsync = promisify(execFile);
const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stagingDirectory = join(
  workspaceRoot,
  "apps",
  "guild-node",
  "dist",
  "connector-package",
);
const packageOutputDirectory = join(
  workspaceRoot,
  "apps",
  "guild-node",
  "dist",
);
const archiveName = "kimetsu-ai-guildhall-mcp-0.1.1.tgz";
const archivePath = join(packageOutputDirectory, archiveName);

assertWorkspacePath(stagingDirectory);
assertWorkspacePath(packageOutputDirectory);

await rm(stagingDirectory, { recursive: true, force: true });
await mkdir(join(stagingDirectory, "dist"), { recursive: true });
await mkdir(packageOutputDirectory, { recursive: true });

await build({
  entryPoints: [join(workspaceRoot, "apps", "guild-node", "src", "cli.ts")],
  outfile: join(stagingDirectory, "dist", "cli.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  external: ["@modelcontextprotocol/*", "zod", "zod/*"],
  legalComments: "eof",
  logLevel: "warning",
});

await writeFile(
  join(stagingDirectory, "package.json"),
  `${JSON.stringify(
    {
      name: CONNECTOR_NAME,
      version: CONNECTOR_VERSION,
      description:
        "Local signing and MCP connector for the Guildhall agent network",
      type: "module",
      bin: { "guildhall-mcp": "dist/cli.mjs" },
      files: ["dist/cli.mjs", "README.md", "LICENSE"],
      engines: { node: ">=20" },
      keywords: [
        "mcp",
        "webmcp",
        "a2a",
        "agents",
        "guildhall",
        "model-context-protocol",
      ],
      homepage: "https://guildhall.kimetsu-dev.workers.dev",
      repository: {
        type: "git",
        url: "git+https://github.com/RodCor/guildhall.git",
        directory: "apps/guild-node",
      },
      bugs: {
        url: "https://github.com/RodCor/guildhall/issues",
      },
      dependencies: {
        "@modelcontextprotocol/node": "2.0.0",
        "@modelcontextprotocol/server": "2.0.0",
        zod: "4.4.3",
      },
      license: "Apache-2.0",
      publishConfig: { access: "public" },
    },
    null,
    2,
  )}\n`,
  "utf8",
);

await copyFile(
  join(workspaceRoot, "apps", "guild-node", "README.md"),
  join(stagingDirectory, "README.md"),
);
await copyFile(
  join(workspaceRoot, "LICENSE"),
  join(stagingDirectory, "LICENSE"),
);

await rm(archivePath, { force: true });
const { stdout } = await execFileAsync(
  "npm",
  ["pack", stagingDirectory, "--pack-destination", packageOutputDirectory],
  {
    cwd: workspaceRoot,
    windowsHide: true,
    shell: process.platform === "win32",
  },
);
const generatedArchive = stdout.trim().split(/\r?\n/u).at(-1);
if (!generatedArchive) {
  throw new Error("npm pack did not report the connector archive name");
}
if (generatedArchive !== archiveName) {
  await rename(join(packageOutputDirectory, generatedArchive), archivePath);
}

const packageJson = JSON.parse(
  await readFile(join(stagingDirectory, "package.json"), "utf8"),
) as { readonly version?: unknown };
if (packageJson.version !== CONNECTOR_VERSION) {
  throw new Error("Guildhall connector version verification failed");
}

process.stdout.write(`Built ${relative(workspaceRoot, archivePath)}\n`);

function assertWorkspacePath(path: string): void {
  const workspaceRelativePath = relative(workspaceRoot, resolve(path));
  if (
    workspaceRelativePath.length === 0 ||
    workspaceRelativePath === ".." ||
    workspaceRelativePath.startsWith(
      `..${process.platform === "win32" ? "\\" : "/"}`,
    )
  ) {
    throw new Error(`Refusing to write outside the workspace: ${path}`);
  }
}
