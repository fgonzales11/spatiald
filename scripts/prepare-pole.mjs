import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { MTLLoader } from "three/examples/jsm/loaders/MTLLoader.js";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { prepareSteelPoleModel } from "../src/spatial/pole-model.js";

// The exporter uses FileReader for its binary Blob. No textures or browser are needed.
globalThis.FileReader = class {
  async readAsArrayBuffer(blob) {
    try { this.result = await blob.arrayBuffer(); this.onloadend?.(); }
    catch (error) { this.onerror?.(error); }
  }
};
const obj = await readFile("src/assets/POSTE 05.obj", "utf8");
const mtl = await readFile("src/assets/POSTE 05.mtl", "utf8");
const materials = new MTLLoader().parse(mtl, "");
const source = new OBJLoader().setMaterials(materials).parse(obj);
const { root, definition } = prepareSteelPoleModel(source);
definition.sourceHash = createHash("sha256").update(obj).update(mtl).digest("hex");
const binary = await new GLTFExporter().parseAsync(root, { binary: true });
await writeFile("src/assets/transmission-pole.glb", Buffer.from(binary));
await writeFile("src/assets/transmission-pole.json", JSON.stringify(definition, null, 2) + "\n");
console.log(JSON.stringify({ bytes: binary.byteLength, parts: definition.parts, height: definition.height, attachments: definition.attachments }));
