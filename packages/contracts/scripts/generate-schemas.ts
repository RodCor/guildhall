import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { publicSchemaRegistry } from "../src/schemas.js";

const scriptDirectory = fileURLToPath(new URL(".", import.meta.url));
const outputDirectory = resolve(
  scriptDirectory,
  "../../../protocol/commitment-v1",
);
const packageSchemaDirectory = resolve(scriptDirectory, "../schemas");
await Promise.all(
  [outputDirectory, packageSchemaDirectory].map((directory) =>
    mkdir(directory, { recursive: true }),
  ),
);

for (const [filename, contract] of Object.entries(publicSchemaRegistry)) {
  const schema = z.toJSONSchema(contract, {
    cycles: "ref",
    io: "input",
    reused: "ref",
    unrepresentable: "throw",
  });
  const content = `${JSON.stringify(
    {
      ...schema,
      $id: `https://guildhall.dev/protocol/commitment-v1/${filename}`,
    },
    null,
    2,
  )}\n`;
  await Promise.all(
    [outputDirectory, packageSchemaDirectory].map((directory) =>
      writeFile(resolve(directory, filename), content, "utf8"),
    ),
  );
}
