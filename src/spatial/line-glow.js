// Spatial page: a soft glow around the TECO overhead conductors, as a postprocessing Effect. The glow shapes live
// on their own layer, so the main, normal and lighting-mask passes never draw them: the effect renders them into
// its own buffer (dropped where the scene depth is closer, so trees and buildings still cover the lines), blurs
// that with a mipmap blur and adds it to the HDR image before tone mapping.
import { Effect, EffectAttribute, MipmapBlurPass } from 'postprocessing';
import { Color, HalfFloatType, ShaderMaterial, Uniform, Vector2, WebGLRenderTarget } from 'three';

export class LineGlowEffect extends Effect {
  constructor(scene, camera, { layer, intensity = 1, radius = 0.6, levels = 5 }) {
    super('LineGlowEffect', `uniform sampler2D glowMap;
uniform float glowIntensity;
void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  outputColor = vec4(inputColor.rgb + texture2D(glowMap, uv).rgb * glowIntensity, inputColor.a);
}`, {
      attributes: EffectAttribute.DEPTH,
      uniforms: new Map([['glowMap', new Uniform(null)], ['glowIntensity', new Uniform(intensity)]])
    });
    this.scene = scene;
    this.camera = camera;
    this.layer = layer;
    this.target = new WebGLRenderTarget(1, 1, { type: HalfFloatType });
    this.blur = new MipmapBlurPass();
    this.blur.levels = levels;
    this.blur.radius = radius;
    this.uniforms.get('glowMap').value = this.blur.texture;
    // Shared with the glow materials (lineGlowMaterial).
    this.shared = { sceneDepth: { value: null }, sceneResolution: { value: new Vector2(1, 1) }, cameraNearFar: { value: new Vector2(1, 1000) } };
  }

  setDepthTexture(depthTexture) {
    this.shared.sceneDepth.value = depthTexture;
  }

  update(renderer) {
    const { camera, scene, target } = this;
    this.shared.cameraNearFar.value.set(camera.near, camera.far);
    const mask = camera.layers.mask, override = scene.overrideMaterial;
    const clear = renderer.getClearColor(new Color()), alpha = renderer.getClearAlpha();
    camera.layers.set(this.layer);
    scene.overrideMaterial = null;
    renderer.setRenderTarget(target);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, false, false);
    renderer.render(scene, camera);
    camera.layers.mask = mask;
    scene.overrideMaterial = override;
    renderer.setClearColor(clear, alpha);
    this.blur.render(renderer, target);
  }

  setSize(width, height) {
    this.target.setSize(width, height);
    this.blur.setSize(width, height);
    this.shared.sceneResolution.value.set(width, height);
  }

  dispose() {
    super.dispose();
    this.target.dispose();
    this.blur.dispose();
  }
}

// Unlit glow shape around a widened center line (the same widening as the conductor tubes, a little wider so it
// sits in front of them). Fragments behind the scene depth are dropped, and distant glows fade (to 30% beyond
// fadeFar meters) so a whole feeder seen from afar does not merge into one bright patch.
export function lineGlowMaterial(shared, { color, attribute, radius, minPixels, pixelScale, fadeNear = 1500, fadeFar = 6000 }) {
  return new ShaderMaterial({
    uniforms: {
      sceneDepth: shared.sceneDepth, sceneResolution: shared.sceneResolution, cameraNearFar: shared.cameraNearFar,
      glowColor: { value: new Color().setRGB(...color) }, widenPixelScale: pixelScale,
      widenRadius: { value: radius }, widenMinPixels: { value: minPixels }, glowFade: { value: [fadeNear, fadeFar] }
    },
    vertexShader: `attribute vec3 ${attribute};
uniform float widenPixelScale;
uniform float widenRadius;
uniform float widenMinPixels;
void main() {
  vec4 center = modelViewMatrix * vec4(position, 1.0);
  float amount = max(widenRadius, -center.z * widenPixelScale * widenMinPixels * 0.5);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position + ${attribute} * amount, 1.0);
}`,
    fragmentShader: `#include <packing>
uniform sampler2D sceneDepth;
uniform vec2 sceneResolution;
uniform vec2 cameraNearFar;
uniform vec3 glowColor;
uniform vec2 glowFade;
void main() {
  float sceneZ = perspectiveDepthToViewZ(texture2D(sceneDepth, gl_FragCoord.xy / sceneResolution).r, cameraNearFar.x, cameraNearFar.y);
  float glowZ = perspectiveDepthToViewZ(gl_FragCoord.z, cameraNearFar.x, cameraNearFar.y);
  // View z is negative; something else is in front when the scene is closer by more than a small tolerance.
  if (sceneZ > glowZ + 0.5 + 0.004 * -glowZ) discard;
  gl_FragColor = vec4(glowColor * mix(1.0, 0.3, smoothstep(glowFade.x, glowFade.y, -glowZ)), 1.0);
}`
  });
}
