import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { VolumetricCloudsPass } from './volumetricClouds.js';

/**
 * Outside's post-processing: exponential height fog, and a post process
 * volume that controls exposure -- the two Unreal pieces an outdoor level
 * adds on top of its sun, sky light and atmosphere (scene/outside/outdoorLight.js).
 *
 * THE CHAIN, all in linear HDR until the very end:
 *
 *   render     the scene into a half-float target, with its depth kept
 *   clouds     volumetric clouds, ray-marched into a target of their own
 *              (scene/outside/volumetricClouds.js)
 *   fog        the clouds laid onto the sky, then height fog over it all,
 *              from that depth -- the clouds are composited here rather than
 *              in a pass of their own because this is where the depth is
 *   exposure   the frame's brightness measured, adapted to, and applied
 *   grading    white balance and colour correction (see GRADING)
 *   output     ACES tone mapping and sRGB, onto the screen
 *
 * EXPONENTIAL HEIGHT FOG. Fog whose density falls off exponentially with
 * height: thick in the valleys, thin on the peaks, and thicker the further
 * you look through it -- Unreal's model. It is done here, over the finished
 * frame, rather than inside every material: the depth buffer says where each
 * pixel is, so one pass fogs everything, including materials made later
 * (book pages, turning leaves) that a per-material patch would miss.
 *
 * The density along a view ray has a closed form. With density
 * d(h) = D * exp(-F * (h - H)), a ray from the camera (height c) that covers
 * distance L and rises by r = L * dir.y collects
 *
 *   D * exp(-F * (c - H)) * L * (1 - exp(-F * r)) / (F * r)
 *
 * which becomes opacity through 1 - exp(-amount).
 *
 * ITS COLOUR IS THE SKY'S. A flat fog colour never matches the sky behind
 * it: fogging the horizon with one grey paints a grey ring round the whole
 * scene. So the fog is coloured by a cubemap of the sky itself
 * (scene/outside/outdoorLight.js), read in the direction you are looking -- level
 * with the horizon when you look down, since that is the air in between --
 * and blurred, so it is the sky's colour rather than its detail. The horizon
 * then fogs into the horizon, which is how distance reads as haze. Unreal's
 * height fog does the same with its sky atmosphere. Looking toward the sun
 * the fog also takes on the sun's colour -- Unreal's directional
 * inscattering.
 *
 * EXPOSURE (eye adaptation). The frame's average brightness is measured on
 * the GPU: each pixel's log luminance is written into a small target whose
 * mip chain averages it down to one texel -- a geometric mean, the way auto
 * exposure is metered. The exposure that brings that average to middle grey
 * is eased toward over time, faster when it gets brighter than when it gets
 * darker, like eyes. Nothing is read back to the CPU.
 */

// --- exponential height fog --------------------------------------------------
const FOG = {
  density: 0.002, // per metre, at the fog's base height
  heightFalloff: 0.06, // per metre: density falls by e every 1/0.06 ~ 17 m up
  startDistance: 40, // metres of clear air in front of the camera
  maxOpacity: 1,
  color: 0xffffff, // a tint on the sky's own colour
  brightness: 1, // times the sky's brightness
  skyBlur: 3, // mip level of the sky cubemap read: 3 is 16 px a face, soft
  // Toward the sun: its colour, how strongly, and how tight a glow.
  inscatteringColor: 0xffe2b8,
  inscatteringBrightness: 0.8,
  inscatteringExponent: 8,
  // How far the sky counts as, for fogging it: far enough that the horizon
  // is fully fogged, and rays climbing away from the ground gather little.
  skyDistance: 3000,
};

// --- exposure -----------------------------------------------------------------
const EXPOSURE = {
  key: 0.18, // the brightness the average is brought to: middle grey
  compensation: 1, // a multiplier on top, like Unreal's exposure compensation
  min: 0.05,
  max: 4,
  speedBrighter: 3, // 1/s, adapting to a brighter frame
  speedDarker: 1, // 1/s, adapting to a darker one
};
const LUMINANCE_SIZE = 64; // metering resolution; its mip 6 is a single texel

// --- in VR ----------------------------------------------------------------------
// A headset cannot be shown the chain at all (see renderXR), so the two things
// it would miss most are done another way: the clouds are drawn into a cube
// around your head, and the exposure is metered from the six views of it.
const XR_CLOUD_FACE = 384; // texels a side of that cube
const XR_METER_SIZE = 32; // texels a side of each view the exposure is metered from
const XR_METER_INTERVAL = 0.2; // seconds between metering one more direction
const XR_START_EXPOSURE = 0.3; // until a reading comes back -- or if none can be read at all

const FULLSCREEN_VERTEX = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;

class HeightFogPass extends Pass {
  constructor({ camera, sunDirection, groundHeight, skyTexture, clouds = null }) {
    super();
    this.camera = camera;
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        tDepth: { value: null },
        tClouds: { value: null },
        cloudsOn: { value: 0 },
        fogOn: { value: 1 },
        projectionInverse: { value: new THREE.Matrix4() },
        cameraWorld: { value: new THREE.Matrix4() },
        cameraPos: { value: new THREE.Vector3() }, // not three's cameraPosition: that is the quad's camera
        fogColor: { value: new THREE.Color(FOG.color).multiplyScalar(FOG.brightness) },
        skyColour: { value: skyTexture },
        skyBlur: { value: FOG.skyBlur },
        fogDensity: { value: FOG.density },
        fogFalloff: { value: FOG.heightFalloff },
        fogHeight: { value: groundHeight },
        fogStart: { value: FOG.startDistance },
        fogMaxOpacity: { value: FOG.maxOpacity },
        skyDistance: { value: FOG.skyDistance },
        // The vector itself, not a copy: moving the sun moves the glow.
        sunDirection: { value: sunDirection },
        inscatterColor: {
          value: new THREE.Color(FOG.inscatteringColor).multiplyScalar(FOG.inscatteringBrightness),
        },
        inscatterExponent: { value: FOG.inscatteringExponent },
      },
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: /* glsl */`
        uniform sampler2D tDiffuse;
        uniform sampler2D tDepth;
        uniform sampler2D tClouds;
        uniform float cloudsOn;
        uniform float fogOn;
        uniform mat4 projectionInverse;
        uniform mat4 cameraWorld;
        uniform vec3 cameraPos;
        uniform vec3 fogColor;
        uniform samplerCube skyColour;
        uniform float skyBlur;
        uniform float fogDensity;
        uniform float fogFalloff;
        uniform float fogHeight;
        uniform float fogStart;
        uniform float fogMaxOpacity;
        uniform float skyDistance;
        uniform vec3 sunDirection;
        uniform vec3 inscatterColor;
        uniform float inscatterExponent;
        varying vec2 vUv;

        // A point on this pixel's view ray, in world space, at NDC depth z.
        vec3 worldAt(float z) {
          vec4 view = projectionInverse * vec4(vUv * 2.0 - 1.0, z, 1.0);
          return (cameraWorld * vec4(view.xyz / view.w, 1.0)).xyz;
        }

        void main() {
          vec4 scene = texture2D(tDiffuse, vUv);
          float depth = texture2D(tDepth, vUv).x;

          // The ray's direction from a point well inside the frustum: at the
          // far plane (the sky) the reconstruction divides by zero.
          vec3 direction = normalize(worldAt(0.0) - cameraPos);
          bool isSky = depth >= 0.99999;
          // The clouds, onto the sky only: they are always above the ground.
          if (isSky && cloudsOn > 0.5) {
            vec4 clouds = texture2D(tClouds, vUv);
            scene.rgb = scene.rgb * clouds.a + clouds.rgb;
          }
          // Not called "distance": that is a GLSL built-in.
          float rayLength = isSky ? skyDistance : length(worldAt(depth * 2.0 - 1.0) - cameraPos);
          rayLength = max(rayLength - fogStart, 0.0);

          // Density at the camera, then the closed-form integral along the ray.
          float atCamera = fogDensity * exp(-fogFalloff * (cameraPos.y - fogHeight));
          float rise = fogFalloff * direction.y * rayLength;
          float spread = abs(rise) > 1e-4 ? (1.0 - exp(-rise)) / rise : 1.0 - 0.5 * rise;
          float amount = atCamera * rayLength * spread;
          float opacity = min(1.0 - exp(-amount), fogMaxOpacity) * fogOn;

          // The sky in this direction -- never below the horizon, where the
          // sky model goes dark, since what lies between is still air.
          vec3 airDirection = normalize(vec3(direction.x, max(direction.y, 0.0), direction.z));
          vec3 sky = textureLod(skyColour, airDirection, skyBlur).rgb;
          vec3 colour = sky * fogColor
            + inscatterColor * pow(max(dot(direction, sunDirection), 0.0), inscatterExponent);
          gl_FragColor = vec4(mix(scene.rgb, colour, opacity), scene.a);
        }`,
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.material);
    this.clouds = clouds;
    this.brightness = FOG.brightness;
    this.inscatteringBrightness = FOG.inscatteringBrightness;
  }

  /** The fog colour's brightness, in scene light units. */
  setBrightness(value) {
    this.brightness = value;
    this.material.uniforms.fogColor.value.set(FOG.color).multiplyScalar(value);
  }

  /**
   * Whether the fog itself is on. Not the pass's `enabled`: the pass also
   * lays the clouds onto the sky, which have to keep showing without fog.
   */
  get fogEnabled() { return this.material.uniforms.fogOn.value > 0.5; }
  set fogEnabled(on) { this.material.uniforms.fogOn.value = on ? 1 : 0; }

  /** How bright the glow toward the sun is. */
  setInscatteringBrightness(value) {
    this.inscatteringBrightness = value;
    this.material.uniforms.inscatterColor.value.set(FOG.inscatteringColor).multiplyScalar(value);
  }

  render(renderer, writeBuffer, readBuffer) {
    const u = this.material.uniforms;
    u.tDiffuse.value = readBuffer.texture;
    u.tDepth.value = readBuffer.depthTexture;
    u.cloudsOn.value = this.clouds?.enabled ? 1 : 0;
    u.tClouds.value = this.clouds?.texture ?? null;
    u.projectionInverse.value.copy(this.camera.projectionMatrixInverse);
    u.cameraWorld.value.copy(this.camera.matrixWorld);
    u.cameraPos.value.setFromMatrixPosition(this.camera.matrixWorld);
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }

  dispose() {
    this.material.dispose();
    this.quad.dispose();
  }
}

class AutoExposurePass extends Pass {
  constructor() {
    super();

    // Log luminance, metered small; the renderer builds its mips after each
    // render, and the last one is the average.
    this.luminanceTarget = new THREE.WebGLRenderTarget(LUMINANCE_SIZE, LUMINANCE_SIZE, {
      type: THREE.HalfFloatType,
      generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
    });
    // The adapted value, one texel, ping-ponged so each frame can read the last.
    const adapted = () => new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: false,
    });
    this.adaptedRead = adapted();
    this.adaptedWrite = adapted();
    this.firstFrame = true;

    this.luminanceMaterial = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null } },
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: /* glsl */`
        uniform sampler2D tDiffuse;
        varying vec2 vUv;
        void main() {
          float luminance = dot(texture2D(tDiffuse, vUv).rgb, vec3(0.2126, 0.7152, 0.0722));
          gl_FragColor = vec4(log(max(luminance, 1e-4)), 0.0, 0.0, 1.0);
        }`,
      depthTest: false,
      depthWrite: false,
    });

    this.adaptMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tLuminance: { value: null },
        tPrevious: { value: null },
        lastLevel: { value: Math.log2(LUMINANCE_SIZE) },
        deltaTime: { value: 0 },
        speedBrighter: { value: EXPOSURE.speedBrighter },
        speedDarker: { value: EXPOSURE.speedDarker },
        reset: { value: 1 },
      },
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: /* glsl */`
        uniform sampler2D tLuminance;
        uniform sampler2D tPrevious;
        uniform float lastLevel;
        uniform float deltaTime;
        uniform float speedBrighter;
        uniform float speedDarker;
        uniform float reset;
        varying vec2 vUv;
        void main() {
          float measured = textureLod(tLuminance, vec2(0.5), lastLevel).r;
          float previous = texture2D(tPrevious, vec2(0.5)).r;
          float speed = measured > previous ? speedBrighter : speedDarker;
          float blend = reset > 0.5 ? 1.0 : 1.0 - exp(-deltaTime * speed);
          gl_FragColor = vec4(mix(previous, measured, blend), 0.0, 0.0, 1.0);
        }`,
      depthTest: false,
      depthWrite: false,
    });

    this.applyMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        tAdapted: { value: null },
        key: { value: EXPOSURE.key },
        compensation: { value: EXPOSURE.compensation },
        minExposure: { value: EXPOSURE.min },
        maxExposure: { value: EXPOSURE.max },
      },
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: /* glsl */`
        uniform sampler2D tDiffuse;
        uniform sampler2D tAdapted;
        uniform float key;
        uniform float compensation;
        uniform float minExposure;
        uniform float maxExposure;
        varying vec2 vUv;
        void main() {
          float averageLuminance = exp(texture2D(tAdapted, vec2(0.5)).r);
          float exposure = clamp(key / averageLuminance, minExposure, maxExposure) * compensation;
          vec4 colour = texture2D(tDiffuse, vUv);
          gl_FragColor = vec4(colour.rgb * exposure, colour.a);
        }`,
      depthTest: false,
      depthWrite: false,
    });

    this.quad = new FullScreenQuad(this.luminanceMaterial);
  }

  render(renderer, writeBuffer, readBuffer, deltaTime) {
    // Meter.
    this.luminanceMaterial.uniforms.tDiffuse.value = readBuffer.texture;
    this.quad.material = this.luminanceMaterial;
    renderer.setRenderTarget(this.luminanceTarget);
    this.quad.render(renderer);

    // Adapt: last frame's value eased toward this one's.
    const adapt = this.adaptMaterial.uniforms;
    adapt.tLuminance.value = this.luminanceTarget.texture;
    adapt.tPrevious.value = this.adaptedRead.texture;
    adapt.deltaTime.value = deltaTime;
    adapt.reset.value = this.firstFrame ? 1 : 0; // the first frame starts adapted
    this.firstFrame = false;
    this.quad.material = this.adaptMaterial;
    renderer.setRenderTarget(this.adaptedWrite);
    this.quad.render(renderer);
    [this.adaptedRead, this.adaptedWrite] = [this.adaptedWrite, this.adaptedRead];

    // Apply.
    this.applyMaterial.uniforms.tDiffuse.value = readBuffer.texture;
    this.applyMaterial.uniforms.tAdapted.value = this.adaptedRead.texture;
    this.quad.material = this.applyMaterial;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }

  dispose() {
    this.luminanceTarget.dispose();
    this.adaptedRead.dispose();
    this.adaptedWrite.dispose();
    this.luminanceMaterial.dispose();
    this.adaptMaterial.dispose();
    this.applyMaterial.dispose();
    this.quad.dispose();
  }
}

// --- color grading --------------------------------------------------------------
// Unreal's Color Grading, done last -- after the lights, fog and exposure have
// given all they can -- on the exposed HDR image, before tone mapping, which
// is where Unreal grades too.
//
// WHITE BALANCE is a chromatic adaptation: the white point a light of
// `temperature` (and `tint`, across the temperature line toward green or
// magenta) would have, adapted to D65 with the Bradford transform. At 6500 K
// and no tint it changes nothing. Lower temperatures cool the image, as
// telling a camera the light is warm does.
//
// SHADOWS / MIDTONES / HIGHLIGHTS each take saturation, contrast (about
// middle grey), gamma, gain and offset, combined with the global ones --
// multiplied, and offsets added -- and blended by the pixel's luminance:
// shadows fade out by `shadowsMax`, highlights fade in from `highlightsMin`,
// midtones are what is left.
const GRADING = {
  temperature: 6500, // kelvin
  tint: 0, // -1 green .. 1 magenta
  colour: { r: 1, g: 1, b: 1 }, // a global colour gain
  shadowsMax: 0.09,
  highlightsMin: 0.5,
  global: { saturation: 1, contrast: 1, gamma: 1, gain: 1, offset: 0 },
  shadows: { saturation: 1, contrast: 1, gamma: 1, gain: 1, offset: 0 },
  midtones: { saturation: 1, contrast: 1, gamma: 1, gain: 1, offset: 0 },
  highlights: { saturation: 1, contrast: 1, gamma: 1, gain: 1, offset: 0 },
};

const SRGB_TO_XYZ = new THREE.Matrix3().set(
  0.4124564, 0.3575761, 0.1804375,
  0.2126729, 0.7151522, 0.0721750,
  0.0193339, 0.1191920, 0.9503041,
);
const XYZ_TO_SRGB = new THREE.Matrix3().set(
  3.2404542, -1.5371385, -0.4985314,
  -0.9692660, 1.8760108, 0.0415560,
  0.0556434, -0.2040259, 1.0572252,
);
const BRADFORD = new THREE.Matrix3().set(
  0.8951, 0.2664, -0.1614,
  -0.7502, 1.7135, 0.0367,
  0.0389, -0.0685, 1.0296,
);
const BRADFORD_INVERSE = BRADFORD.clone().invert();
const D65 = [0.3127, 0.3290];

/** CIE 1960 uv on the Planckian locus at `kelvin` (Krystek's fit). */
function planckianUV(kelvin) {
  const t = kelvin;
  const u = (0.860117757 + 1.54118254e-4 * t + 1.28641212e-7 * t * t)
    / (1 + 8.42420235e-4 * t + 7.08145163e-7 * t * t);
  const v = (0.317398726 + 4.22806245e-5 * t + 4.20481691e-8 * t * t)
    / (1 - 2.89741816e-5 * t + 1.61456053e-7 * t * t);
  return [u, v];
}

function uvToXY([u, v]) {
  const d = 2 * u - 8 * v + 4;
  return [(3 * u) / d, (2 * v) / d];
}

/** CIE daylight (D series) chromaticity at `kelvin`; good above 4000 K. */
function daylightXY(kelvin) {
  const t = kelvin * (1.4388 / 1.438);
  const x = t <= 7000
    ? 0.244063 + (0.09911e3 + (2.9678e6 - 4.6070e9 / t) / t) / t
    : 0.237040 + (0.24748e3 + (1.9018e6 - 2.0064e9 / t) / t) / t;
  return [x, -3 * x * x + 2.87 * x - 0.275];
}

/** The locus point at `kelvin`, moved `tint` along its isotherm. */
function isothermalXY(kelvin, tint) {
  const t = kelvin;
  let [u, v] = planckianUV(t);
  const du = (-1.13758118e9 - 1.91615621e6 * t - 1.53177 * t * t)
    / (1.41213984e6 + 1189.62 * t + t * t) ** 2;
  const dv = (1.97471536e9 - 705674.0 * t - 308.607 * t * t)
    / (6.19363586e6 - 179.456 * t + t * t) ** 2;
  const length = Math.hypot(du, dv) || 1;
  // Perpendicular to the locus; CCT only means anything within +-0.05.
  u += (-dv / length) * tint * 0.05;
  v += (du / length) * tint * 0.05;
  return uvToXY([u, v]);
}

/** Linear sRGB -> linear sRGB, white balanced. Unreal's WhiteBalance. */
function whiteBalanceMatrix(kelvin, tint, out) {
  const planck = uvToXY(planckianUV(kelvin));
  const source = kelvin < 4000 ? planck : daylightXY(kelvin);
  const iso = isothermalXY(kelvin, tint);
  source[0] += iso[0] - planck[0];
  source[1] += iso[1] - planck[1];

  const xyz = ([x, y]) => new THREE.Vector3(x / y, 1, (1 - x - y) / y);
  const from = xyz(source).applyMatrix3(BRADFORD);
  const to = xyz(D65).applyMatrix3(BRADFORD);
  const vonKries = new THREE.Matrix3().set(
    to.x / from.x, 0, 0,
    0, to.y / from.y, 0,
    0, 0, to.z / from.z,
  );
  return out.copy(XYZ_TO_SRGB)
    .multiply(BRADFORD_INVERSE)
    .multiply(vonKries)
    .multiply(BRADFORD)
    .multiply(SRGB_TO_XYZ);
}

class ColorGradingPass extends Pass {
  constructor() {
    super();
    /** Live settings, GRADING's shape. Change them, then call update(). */
    this.settings = structuredClone(GRADING);

    const range = () => ({ value: new THREE.Vector4(1, 1, 1, 1) });
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        whiteBalance: { value: new THREE.Matrix3() },
        colourGain: { value: new THREE.Vector3(1, 1, 1) },
        shadowsMax: { value: GRADING.shadowsMax },
        highlightsMin: { value: GRADING.highlightsMin },
        // saturation, contrast, gamma, gain -- and each range's offset apart
        gradeGlobal: range(),
        gradeShadows: range(),
        gradeMidtones: range(),
        gradeHighlights: range(),
        offsetGlobal: { value: 0 },
        offsetShadows: { value: 0 },
        offsetMidtones: { value: 0 },
        offsetHighlights: { value: 0 },
      },
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: /* glsl */`
        uniform sampler2D tDiffuse;
        uniform mat3 whiteBalance;
        uniform vec3 colourGain;
        uniform float shadowsMax;
        uniform float highlightsMin;
        uniform vec4 gradeGlobal;
        uniform vec4 gradeShadows;
        uniform vec4 gradeMidtones;
        uniform vec4 gradeHighlights;
        uniform float offsetGlobal;
        uniform float offsetShadows;
        uniform float offsetMidtones;
        uniform float offsetHighlights;
        varying vec2 vUv;

        const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

        // Unreal's ColorCorrect: saturation, contrast about middle grey,
        // gamma, then gain and offset.
        vec3 correct(vec3 c, vec4 range, float offset) {
          vec4 g = gradeGlobal * range;
          c = max(vec3(0.0), mix(vec3(dot(c, LUMA)), c, g.x));
          c = pow(c / 0.18, vec3(g.y)) * 0.18;
          c = pow(c, vec3(1.0 / max(g.z, 1e-3)));
          return c * colourGain * g.w + (offsetGlobal + offset);
        }

        void main() {
          vec4 source = texture2D(tDiffuse, vUv);
          vec3 c = max(whiteBalance * source.rgb, vec3(0.0));
          float luma = dot(c, LUMA);

          float shadowWeight = 1.0 - smoothstep(0.0, shadowsMax, luma);
          float highlightWeight = smoothstep(highlightsMin, 1.0, luma);
          float midtoneWeight = max(1.0 - shadowWeight - highlightWeight, 0.0);

          vec3 graded = correct(c, gradeShadows, offsetShadows) * shadowWeight
            + correct(c, gradeMidtones, offsetMidtones) * midtoneWeight
            + correct(c, gradeHighlights, offsetHighlights) * highlightWeight;
          gl_FragColor = vec4(graded, source.a);
        }`,
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.material);
    this.update();
  }

  /** Push `settings` into the shader. */
  update() {
    const s = this.settings;
    const u = this.material.uniforms;
    whiteBalanceMatrix(s.temperature, s.tint, u.whiteBalance.value);
    u.colourGain.value.set(s.colour.r, s.colour.g, s.colour.b);
    u.shadowsMax.value = s.shadowsMax;
    u.highlightsMin.value = s.highlightsMin;
    for (const [name, key] of [
      ['global', 'Global'], ['shadows', 'Shadows'], ['midtones', 'Midtones'], ['highlights', 'Highlights'],
    ]) {
      const r = s[name];
      u[`grade${key}`].value.set(r.saturation, r.contrast, r.gamma, r.gain);
      u[`offset${key}`].value = r.offset;
    }
  }

  render(renderer, writeBuffer, readBuffer) {
    this.material.uniforms.tDiffuse.value = readBuffer.texture;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }

  dispose() {
    this.material.dispose();
    this.quad.dispose();
  }
}

/**
 * @param {object} opts
 * @param {THREE.WebGLRenderer} opts.renderer  its toneMapping is what the
 *   output step applies; exposure is this chain's, so its toneMappingExposure
 *   should be left at 1
 * @param {THREE.Scene} opts.scene
 * @param {THREE.PerspectiveCamera} opts.camera
 * @param {THREE.Vector3} opts.sunDirection  toward the sun
 * @param {number} opts.groundHeight  world height the fog is thickest at
 * @param {THREE.CubeTexture} opts.skyTexture  the sky, for the fog's colour
 *   and the clouds' ambient light
 * @param {THREE.DirectionalLight} opts.sun  the clouds are lit by its colour
 *   and intensity
 * @returns {{ render(dt: number): void, dispose(): void, fog: HeightFogPass,
 *   exposure: AutoExposurePass, grading: ColorGradingPass }}  the passes, for
 *   switching them off (`enabled`) and tuning them live
 */
export function createOutdoorPost({
  renderer, scene, camera, sunDirection, groundHeight, skyTexture, sun,
}) {
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  // Half float for HDR, multisampled because a render target does not get the
  // canvas's own antialiasing, and a float depth texture: at 300 m with a
  // 1 cm near plane, 24-bit depth is too coarse to say where the ground is.
  const target = new THREE.WebGLRenderTarget(size.x, size.y, {
    type: THREE.HalfFloatType,
    samples: 4,
    depthTexture: new THREE.DepthTexture(size.x, size.y, THREE.FloatType),
  });
  const composer = new EffectComposer(renderer, target);
  composer.setPixelRatio(renderer.getPixelRatio());
  composer.setSize(window.innerWidth, window.innerHeight);

  composer.addPass(new RenderPass(scene, camera));
  const clouds = new VolumetricCloudsPass({ camera, sun, sunDirection, skyTexture });
  composer.addPass(clouds);
  const fog = new HeightFogPass({ camera, sunDirection, groundHeight, skyTexture, clouds });
  composer.addPass(fog);
  const exposure = new AutoExposurePass();
  composer.addPass(exposure);
  const grading = new ColorGradingPass();
  composer.addPass(grading);
  const output = new OutputPass();
  composer.addPass(output);

  const onResize = () => composer.setSize(window.innerWidth, window.innerHeight);
  window.addEventListener('resize', onResize);

  // --- what VR gets instead ---------------------------------------------------
  // The cube the clouds are drawn into, the six views of it (three's CubeCamera
  // owns the six cameras and which way each faces), and a small target one of
  // those views is drawn into to meter the exposure.
  const xrCloudTarget = new THREE.WebGLCubeRenderTarget(XR_CLOUD_FACE, {
    type: THREE.HalfFloatType,
    depthBuffer: false,
    generateMipmaps: false,
  });
  const xrViews = new THREE.CubeCamera(camera.near, camera.far, xrCloudTarget);
  const xrMeterTarget = new THREE.WebGLRenderTarget(XR_METER_SIZE, XR_METER_SIZE, {
    type: THREE.FloatType,
  });

  // The clouds laid onto the sky: a box at the far plane, like the sky itself
  // (scene/outside/outdoorLight.js), so the depth buffer keeps it off
  // everything nearer -- exactly what the fog pass's `isSky` test does. Its
  // blending is that pass's composite: what is already there times the clouds'
  // transmittance, plus the light they scatter.
  const xrSky = new THREE.Mesh(
    new THREE.BoxGeometry(10, 10, 10),
    new THREE.ShaderMaterial({
      uniforms: { clouds: { value: xrCloudTarget.texture } },
      vertexShader: /* glsl */`
        varying vec3 vDirection;
        void main() {
          vec4 world = modelMatrix * vec4(position, 1.0);
          vDirection = world.xyz - cameraPosition;
          gl_Position = projectionMatrix * viewMatrix * world;
          gl_Position.z = gl_Position.w; // at the far plane, behind everything
        }`,
      fragmentShader: /* glsl */`
        uniform samplerCube clouds;
        varying vec3 vDirection;
        void main() {
          gl_FragColor = textureCube(clouds, normalize(vDirection));
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      side: THREE.BackSide,
      transparent: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.SrcAlphaFactor,
    }),
  );
  xrSky.name = 'xrClouds';
  xrSky.visible = false;
  xrSky.frustumCulled = false;
  xrSky.renderOrder = -1; // before anything else see-through: it is the furthest away
  scene.add(xrSky);

  const xr = {
    presenting: false, // whether the last frame drawn was a headset's
    clouded: false, // whether every face of the cloud cube has been drawn
    metered: false, // whether every direction has been metered
    cloudFace: 0,
    meterFace: 0,
    meterWait: 0,
    canMeter: true, // until a read comes back unreadable on this machine
    faceLog: new Array(6).fill(null), // each direction's average log luminance
    exposure: null,
  };
  const _head = new THREE.Vector3();

  /**
   * Draw something off-screen in the middle of a headset's frame: its own
   * target and its cameras are set aside meanwhile, the way three's CubeCamera
   * does it -- otherwise every render would be posed by the headset and go to
   * the headset.
   */
  function offscreen(draw) {
    const target = renderer.getRenderTarget();
    const face = renderer.getActiveCubeFace();
    const level = renderer.getActiveMipmapLevel();
    const wasXR = renderer.xr.enabled;
    renderer.xr.enabled = false;
    try {
      draw();
    } finally {
      renderer.setRenderTarget(target, face, level);
      renderer.xr.enabled = wasXR;
    }
  }

  /** The average of the log luminance of a read-back view: how exposure is metered. */
  function logAverage(pixels) {
    let total = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      const luminance = 0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2];
      total += Math.log(Math.max(luminance, 1e-4));
    }
    return total / (pixels.length / 4);
  }

  /**
   * Meter one of the six directions: the scene drawn small, and its brightness
   * read back. `now` reads it back there and then -- a stall, worth it once on
   * the first frame so the first thing you see is exposed; every reading after
   * that is asked for and collected whenever it is ready.
   */
  function meterFace(face, hide, now) {
    const hidden = hide.filter((object) => object?.visible);
    for (const object of hidden) object.visible = false;
    renderer.setRenderTarget(xrMeterTarget);
    renderer.render(scene, xrViews.children[face]);
    for (const object of hidden) object.visible = true;

    const pixels = new Float32Array(XR_METER_SIZE * XR_METER_SIZE * 4);
    try {
      if (now) {
        renderer.readRenderTargetPixels(xrMeterTarget, 0, 0, XR_METER_SIZE, XR_METER_SIZE, pixels);
        xr.faceLog[face] = logAverage(pixels);
      } else {
        renderer
          .readRenderTargetPixelsAsync(xrMeterTarget, 0, 0, XR_METER_SIZE, XR_METER_SIZE, pixels)
          .then(() => { xr.faceLog[face] = logAverage(pixels); })
          .catch(() => { xr.canMeter = false; });
      }
    } catch {
      // Nothing here can read a float buffer back; VR keeps a fixed exposure.
      xr.canMeter = false;
    }
  }

  /** The exposure the directions metered so far ask for, or null with none yet. */
  function meteredExposure() {
    const readings = xr.faceLog.filter((log) => log !== null);
    if (!readings.length) return null;
    const average = Math.exp(readings.reduce((sum, log) => sum + log, 0) / readings.length);
    const u = exposure.applyMaterial.uniforms;
    return THREE.MathUtils.clamp(
      u.key.value / average, u.minExposure.value, u.maxExposure.value,
    ) * u.compensation.value;
  }

  return {
    clouds,
    fog,
    exposure,
    grading,

    /**
     * Apply a graphics quality preset (state/quality.js): anti-aliasing on
     * the HDR buffers, the clouds' resolution and steps, and the renderer's
     * pixel ratio, which may have changed with it.
     */
    applyQuality({ msaa, cloudResolution, cloudSteps }) {
      for (const buffer of [composer.renderTarget1, composer.renderTarget2]) {
        if (buffer.samples === msaa) continue;
        buffer.samples = msaa;
        buffer.dispose(); // made again at the new sample count when next drawn into
      }
      clouds.setQuality({ resolution: cloudResolution, steps: cloudSteps });
      // Resizes the buffers and every pass -- the clouds' at their new fraction.
      composer.setPixelRatio(renderer.getPixelRatio());
    },

    render(dt) {
      // The clouds come through the chain on a screen; the VR layer would only
      // draw them a second time.
      xrSky.visible = false;
      xr.presenting = false;
      composer.render(dt);
    },

    /**
     * Draw the frame for a headset, which cannot be shown the chain above: it
     * renders into targets of its own, and an XR session presents only its own.
     * So the two pieces VR misses most are done another way.
     *
     *   CLOUDS ray-marched into a cube around your head rather than onto the
     *   screen -- one face a frame, which is far less than the clouds move --
     *   and laid over the sky by a box at the far plane, with the same
     *   composite the fog pass does. Per eye for free: each eye reads the cube
     *   in the direction it is looking.
     *
     *   EXPOSURE metered the same way as on a screen (the average log
     *   luminance brought to middle grey) but from the six views of that cube
     *   instead of from the frame, a direction at a time, and applied as the
     *   renderer's own exposure. It is what you are standing in rather than
     *   what you are looking at: an exposure that slides about as you turn
     *   your head is unpleasant in a headset.
     *
     * The height fog and the colour grading are still left out.
     *
     * @param {number} dt
     * @param {{ hide?: THREE.Object3D[] }} [opts]  what to leave out of the
     *   metering: the grass, which costs more to draw than it changes the
     *   reading, and the controllers in front of your face.
     */
    renderXR(dt, { hide = [] } = {}) {
      // Coming in from the desktop, or the sun having moved: everything is
      // drawn and metered again from scratch.
      if (!xr.presenting) {
        xr.presenting = true;
        xr.clouded = false;
        xr.metered = false;
      }
      camera.getWorldPosition(_head);
      xrViews.position.copy(_head);
      if (xrViews.coordinateSystem !== renderer.coordinateSystem) {
        xrViews.coordinateSystem = renderer.coordinateSystem;
        xrViews.updateCoordinateSystem();
      }
      xrViews.updateMatrixWorld(true);

      clouds.advance(dt);
      xrSky.visible = clouds.enabled;
      xrSky.position.copy(_head);
      xrSky.updateMatrixWorld(true);

      offscreen(() => {
        if (clouds.enabled) {
          // The whole sky at once the first frame, a face a frame after that.
          for (let i = 0; i < (xr.clouded ? 1 : 6); i++) {
            clouds.renderCubeFace(renderer, xrViews.children[xr.cloudFace], xrCloudTarget, xr.cloudFace);
            xr.cloudFace = (xr.cloudFace + 1) % 6;
          }
          xr.clouded = true;
        }
        if (!exposure.enabled || !xr.canMeter) return;
        if (!xr.metered) {
          // After the clouds, so what is metered is the sky you will see.
          for (let face = 0; face < 6; face++) meterFace(face, hide, true);
          xr.metered = true;
          xr.meterWait = XR_METER_INTERVAL;
          return;
        }
        xr.meterWait -= dt;
        if (xr.meterWait > 0) return;
        meterFace(xr.meterFace, hide, false);
        xr.meterFace = (xr.meterFace + 1) % 6;
        xr.meterWait = XR_METER_INTERVAL;
      });

      // Eased toward, at the same speeds the screen's adaptation uses.
      const wanted = exposure.enabled ? meteredExposure() ?? XR_START_EXPOSURE : 1;
      const u = exposure.adaptMaterial.uniforms;
      if (xr.exposure === null) xr.exposure = wanted;
      else {
        const speed = wanted < xr.exposure ? u.speedBrighter.value : u.speedDarker.value;
        xr.exposure = THREE.MathUtils.damp(xr.exposure, wanted, speed, dt);
      }

      const was = renderer.toneMappingExposure;
      renderer.toneMappingExposure = xr.exposure;
      renderer.render(scene, camera);
      renderer.toneMappingExposure = was;
    },

    dispose() {
      window.removeEventListener('resize', onResize);
      scene.remove(xrSky);
      xrSky.geometry.dispose();
      xrSky.material.dispose();
      xrCloudTarget.dispose();
      xrMeterTarget.dispose();
      clouds.dispose();
      fog.dispose();
      exposure.dispose();
      grading.dispose();
      output.dispose();
      composer.dispose(); // its two render targets, depth textures included
    },
  };
}