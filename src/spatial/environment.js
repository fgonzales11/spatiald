// Atmosphere and volumetric clouds adapted from di-app-athon/src/spatial-scene.js.
import {
  Data3DTexture,
  HalfFloatType,
  LinearFilter,
  LinearMipMapLinearFilter,
  Matrix4,
  NoColorSpace,
  RedFormat,
  RepeatWrapping,
  TextureLoader,
  Uniform,
  Vector2,
  Vector3,
} from "three";
import {
  EffectComposer,
  Effect,
  EffectMaterial,
  EffectPass,
  NormalPass,
  RenderPass,
  SMAAEffect,
  ToneMappingEffect,
  ToneMappingMode,
} from "postprocessing";
import {
  AerialPerspectiveEffect,
  PrecomputedTexturesGenerator,
  getECIToECEFRotationMatrix,
  getMoonDirectionECI,
  getSunDirectionECI,
} from "@takram/three-atmosphere";
import {
  CLOUD_SHAPE_DETAIL_TEXTURE_SIZE,
  CLOUD_SHAPE_TEXTURE_SIZE,
  CloudsEffect,
} from "@takram/three-clouds";
import {
  DataTextureLoader,
  STBNLoader,
  parseUint8Array,
} from "@takram/three-geospatial";
import {
  ENVIRONMENT_SETTINGS,
  environmentPreferences,
} from "./environment-settings.js";
export { ENVIRONMENT_SETTINGS } from "./environment-settings.js";

const ASSETS = `${import.meta.env.BASE_URL}environment/`;

function radianceScale(camera, scale) {
  return new EffectPass(camera, new Effect('AtmosphereRadianceScale', `
uniform float radianceScale;
void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  outputColor = vec4(inputColor.rgb * radianceScale, inputColor.a);
}`, {uniforms:new Map([['radianceScale',new Uniform(scale)]])}));
}

/** Owns effects, textures, initialization, and cleanup for one 3D viewport. */
export function createEnvironment({
  renderer,
  scene,
  camera,
  settings,
  glow,
  onState = () => {},
  onUnavailable = () => {},
}) {
  let ready = false,
    disposed = false,
    initializing = null;
  let preferences = environmentPreferences(settings);
  const textures = new Set();
  const aerial = new AerialPerspectiveEffect(camera);
  aerial.sky = true;
  // Google's photographic tiles already contain daylight. Re-lighting their
  // texture washes out the image and would require a different exposure.
  aerial.sunLight = false;
  aerial.skyLight = false;
  aerial.correctGeometricError = true;
  aerial.correctAltitude = true;
  aerial.albedoScale = 2 / Math.PI;
  aerial.transmittance = true;
  aerial.inscatter = true;

  const clouds = new CloudsEffect(camera);
  clouds.qualityPreset = ENVIRONMENT_SETTINGS.qualityPreset;
  clouds.coverage = preferences.cloudCoverage;
  clouds.resolutionScale = ENVIRONMENT_SETTINGS.cloudResolutionScale;
  clouds.localWeatherVelocity.set(0.001, 0);
  clouds.shadow.farScale = 0.25;
  clouds.correctAltitude = true;

  const syncClouds = () => {
    aerial.overlay = preferences.cloudsEnabled
      ? clouds.atmosphereOverlay
      : null;
    aerial.shadow = preferences.cloudsEnabled ? clouds.atmosphereShadow : null;
    aerial.shadowLength = preferences.cloudsEnabled
      ? clouds.atmosphereShadowLength
      : null;
  };
  clouds.events.addEventListener("change", syncClouds);
  syncClouds();

  const generator = new PrecomputedTexturesGenerator(renderer);
  Object.assign(aerial, generator.textures);
  Object.assign(clouds, generator.textures);

  const rotation = getECIToECEFRotationMatrix(
    new Date(ENVIRONMENT_SETTINGS.date),
    new Matrix4(),
  );
  const sun = getSunDirectionECI(
    new Date(ENVIRONMENT_SETTINGS.date),
    new Vector3(),
  ).applyMatrix4(rotation);
  const moon = getMoonDirectionECI(
    new Date(ENVIRONMENT_SETTINGS.date),
    new Vector3(),
  ).applyMatrix4(rotation);
  aerial.sunDirection.copy(sun);
  aerial.moonDirection.copy(moon);
  clouds.sunDirection.copy(sun);

  const composer = new EffectComposer(renderer, {
    frameBufferType: HalfFloatType,
    multisampling: 0,
  });
  const normals = new NormalPass(scene, camera);
  normals.renderTarget.texture.type = HalfFloatType;
  aerial.normalBuffer = normals.texture;
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(normals);
  normals.enabled = false;
  // The atmospheric model emits physical radiance while Google's photographed
  // tiles are already exposed. Convert the scene into atmosphere units and back
  // around that pass: daylight sky is bright without overexposing the terrain.
  const toAtmosphere = radianceScale(camera, 1 / ENVIRONMENT_SETTINGS.exposure);
  const toPhotograph = radianceScale(camera, ENVIRONMENT_SETTINGS.exposure);
  composer.addPass(toAtmosphere);
  toAtmosphere.enabled = toPhotograph.enabled = false;
  // Initialize both effects and their shared depth texture, even when a saved
  // preference starts with clouds off. They can then be enabled without a remount.
  const atmospherePass = new EffectPass(camera, clouds, aerial);
  composer.addPass(atmospherePass);
  atmospherePass.enabled = false;
  composer.addPass(toPhotograph);
  if (glow) composer.addPass(new EffectPass(camera, glow));
  composer.addPass(
    new EffectPass(
      camera,
      new ToneMappingEffect({ mode: ToneMappingMode.AGX }),
    ),
  );
  composer.addPass(new EffectPass(camera, new SMAAEffect()));
  if (!preferences.cloudsEnabled) {
    atmospherePass.setEffects([aerial]);
    atmospherePass.recompile();
  }

  function report() {
    onState({ready, cloudsEnabled:preferences.cloudsEnabled, cloudCoverage:preferences.cloudCoverage});
  }
  report();

  function load(loader, file, configure = () => {}) {
    return new Promise((resolve, reject) => {
      const texture = loader.load(
        `${ASSETS}${file}`,
        (loaded) => {
          configure(loaded);
          if (disposed) loaded.dispose();
          resolve(loaded);
        },
        undefined,
        reject,
      );
      textures.add(texture);
    });
  }
  function image(file) {
    return load(new TextureLoader(), file, (texture) => {
      texture.minFilter = LinearMipMapLinearFilter;
      texture.magFilter = LinearFilter;
      texture.wrapS = texture.wrapT = RepeatWrapping;
      texture.colorSpace = NoColorSpace;
      texture.needsUpdate = true;
    });
  }
  function volume(file, size) {
    return load(
      new DataTextureLoader(Data3DTexture, parseUint8Array, {
        width: size,
        height: size,
        depth: size,
        format: RedFormat,
        minFilter: LinearFilter,
        magFilter: LinearFilter,
        wrapS: RepeatWrapping,
        wrapT: RepeatWrapping,
        wrapR: RepeatWrapping,
        colorSpace: NoColorSpace,
      }),
      file,
    );
  }

  function start() {
    if (disposed || initializing) return initializing;
    // Begin GPU precomputation only after the map's first model loads. A rejected
    // map key therefore does not start a needless atmospheric calculation.
    const scattering = generator.update();
    initializing = Promise.all([
      image("local_weather.png"),
      volume("shape.bin", CLOUD_SHAPE_TEXTURE_SIZE),
      volume("shape_detail.bin", CLOUD_SHAPE_DETAIL_TEXTURE_SIZE),
      image("turbulence.png"),
      load(new STBNLoader(), "stbn.bin"),
      scattering,
    ])
      .then(([weather, shape, detail, turbulence, stbn]) => {
        if (disposed) return;
        clouds.localWeatherTexture = weather;
        clouds.shapeTexture = shape;
        clouds.shapeDetailTexture = detail;
        clouds.turbulenceTexture = turbulence;
        clouds.stbnTexture = stbn;
        aerial.stbnTexture = stbn;
        ready = true;
        normals.enabled = atmospherePass.enabled = toAtmosphere.enabled = toPhotograph.enabled = true;
        report();
      })
      .catch(() => {
        if (!disposed) {
          report();
          onUnavailable();
        }
      });
    // Preserve the renderer until GPU precomputation has settled, even if a noise
    // texture failed first or the user immediately switches map views.
    initializing = Promise.allSettled([initializing, scattering]);
    return initializing;
  }

  return {
    start,
    get ready() {
      return ready;
    },
    setClouds(value) {
      if (disposed) return;
      const next = environmentPreferences(value);
      const changed = next.cloudsEnabled !== preferences.cloudsEnabled;
      preferences = next;
      clouds.coverage = next.cloudCoverage;
      if (changed) {
        atmospherePass.setEffects(
          next.cloudsEnabled ? [clouds, aerial] : [aerial],
        );
        atmospherePass.recompile();
        const size = renderer.getDrawingBufferSize(new Vector2());
        clouds.setSize(size.x, size.y);
        syncClouds();
      }
      report();
    },
    resize(width, height) {
      if (!disposed && width && height) composer.setSize(width, height);
    },
    render(deltaTime) {
      if (disposed) return false;
      // Keep the map and its glow rendering while cloud textures and scattering
      // tables warm up, and retain that working pipeline if an asset fails.
      // GlobeControls adjusts clipping planes while navigating the globe.
      for (const pass of composer.passes) {
        if (pass.fullscreenMaterial instanceof EffectMaterial)
          pass.fullscreenMaterial.adoptCameraSettings(camera);
      }
      composer.render(deltaTime);
      return true;
    },
    dispose() {
      disposed = true;
      ready = false;
      clouds.events.removeEventListener("change", syncClouds);
      const clean = () => {
        composer.dispose();
        if (!preferences.cloudsEnabled) clouds.dispose();
        generator.dispose();
        for (const texture of textures) texture.dispose();
        textures.clear();
      };
      if (initializing) return initializing.then(clean);
      clean();
      return Promise.resolve();
    },
  };
}
