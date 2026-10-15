import { mkdir, writeFile } from "node:fs/promises";
import { createPublicWorkspace } from "../src/data/public-layers.js";

await mkdir(new URL("../public/data/", import.meta.url), { recursive: true });
await writeFile(
  new URL("../public/data/workspace.json", import.meta.url),
  `${JSON.stringify(createPublicWorkspace(), null, 2)}\n`,
);
console.log(
  "Generated the public-source starting workspace (no synthetic assets).",
);
