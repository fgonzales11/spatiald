import { TYPE_COLORS } from "../domain/types.js";

// CARTO cloud-next, slide 2: layers/powerLines.js, getLineColor [83,135,185,180].
export const CARTO_TRANSMISSION_COLOR = "#5387b9";
export const CARTO_TRANSMISSION_OPACITY = 180 / 255;
export const CARTO_TRANSMISSION_RGBA = Object.freeze([83, 135, 185, 180]);
export const SUBSTATION_COLOR = "#000000";

export function infrastructureColor(asset) {
  if (asset.assetType === "transmission_line") return CARTO_TRANSMISSION_COLOR;
  if (asset.assetType === "substation") return SUBSTATION_COLOR;
  return TYPE_COLORS[asset.assetType] || "#37c6ef";
}

export function infrastructureLayerColor(type) {
  return infrastructureColor({ assetType: type });
}

// Tintable signed-distance square, rotated 45 degrees by the map to form a diamond.
export function substationDiamondImage() {
  const size = 64, data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const qx = Math.abs(x + 0.5 - size / 2) - 20;
    const qy = Math.abs(y + 0.5 - size / 2) - 20;
    const distance = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0);
    const index = (y * size + x) * 4;
    data[index] = data[index + 1] = data[index + 2] = 255;
    data[index + 3] = Math.round(Math.max(0, Math.min(1, 0.75 - distance / 8)) * 255);
  }
  return { width: size, height: size, data };
}
