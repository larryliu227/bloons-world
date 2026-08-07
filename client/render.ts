/**
 * BLOONS WORLD — the renderer.
 *
 * WebGL2, by hand, with no graphics library underneath it. A voxel world needs
 * exactly five programs and one texture, and the thing that actually decides whether
 * it runs at sixty frames is the layout of the vertex data — which a general-purpose
 * scene graph would take away from you in exchange for conveniences this has no use
 * for. There are no materials, no nodes, no scene, and no transforms to speak of.
 *
 * What there is:
 *
 *   sky        one triangle covering the screen, shaded from the ray through each
 *              pixel. Sun, moon, stars, clouds and horizon, no geometry.
 *   chunks     one draw call per 16³ chunk, frustum culled, lighting already baked
 *              into the vertices by the mesher.
 *   entities   one unit cube, drawn again and again with different matrices: the
 *              people, the block in your hand, and the cracks on what you are digging.
 *   lines      the wireframe box around the block you are pointing at.
 *   particles  point sprites, for the spray when a block gives way.
 *
 * The whole world is 256 chunks and the far plane sees all of it, so there is no
 * streaming, no popping and no render distance setting. Frustum culling alone throws
 * away about four fifths of the draw calls.
 */

import {
  CHUNK,
  CHUNK_COUNT,
  EYE_H,
  PLAYER_H,
  blockLight,
  chunkCoords,
  getBlock,
  skyLight,
  takeDirtyChunks,
} from '../shared/world.js';
import type { Hit, Player } from '../shared/world.js';
import { AIR, BLOCKS, CRACK_STAGES, TEX, TEX_LAYERS, blockDef } from '../shared/blocks.js';
import { TEX_SIZE, buildAtlas } from './atlas.js';
import { MAX_QUADS, VERTEX_BYTES, buildChunk } from './mesh.js';
import {
  boxVisible,
  compile,
  extractFrustum,
  frustum,
  fromTranslation,
  invert,
  lookAlong,
  mat4,
  multiply,
  perspective,
  project,
  rotateX,
  rotateY,
  rotateZ,
  scale,
  uniforms,
} from './gl.js';

/** Everything the renderer needs to know about this instant. */
export interface View {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  /** 0..1 through the day. 0.25 is dawn, 0.5 is noon, 0.75 is dusk. */
  day: number;
  /** Everybody, including you — your own body is skipped by id. */
  players: Player[];
  meId: string;
  /** The block the crosshair is on, or null. */
  target: Hit | null;
  /** How far through digging it, 0..1. */
  breaking: number;
  /** The block in your hand, or AIR. */
  held: number;
  /** Seconds since the page loaded, for anything that moves on its own. */
  time: number;
  /** Head bob and hand swing want to know. */
  walking: number;
  underwater: boolean;
}

const FOV = (72 * Math.PI) / 180;
const NEAR = 0.08;
const FAR = 420;
/** Where the fog starts eating the world, and where it has finished. */
const FOG_NEAR = 110;
const FOG_FAR = 260;

// ---------------------------------------------------------------------------
// Shaders

const CHUNK_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec3 aPos;
layout(location = 1) in uint aData;

uniform mat4 uViewProj;
uniform vec3 uChunk;

out vec2 vUv;
flat out float vLayer;
out float vShade;
out vec2 vLight;
out vec3 vWorld;

/*
 * Faces are shaded by which way they point and nothing else — no normals, no light
 * direction, no dot products. It is the oldest trick in the genre and it is the
 * reason a stack of identical grey cubes reads as cubes at all: the top is full
 * strength, the bottom is half, and the four sides are somewhere between, with the
 * two axes deliberately different so a corner has an edge in it.
 */
const float FACE[6] = float[6](0.72, 0.72, 1.0, 0.5, 0.88, 0.88);
const float AO[4] = float[4](0.48, 0.68, 0.85, 1.0);

void main() {
  vec3 world = aPos + uChunk;
  vWorld = world;
  gl_Position = uViewProj * vec4(world, 1.0);

  uint corner = (aData >> 8u) & 3u;
  uint face = min((aData >> 10u) & 7u, 5u);
  vLayer = float(aData & 255u);
  vLight = vec2(float((aData >> 13u) & 15u), float((aData >> 17u) & 15u)) / 15.0;
  vShade = FACE[face] * AO[(aData >> 21u) & 3u];

  // Which corner you are IS the texture coordinate: 0 bottom-left, then round.
  vUv = vec2(
    (corner == 1u || corner == 2u) ? 1.0 : 0.0,
    (corner == 0u || corner == 1u) ? 1.0 : 0.0
  );
}`;

const CHUNK_FS = `#version 300 es
precision highp float;
precision highp sampler2DArray;

in vec2 vUv;
flat in float vLayer;
in float vShade;
in vec2 vLight;
in vec3 vWorld;

uniform sampler2DArray uTex;
uniform vec3 uSunColor;
uniform float uSkyBright;
uniform vec3 uFog;
uniform float uFogNear;
uniform float uFogFar;
uniform vec3 uCam;
uniform float uAlpha;
uniform float uTime;
uniform float uWavy;

out vec4 outColor;

/* The lamp's colour. Warm on purpose, so a lit room at night is obviously lit by
 * something you put there rather than by a sun that forgot to set. */
const vec3 LAMP = vec3(1.0, 0.83, 0.58);

void main() {
  vec2 uv = vUv;
  if (uWavy > 0.5) {
    uv += vec2(sin(uTime * 1.3 + vWorld.x * 0.8) * 0.03, cos(uTime * 1.05 + vWorld.z * 0.8) * 0.03);
  }
  vec4 tex = texture(uTex, vec3(uv, vLayer));
  // Leaves, glass and flowers are mostly hole. Discarding rather than blending means
  // they still write depth and still sort correctly against everything else.
  if (tex.a < 0.35) discard;

  /*
   * Fifteen levels of light, on a curve rather than a ramp.
   *
   * Linear light levels look wrong: the difference between 15 and 14 is invisible and
   * the difference between 2 and 1 is a cliff. Each level being about four fifths of
   * the one above matches how the eye reads brightness, and is what makes a cave
   * mouth fade instead of stepping.
   */
  vec3 sky = uSunColor * pow(0.82, (1.0 - vLight.x * uSkyBright) * 15.0);
  vec3 lamp = LAMP * pow(0.82, (1.0 - vLight.y) * 15.0);
  /*
   * A floor under the darkness, and it is a gameplay number rather than a lighting
   * one. At light zero the curve above lands on a twentieth, which is black enough
   * that an unlit cave is not dark — it is a screen with nothing on it, and you
   * cannot find your way back out of a room you cannot see the walls of. The first
   * lamp costs four sand and three coal, which is a walk to the beach and a dig, and
   * it should be something you WANT rather than something you cannot play without.
   */
  vec3 lit = max(sky, lamp) + 0.075;

  vec3 col = tex.rgb * vShade * lit;
  col = mix(col, uFog, smoothstep(uFogNear, uFogFar, distance(vWorld, uCam)));
  outColor = vec4(col, tex.a * uAlpha);
}`;

const SKY_VS = `#version 300 es
precision highp float;
out vec2 vNdc;
void main() {
  // One triangle bigger than the screen, from nothing but the vertex number. A quad
  // would need a buffer and would have a seam down its diagonal.
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vNdc = p * 2.0 - 1.0;
  gl_Position = vec4(vNdc, 1.0, 1.0);
}`;

const SKY_FS = `#version 300 es
precision highp float;

in vec2 vNdc;
uniform mat4 uInvViewProj;
uniform vec3 uCam;
uniform vec3 uSunDir;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform float uNight;
uniform float uTime;
/* Zero under the water: the gradient stays (it is the water's own colour) but the
 * sun, the moon, the stars and the clouds are all things you cannot see from down
 * there, and a sun disc shining through the seabed is worse than no sky at all. */
uniform float uSkyFeatures;
out vec4 outColor;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), f.x),
             mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), f.x), f.y);
}

void main() {
  // The ray through this pixel, recovered by pushing the far plane back through the
  // inverse of the matrix that put it there.
  vec4 far = uInvViewProj * vec4(vNdc, 1.0, 1.0);
  vec3 dir = normalize(far.xyz / far.w - uCam);

  float up = dir.y;
  vec3 col = mix(uHorizon, uZenith, pow(clamp(up, 0.0, 1.0), 0.42));
  col = mix(col, uHorizon * 0.5, clamp(-up * 2.6, 0.0, 1.0));

  // The sun: a hard disc with a soft glow around it, so looking at it is bright and
  // looking near it is warm.
  float sd = dot(dir, uSunDir);
  col += vec3(1.0, 0.95, 0.82) * smoothstep(0.9976, 0.9992, sd) * 2.4 * uSkyFeatures;
  col += vec3(1.0, 0.74, 0.42) * pow(max(sd, 0.0), 180.0) * 0.55 * uSkyFeatures;

  float md = dot(dir, -uSunDir);
  col += vec3(0.86, 0.9, 1.0) * smoothstep(0.9986, 0.9996, md) * 1.6 * uNight * uSkyFeatures;

  if (uNight > 0.02 && up > -0.02 && uSkyFeatures > 0.5) {
    // Stars on a fixed grid of directions, so they stay put as you turn around
    // instead of crawling across the sky.
    vec3 cell = floor(dir * 210.0);
    float h = hash12(cell.xy + cell.z * 71.3);
    float twinkle = 0.65 + 0.35 * sin(uTime * 2.2 + h * 60.0);
    col += vec3(step(0.9979, h) * uNight * twinkle * 1.4);
  }

  if (up > 0.035 && uSkyFeatures > 0.5) {
    /*
     * Clouds, on a flat sheet a long way up. The ray is intersected with that sheet
     * and the noise is sampled where it lands, which is a real projection rather
     * than a texture on a dome — so they slide past overhead the way clouds do and
     * pile up towards the horizon the way clouds do.
     */
    float t = (150.0 - uCam.y) / up;
    vec2 cp = (uCam.xz + dir.xz * t) * 0.0042 + vec2(uTime * 0.0035, uTime * 0.0012);
    float n = vnoise(cp) * 0.6 + vnoise(cp * 2.3) * 0.3 + vnoise(cp * 5.1) * 0.1;
    float cover = smoothstep(0.50, 0.74, n) * smoothstep(0.035, 0.30, up);
    vec3 cloud = mix(vec3(0.32, 0.36, 0.46), vec3(1.0, 0.99, 0.96), 1.0 - uNight);
    col = mix(col, cloud, cover * 0.8);
  }

  outColor = vec4(col, 1.0);
}`;

const ENTITY_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec2 aUv;
layout(location = 3) in float aFaceKind;

uniform mat4 uMVP;
uniform mat4 uModel;

out vec2 vUv;
out vec3 vNormal;
out vec3 vWorld;
flat out float vKind;

void main() {
  vec4 world = uModel * vec4(aPos, 1.0);
  vWorld = world.xyz;
  gl_Position = uMVP * vec4(aPos, 1.0);
  vUv = aUv;
  vNormal = aNormal;
  vKind = aFaceKind;
}`;

const ENTITY_FS = `#version 300 es
precision highp float;
precision highp sampler2DArray;

in vec2 vUv;
in vec3 vNormal;
in vec3 vWorld;
flat in float vKind;

uniform sampler2DArray uTex;
uniform vec4 uColor;
uniform float uUseTex;
uniform vec3 uLayers;
uniform float uLight;
uniform vec3 uFog;
uniform float uFogNear;
uniform float uFogFar;
uniform vec3 uCam;
uniform float uFogged;

out vec4 outColor;

void main() {
  vec4 base = uColor;
  if (uUseTex > 0.5) {
    float layer = vKind < 0.5 ? uLayers.x : (vKind < 1.5 ? uLayers.y : uLayers.z);
    vec4 tex = texture(uTex, vec3(vUv, layer));
    if (tex.a < 0.02) discard;
    base = vec4(tex.rgb * uColor.rgb, tex.a * uColor.a);
  }
  // The same six-way shading the chunks use, so a person standing on the grass is
  // lit like the grass is.
  float shade = vNormal.y > 0.5 ? 1.0 : (vNormal.y < -0.5 ? 0.5 : (abs(vNormal.x) > 0.5 ? 0.72 : 0.88));
  vec3 col = base.rgb * shade * uLight;
  if (uFogged > 0.5) col = mix(col, uFog, smoothstep(uFogNear, uFogFar, distance(vWorld, uCam)));
  outColor = vec4(col, base.a);
}`;

const LINE_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec3 aPos;
uniform mat4 uMVP;
void main() { gl_Position = uMVP * vec4(aPos, 1.0); }`;

const LINE_FS = `#version 300 es
precision highp float;
uniform vec4 uColor;
out vec4 outColor;
void main() { outColor = uColor; }`;

const PARTICLE_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aColor;
layout(location = 2) in float aSize;
uniform mat4 uViewProj;
uniform float uScale;
out vec3 vColor;
void main() {
  gl_Position = uViewProj * vec4(aPos, 1.0);
  // Perspective by hand: a point sprite has no geometry to be shrunk by the
  // projection, so its size has to be divided by depth explicitly.
  gl_PointSize = max(1.0, aSize * uScale / gl_Position.w);
  vColor = aColor;
}`;

const PARTICLE_FS = `#version 300 es
precision highp float;
in vec3 vColor;
out vec4 outColor;
void main() { outColor = vec4(vColor, 1.0); }`;

// ---------------------------------------------------------------------------

interface ChunkGL {
  opaqueVao: WebGLVertexArrayObject | null;
  opaqueVbo: WebGLBuffer | null;
  opaqueQuads: number;
  waterVao: WebGLVertexArrayObject | null;
  waterVbo: WebGLBuffer | null;
  waterQuads: number;
  built: boolean;
}

interface Particle {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  r: number;
  g: number;
  b: number;
  size: number;
}

export class Renderer {
  readonly el: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  readonly tags: HTMLElement;

  private gl: WebGL2RenderingContext;
  private chunkProg: WebGLProgram;
  private chunkU: Record<string, WebGLUniformLocation>;
  private skyProg: WebGLProgram;
  private skyU: Record<string, WebGLUniformLocation>;
  private entityProg: WebGLProgram;
  private entityU: Record<string, WebGLUniformLocation>;
  private lineProg: WebGLProgram;
  private lineU: Record<string, WebGLUniformLocation>;
  private particleProg: WebGLProgram;
  private particleU: Record<string, WebGLUniformLocation>;

  private atlasTex: WebGLTexture;
  private atlasData: Uint8Array;
  /** One representative colour per block, for the break spray. */
  private blockColor: [number, number, number][] = [];

  private quadIbo: WebGLBuffer;
  private cubeVao: WebGLVertexArrayObject;
  private lineVao: WebGLVertexArrayObject;
  private emptyVao: WebGLVertexArrayObject;
  private particleVao: WebGLVertexArrayObject;
  private particleVbo: WebGLBuffer;

  private chunks: ChunkGL[] = [];
  private pending = new Set<number>();

  private proj = mat4();
  private view = mat4();
  private viewProj = mat4();
  private invViewProj = mat4();
  private model = mat4();
  private mvp = mat4();
  private tmp = mat4();
  private culling = frustum();

  private particles: Particle[] = [];
  private particleData = new Float32Array(0);

  private tagPool: HTMLElement[] = [];
  private dpr = 1;

  /** Counted for the debug line: how much of the world actually got drawn. */
  drawnChunks = 0;
  totalChunks = 0;

  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'stage';
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'view';
    this.el.appendChild(this.canvas);
    this.tags = document.createElement('div');
    this.tags.className = 'tags';
    this.el.appendChild(this.tags);

    const gl = this.canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: true,
      powerPreference: 'high-performance',
      // Chunks are rebuilt straight after a dig; without this the browser is free to
      // throw the buffer away between frames and the world flickers on some drivers.
      preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error('world: this browser has no WebGL2');
    this.gl = gl;

    this.chunkProg = compile(gl, CHUNK_VS, CHUNK_FS, 'chunk');
    this.chunkU = uniforms(gl, this.chunkProg);
    this.skyProg = compile(gl, SKY_VS, SKY_FS, 'sky');
    this.skyU = uniforms(gl, this.skyProg);
    this.entityProg = compile(gl, ENTITY_VS, ENTITY_FS, 'entity');
    this.entityU = uniforms(gl, this.entityProg);
    this.lineProg = compile(gl, LINE_VS, LINE_FS, 'line');
    this.lineU = uniforms(gl, this.lineProg);
    this.particleProg = compile(gl, PARTICLE_VS, PARTICLE_FS, 'particle');
    this.particleU = uniforms(gl, this.particleProg);

    this.atlasData = buildAtlas();
    this.atlasTex = this.uploadAtlas(this.atlasData);
    this.measureColors();

    this.quadIbo = this.buildQuadIndices();
    this.cubeVao = this.buildCube();
    const lineVao = gl.createVertexArray();
    const lineVbo = gl.createBuffer();
    if (!lineVao || !lineVbo) throw new Error('world: out of GL objects');
    this.lineVao = lineVao;
    // The buffer itself is never referred to again — it lives inside the VAO, which
    // is the whole point of a VAO.
    gl.bindVertexArray(lineVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, lineVbo);
    gl.bufferData(gl.ARRAY_BUFFER, BOX_LINES, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 12, 0);
    gl.bindVertexArray(null);

    const empty = gl.createVertexArray();
    if (!empty) throw new Error('world: out of GL objects');
    this.emptyVao = empty;

    const pVao = gl.createVertexArray();
    const pVbo = gl.createBuffer();
    if (!pVao || !pVbo) throw new Error('world: out of GL objects');
    this.particleVao = pVao;
    this.particleVbo = pVbo;
    gl.bindVertexArray(pVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, pVbo);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 28, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 28, 12);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 28, 24);
    gl.bindVertexArray(null);

    for (let i = 0; i < CHUNK_COUNT; i++) {
      this.chunks.push({
        opaqueVao: null,
        opaqueVbo: null,
        opaqueQuads: 0,
        waterVao: null,
        waterVbo: null,
        waterQuads: 0,
        built: false,
      });
      this.pending.add(i);
    }
    this.totalChunks = CHUNK_COUNT;

    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.frontFace(gl.CCW);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    this.resize();
  }

  // -------------------------------------------------------------------------
  // Setup

  private uploadAtlas(data: Uint8Array): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture();
    if (!tex) throw new Error('world: no texture');
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
    gl.texImage3D(
      gl.TEXTURE_2D_ARRAY, 0, gl.RGBA8, TEX_SIZE, TEX_SIZE, TEX_LAYERS, 0, gl.RGBA, gl.UNSIGNED_BYTE, data,
    );
    gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
    // NEAREST magnification is the whole look — a block up close is sixteen fat
    // pixels, not a blur. Mipmapped minification is not optional though: without it
    // a field of grass a hundred blocks away is a sheet of crawling static.
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const aniso = gl.getExtension('EXT_texture_filter_anisotropic');
    if (aniso) {
      const max = gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT) as number;
      // Ground seen at a glancing angle is the one place mipmapping alone looks bad,
      // and a floor is most of what you are looking at.
      gl.texParameterf(gl.TEXTURE_2D_ARRAY, aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, max));
    }
    return tex;
  }

  /** Average each block's side texture once, so the break spray is the right colour. */
  private measureColors(): void {
    const stride = TEX_SIZE * TEX_SIZE * 4;
    for (const def of BLOCKS) {
      const layer = def.tex[2];
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let i = 0; i < stride; i += 4) {
        const o = layer * stride + i;
        if (this.atlasData[o + 3] < 128) continue;
        r += this.atlasData[o];
        g += this.atlasData[o + 1];
        b += this.atlasData[o + 2];
        n += 1;
      }
      this.blockColor[def.id] = n === 0 ? [200, 200, 200] : [r / n, g / n, b / n];
    }
  }

  /**
   * One index buffer, shared by every chunk in the world.
   *
   * Every quad is four vertices and every quad is split the same way, so the indices
   * are the same numbers for all of them: 0,1,2, 0,2,3, then 4,5,6, 4,6,7, forever.
   * Building it once and binding it everywhere saves a buffer per chunk and a
   * megabyte of duplicated integers — and the mesher takes care of the one thing
   * that varies, which diagonal a quad is cut along, by rotating the vertices instead.
   */
  private buildQuadIndices(): WebGLBuffer {
    const gl = this.gl;
    const data = new Uint32Array(MAX_QUADS * 6);
    for (let q = 0; q < MAX_QUADS; q++) {
      const v = q * 4;
      const o = q * 6;
      data[o] = v;
      data[o + 1] = v + 1;
      data[o + 2] = v + 2;
      data[o + 3] = v;
      data[o + 4] = v + 2;
      data[o + 5] = v + 3;
    }
    const buf = gl.createBuffer();
    if (!buf) throw new Error('world: no index buffer');
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, data, gl.STATIC_DRAW);
    return buf;
  }

  /** A unit cube spanning -0.5..0.5, used for everybody and everything. */
  private buildCube(): WebGLVertexArrayObject {
    const gl = this.gl;
    const verts: number[] = [];
    const idx: number[] = [];
    const faces: [number[], number[], number[], number][] = [
      [[1, 0, 0], [0, 0, -1], [0, 1, 0], 2],
      [[-1, 0, 0], [0, 0, 1], [0, 1, 0], 2],
      [[0, 1, 0], [1, 0, 0], [0, 0, -1], 0],
      [[0, -1, 0], [1, 0, 0], [0, 0, 1], 1],
      [[0, 0, 1], [1, 0, 0], [0, 1, 0], 2],
      [[0, 0, -1], [-1, 0, 0], [0, 1, 0], 2],
    ];
    const corners: [number, number][] = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ];
    for (const [n, u, v, kind] of faces) {
      const base = verts.length / 9;
      for (let c = 0; c < 4; c++) {
        const [du, dv] = corners[c];
        verts.push(
          n[0] * 0.5 + u[0] * du * 0.5 + v[0] * dv * 0.5,
          n[1] * 0.5 + u[1] * du * 0.5 + v[1] * dv * 0.5,
          n[2] * 0.5 + u[2] * du * 0.5 + v[2] * dv * 0.5,
          n[0], n[1], n[2],
          c === 1 || c === 2 ? 1 : 0,
          c === 0 || c === 1 ? 1 : 0,
          kind,
        );
      }
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    const vao = gl.createVertexArray();
    const vbo = gl.createBuffer();
    const ibo = gl.createBuffer();
    if (!vao || !vbo || !ibo) throw new Error('world: out of GL objects');
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(idx), gl.STATIC_DRAW);
    const stride = 9 * 4;
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride, 12);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 2, gl.FLOAT, false, stride, 24);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 1, gl.FLOAT, false, stride, 32);
    gl.bindVertexArray(null);
    return vao;
  }

  resize(): void {
    const gl = this.gl;
    const rect = this.el.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    // Capped at two: past that it is four times the pixels for a difference nobody
    // can see on a screen held at arm's length, and this is a fill-rate-bound game.
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  }

  // -------------------------------------------------------------------------
  // Keeping the meshes up to date

  /** How many chunks are still waiting to be built. */
  get remaining(): number {
    return this.pending.size;
  }

  /** Pick up anything the world says has changed since last time. */
  collectDirty(): void {
    for (const ci of takeDirtyChunks()) this.pending.add(ci);
  }

  /**
   * Rebuild chunks until the budget runs out, nearest to `near` first.
   *
   * A budget rather than a fixed count, because a chunk of open sky costs nothing
   * and a chunk of cave costs a millisecond, and "four per frame" is either a stutter
   * or a crawl depending on which four. Nearest-first matters when the whole world is
   * being built at once: it means the ground under your feet exists before the
   * mountain on the horizon does.
   */
  buildSome(budgetMs: number, nx: number, ny: number, nz: number): void {
    if (this.pending.size === 0) return;
    const start = performance.now();
    const order = [...this.pending];
    if (order.length > 1) {
      order.sort((a, b) => this.chunkDistance(a, nx, ny, nz) - this.chunkDistance(b, nx, ny, nz));
    }
    for (const ci of order) {
      this.pending.delete(ci);
      this.rebuild(ci);
      if (performance.now() - start > budgetMs) break;
    }
  }

  private chunkDistance(ci: number, x: number, y: number, z: number): number {
    const { cx, cy, cz } = chunkCoords(ci);
    return (
      (cx * CHUNK + 8 - x) ** 2 + ((cy * CHUNK + 8 - y) * 2) ** 2 + (cz * CHUNK + 8 - z) ** 2
    );
  }

  private rebuild(ci: number): void {
    const { cx, cy, cz } = chunkCoords(ci);
    const mesh = buildChunk(cx, cy, cz);
    const slot = this.chunks[ci];
    slot.built = true;
    slot.opaqueQuads = mesh.opaqueQuads;
    slot.waterQuads = mesh.waterQuads;
    this.upload(slot, 'opaque', mesh.opaque);
    this.upload(slot, 'water', mesh.water);
  }

  private upload(slot: ChunkGL, kind: 'opaque' | 'water', data: ArrayBuffer | null): void {
    const gl = this.gl;
    const vaoKey = kind === 'opaque' ? 'opaqueVao' : 'waterVao';
    const vboKey = kind === 'opaque' ? 'opaqueVbo' : 'waterVbo';
    if (!data) {
      // Keep the GL objects around: a chunk that is empty now is a chunk somebody is
      // about to build a house in, and churning buffers is how you get a stutter
      // every time anybody places a block.
      return;
    }
    let vao = slot[vaoKey];
    let vbo = slot[vboKey];
    if (!vao || !vbo) {
      vao = gl.createVertexArray();
      vbo = gl.createBuffer();
      if (!vao || !vbo) throw new Error('world: out of GL objects');
      slot[vaoKey] = vao;
      slot[vboKey] = vbo;
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, VERTEX_BYTES, 0);
      gl.enableVertexAttribArray(1);
      // vertexAttribIPointer, not vertexAttribPointer: the packed word is an integer
      // and must arrive as one. The float version silently converts it, and every
      // bitfield in the shader comes out as garbage.
      gl.vertexAttribIPointer(1, 1, gl.UNSIGNED_INT, VERTEX_BYTES, 12);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.quadIbo);
      gl.bindVertexArray(null);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
  }

  // -------------------------------------------------------------------------
  // Breaking spray

  /** Throw a handful of the block's own colour into the air where it was. */
  burst(x: number, y: number, z: number, block: number): void {
    const [r, g, b] = this.blockColor[block] ?? [200, 200, 200];
    for (let i = 0; i < 26; i++) {
      const j = () => (Math.random() * 2 - 1) * 26;
      this.particles.push({
        x: x + Math.random(),
        y: y + Math.random(),
        z: z + Math.random(),
        vx: (Math.random() * 2 - 1) * 2.6,
        vy: Math.random() * 3.6 + 0.6,
        vz: (Math.random() * 2 - 1) * 2.6,
        life: 0.55 + Math.random() * 0.55,
        r: Math.max(0, Math.min(255, r + j())) / 255,
        g: Math.max(0, Math.min(255, g + j())) / 255,
        b: Math.max(0, Math.min(255, b + j())) / 255,
        size: 2.4 + Math.random() * 2.6,
      });
    }
    // A hard cap, so leaning on the mouse in a forest cannot turn into ten thousand
    // points and a dropped frame.
    if (this.particles.length > 700) this.particles.splice(0, this.particles.length - 700);
  }

  private stepParticles(dt: number): void {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life -= dt;
      if (p.life <= 0) {
        this.particles.splice(i, 1);
        continue;
      }
      p.vy -= 18 * dt;
      const ny = p.y + p.vy * dt;
      // They land on things rather than falling through the floor, which is most of
      // what makes them read as bits of the block rather than as a sprite effect.
      if (blockDef(getBlock(Math.floor(p.x), Math.floor(ny), Math.floor(p.z))).solid) {
        p.vy = 0;
        p.vx *= 0.6;
        p.vz *= 0.6;
      } else {
        p.y = ny;
      }
      const nx = p.x + p.vx * dt;
      if (!blockDef(getBlock(Math.floor(nx), Math.floor(p.y), Math.floor(p.z))).solid) p.x = nx;
      else p.vx = 0;
      const nz = p.z + p.vz * dt;
      if (!blockDef(getBlock(Math.floor(p.x), Math.floor(p.y), Math.floor(nz))).solid) p.z = nz;
      else p.vz = 0;
    }
  }

  // -------------------------------------------------------------------------
  // Drawing

  draw(v: View, dt: number): void {
    const gl = this.gl;
    this.stepParticles(dt);

    const aspect = this.canvas.width / Math.max(1, this.canvas.height);
    perspective(this.proj, FOV, aspect, NEAR, FAR);
    const ex = v.x;
    const ey = v.y;
    const ez = v.z;
    const cp = Math.cos(v.pitch);
    const dx = Math.cos(v.yaw) * cp;
    const dy = Math.sin(v.pitch);
    const dz = Math.sin(v.yaw) * cp;
    lookAlong(this.view, ex, ey, ez, dx, dy, dz);
    multiply(this.viewProj, this.proj, this.view);
    invert(this.invViewProj, this.viewProj);
    extractFrustum(this.culling, this.viewProj);

    const sky = skyColors(v.day, v.underwater);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.depthMask(true);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    this.drawSky(v, sky, ex, ey, ez);
    this.drawChunks(v, sky, ex, ey, ez, false);
    this.drawPlayers(v, sky);
    if (v.target) this.drawTarget(v);
    this.drawParticles();
    this.drawChunks(v, sky, ex, ey, ez, true);
    this.drawHand(v, sky, aspect);
    this.placeTags(v);
  }

  private drawSky(v: View, sky: SkyColors, ex: number, ey: number, ez: number): void {
    const gl = this.gl;
    gl.useProgram(this.skyProg);
    gl.bindVertexArray(this.emptyVao);
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.uniformMatrix4fv(this.skyU.uInvViewProj, false, this.invViewProj);
    gl.uniform3f(this.skyU.uCam, ex, ey, ez);
    gl.uniform3f(this.skyU.uSunDir, sky.sunX, sky.sunY, sky.sunZ);
    gl.uniform3fv(this.skyU.uZenith, sky.zenith);
    gl.uniform3fv(this.skyU.uHorizon, sky.horizon);
    gl.uniform1f(this.skyU.uNight, sky.night);
    gl.uniform1f(this.skyU.uSkyFeatures, v.underwater ? 0 : 1);
    gl.uniform1f(this.skyU.uTime, v.time);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
  }

  private drawChunks(v: View, sky: SkyColors, ex: number, ey: number, ez: number, water: boolean): void {
    const gl = this.gl;
    gl.useProgram(this.chunkProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.atlasTex);
    gl.uniform1i(this.chunkU.uTex, 0);
    gl.uniformMatrix4fv(this.chunkU.uViewProj, false, this.viewProj);
    gl.uniform3fv(this.chunkU.uSunColor, sky.sun);
    gl.uniform1f(this.chunkU.uSkyBright, sky.bright);
    gl.uniform3fv(this.chunkU.uFog, sky.fog);
    gl.uniform1f(this.chunkU.uFogNear, sky.fogNear);
    gl.uniform1f(this.chunkU.uFogFar, sky.fogFar);
    gl.uniform3f(this.chunkU.uCam, ex, ey, ez);
    gl.uniform1f(this.chunkU.uTime, v.time);
    gl.uniform1f(this.chunkU.uAlpha, water ? 0.72 : 1);
    gl.uniform1f(this.chunkU.uWavy, water ? 1 : 0);

    if (water) {
      gl.enable(gl.BLEND);
      // Water does not write depth. Two surfaces of it seen through each other is a
      // small lie; a lake that hides the fish under it is a bigger one.
      gl.depthMask(false);
      // And it is drawn from both sides, so swimming under the surface still shows one.
      gl.disable(gl.CULL_FACE);
    }

    if (!water) this.drawnChunks = 0;
    for (let ci = 0; ci < CHUNK_COUNT; ci++) {
      const slot = this.chunks[ci];
      const quads = water ? slot.waterQuads : slot.opaqueQuads;
      if (quads === 0) continue;
      const vao = water ? slot.waterVao : slot.opaqueVao;
      if (!vao) continue;
      const { cx, cy, cz } = chunkCoords(ci);
      const x0 = cx * CHUNK;
      const y0 = cy * CHUNK;
      const z0 = cz * CHUNK;
      if (!boxVisible(this.culling, x0, y0, z0, x0 + CHUNK, y0 + CHUNK, z0 + CHUNK)) continue;
      gl.uniform3f(this.chunkU.uChunk, x0, y0, z0);
      gl.bindVertexArray(vao);
      gl.drawElements(gl.TRIANGLES, quads * 6, gl.UNSIGNED_INT, 0);
      if (!water) this.drawnChunks += 1;
    }

    if (water) {
      gl.disable(gl.BLEND);
      gl.depthMask(true);
      gl.enable(gl.CULL_FACE);
    }
    gl.bindVertexArray(null);
  }

  // -------------------------------------------------------------------------
  // People
  //
  // Six boxes each: head, body, two arms, two legs. Which is exactly as much person
  // as this needs — at any distance you can read where somebody is, which way they
  // are looking, and whether they are walking, and those are the only three facts
  // about another player that matter in a game about digging.

  private drawPlayers(v: View, sky: SkyColors): void {
    const gl = this.gl;
    gl.useProgram(this.entityProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.atlasTex);
    gl.uniform1i(this.entityU.uTex, 0);
    gl.uniform1f(this.entityU.uUseTex, 0);
    gl.uniform3fv(this.entityU.uFog, sky.fog);
    gl.uniform1f(this.entityU.uFogNear, sky.fogNear);
    gl.uniform1f(this.entityU.uFogFar, sky.fogFar);
    gl.uniform1f(this.entityU.uFogged, 1);
    gl.uniform3f(this.entityU.uCam, v.x, v.y, v.z);
    gl.bindVertexArray(this.cubeVao);

    for (const p of v.players) {
      if (p.id === v.meId) continue;
      const lightHere = this.lightAt(p.x, p.y + 1, p.z, sky);
      gl.uniform1f(this.entityU.uLight, lightHere);
      const skin = hsl(p.hue, 0.42, 0.72);
      const shirt = hsl(p.hue, 0.62, 0.5);
      // Sleeves a shade off the shirt on purpose. Arms the same colour as the body
      // merge with it at any distance, and a person with no arms reads as a post.
      const sleeve = hsl(p.hue, 0.62, 0.38);
      const trousers = hsl((p.hue + 210) % 360, 0.34, 0.34);
      // Legs and arms swing in opposite pairs, from a phase driven by where they are
      // rather than by a clock, so everybody's walk is in step with their own feet
      // even though position is the only thing on the wire.
      const phase = (p.x + p.z) * 1.9;
      const swing = p.moving ? Math.sin(phase) * (p.sprinting ? 0.95 : 0.62) : 0;

      //        pivot  out    deep  tall  wide  colour    turn      up      forward
      this.part(p, 1.3, 0, 0.5, 0.52, 0.5, skin, p.pitch, +0.26); // head, off the neck
      this.part(p, 1.3, 0, 0.28, 0.6, 0.5, shirt, 0, -0.3); // body
      this.part(p, 1.28, 0.33, 0.24, 0.58, 0.16, sleeve, -swing, -0.29); // left arm
      this.part(p, 1.28, -0.33, 0.24, 0.58, 0.16, sleeve, swing, -0.29); // right arm
      this.part(p, 0.7, 0.13, 0.24, 0.7, 0.18, trousers, swing, -0.35); // left leg
      this.part(p, 0.7, -0.13, 0.24, 0.7, 0.18, trousers, -swing, -0.35); // right leg
      /*
       * Two eyes, stuck on the front of the head and pivoting with it.
       *
       * A featureless cube for a head means you cannot tell which way somebody is
       * facing until they walk, and in a game where people build things together
       * "which way is she looking" is a question that gets asked constantly. Two dark
       * squares answer it from thirty blocks away and cost two draw calls.
       */
      for (const side of [0.12, -0.12]) {
        this.part(p, 1.3, side, 0.04, 0.1, 0.12, EYE, p.pitch, +0.3, 0.26);
      }
    }
    gl.bindVertexArray(null);
  }

  /**
   * One box of a person.
   *
   * `pivotY` is the height above the feet that this box HANGS FROM and `centre` is
   * how far along the box's own up-axis its middle sits from there — so an arm is
   * "the shoulder, with the middle of it thirty centimetres below" and a head is
   * "the neck, with the middle of it above". Rotating about the pivot rather than
   * about the box's middle is the difference between an arm swinging from a shoulder
   * and an arm spinning around its own elbow.
   *
   * The axes are the PLAYER'S, not the world's: after the yaw, local X is the way
   * they are facing, so `deep` is front-to-back and `wide` is shoulder-to-shoulder.
   * Getting those two the wrong way round makes everybody walk sideways, which is
   * both hard to see and impossible to unsee.
   */
  private part(
    p: Player,
    pivotY: number,
    sideways: number,
    deep: number,
    tall: number,
    wide: number,
    color: [number, number, number],
    turn: number,
    centre: number,
    forward = 0,
  ): void {
    const gl = this.gl;
    const m = this.model;
    fromTranslation(m, p.x, p.y, p.z);
    rotateY(m, m, -p.yaw);
    m[12] += m[4] * pivotY + m[8] * sideways;
    m[13] += m[5] * pivotY + m[9] * sideways;
    m[14] += m[6] * pivotY + m[10] * sideways;
    if (turn !== 0) rotateZ(m, m, turn);
    // Along the box's own up and forward, AFTER the turn, so a thing stuck to the
    // front of the head goes round with the head instead of staying where the face
    // used to be.
    m[12] += m[4] * centre + m[0] * forward;
    m[13] += m[5] * centre + m[1] * forward;
    m[14] += m[6] * centre + m[2] * forward;
    scale(m, m, deep, tall, wide);
    multiply(this.mvp, this.viewProj, m);
    gl.uniformMatrix4fv(this.entityU.uMVP, false, this.mvp);
    gl.uniformMatrix4fv(this.entityU.uModel, false, m);
    gl.uniform4f(this.entityU.uColor, color[0], color[1], color[2], 1);
    gl.drawElements(gl.TRIANGLES, 36, gl.UNSIGNED_SHORT, 0);
  }

  /** How bright it is where something is standing, for lighting a person or a hand. */
  private lightAt(x: number, y: number, z: number, sky: SkyColors): number {
    const bx = Math.floor(x);
    const by = Math.floor(y);
    const bz = Math.floor(z);
    // Read through the world's own accessors rather than the raw array: this is once
    // per player per frame, not once per vertex.
    const s = skyLight(bx, by, bz) / 15;
    const b = blockLight(bx, by, bz) / 15;
    return Math.max(0.06, Math.max(s * sky.bright, b) * 0.9 + 0.12);
  }

  // -------------------------------------------------------------------------
  // What you are pointing at

  private drawTarget(v: View): void {
    const gl = this.gl;
    const t = v.target;
    if (!t) return;

    // The cracks first, under the outline, so the outline stays crisp over them.
    if (v.breaking > 0.001) {
      const stage = Math.min(CRACK_STAGES - 1, Math.floor(v.breaking * CRACK_STAGES));
      gl.useProgram(this.entityProg);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.atlasTex);
      gl.uniform1i(this.entityU.uTex, 0);
      gl.uniform1f(this.entityU.uUseTex, 1);
      gl.uniform1f(this.entityU.uFogged, 0);
      gl.uniform1f(this.entityU.uLight, 1);
      const layer = TEX.crack + stage;
      gl.uniform3f(this.entityU.uLayers, layer, layer, layer);
      gl.uniform4f(this.entityU.uColor, 1, 1, 1, 1);
      const m = this.model;
      fromTranslation(m, t.x + 0.5, t.y + 0.5, t.z + 0.5);
      // A whisker bigger than the block, so it sits on the surface instead of
      // fighting it for the same depth value and flickering.
      scale(m, m, 1.004, 1.004, 1.004);
      multiply(this.mvp, this.viewProj, m);
      gl.uniformMatrix4fv(this.entityU.uMVP, false, this.mvp);
      gl.uniformMatrix4fv(this.entityU.uModel, false, m);
      gl.enable(gl.BLEND);
      gl.bindVertexArray(this.cubeVao);
      gl.drawElements(gl.TRIANGLES, 36, gl.UNSIGNED_SHORT, 0);
      gl.disable(gl.BLEND);
      gl.bindVertexArray(null);
    }

    gl.useProgram(this.lineProg);
    const m = this.model;
    fromTranslation(m, t.x + 0.5, t.y + 0.5, t.z + 0.5);
    // Wider than the cracks, not narrower. The crack overlay writes depth, so an
    // outline drawn inside it loses the depth test along exactly the edges it is
    // supposed to be drawing — and the box vanishes the moment you start digging,
    // which is the moment you most want to know what you are pointed at.
    scale(m, m, 1.012, 1.012, 1.012);
    multiply(this.mvp, this.viewProj, m);
    gl.uniformMatrix4fv(this.lineU.uMVP, false, this.mvp);
    gl.uniform4f(this.lineU.uColor, 0.03, 0.04, 0.06, 0.85);
    gl.enable(gl.BLEND);
    gl.bindVertexArray(this.lineVao);
    gl.drawArrays(gl.LINES, 0, 24);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
  }

  private drawParticles(): void {
    if (this.particles.length === 0) return;
    const gl = this.gl;
    if (this.particleData.length < this.particles.length * 7) {
      this.particleData = new Float32Array(this.particles.length * 7 * 2);
    }
    const d = this.particleData;
    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      const o = i * 7;
      d[o] = p.x;
      d[o + 1] = p.y;
      d[o + 2] = p.z;
      d[o + 3] = p.r;
      d[o + 4] = p.g;
      d[o + 5] = p.b;
      // Shrink as they die, so they wink out instead of vanishing mid-air.
      d[o + 6] = p.size * Math.min(1, p.life * 3);
    }
    gl.useProgram(this.particleProg);
    gl.bindVertexArray(this.particleVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.particleVbo);
    gl.bufferData(gl.ARRAY_BUFFER, d.subarray(0, this.particles.length * 7), gl.STREAM_DRAW);
    gl.uniformMatrix4fv(this.particleU.uViewProj, false, this.viewProj);
    gl.uniform1f(this.particleU.uScale, this.dpr * 26);
    gl.drawArrays(gl.POINTS, 0, this.particles.length);
    gl.bindVertexArray(null);
  }

  // -------------------------------------------------------------------------
  // The block in your hand
  //
  // Drawn into a cleared depth buffer with its own narrow projection, which is how
  // every first-person game has ever done it: the hand is not in the world and must
  // never intersect it. Walk up to a wall and the block in your hand stays in front
  // of your face rather than being swallowed by the bricks.

  private drawHand(v: View, sky: SkyColors, aspect: number): void {
    if (v.held === AIR) return;
    const gl = this.gl;
    const def = blockDef(v.held);
    gl.clear(gl.DEPTH_BUFFER_BIT);

    perspective(this.tmp, (58 * Math.PI) / 180, aspect, 0.02, 4);
    const m = this.model;
    // A bob tied to the walk cycle and a dip when you swing, both small. Big hand
    // movement is nausea; this is a couple of centimetres.
    const bobX = Math.sin(v.walking * 2) * 0.012;
    const bobY = Math.abs(Math.cos(v.walking)) * -0.018;
    const punch = Math.sin(Math.min(1, v.breaking * 8) * Math.PI) * 0.14;
    fromTranslation(m, 0.46 + bobX, -0.44 + bobY - punch * 0.4, -0.72 - punch * 0.2);
    rotateY(m, m, -0.62);
    rotateX(m, m, 0.18 + punch);
    rotateZ(m, m, 0.1);
    scale(m, m, 0.34, 0.34, 0.34);
    multiply(this.mvp, this.tmp, m);

    gl.useProgram(this.entityProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.atlasTex);
    gl.uniform1i(this.entityU.uTex, 0);
    gl.uniform1f(this.entityU.uUseTex, 1);
    gl.uniform1f(this.entityU.uFogged, 0);
    gl.uniform3f(this.entityU.uLayers, def.tex[0], def.tex[1], def.tex[2]);
    gl.uniform4f(this.entityU.uColor, 1, 1, 1, 1);
    gl.uniform1f(this.entityU.uLight, this.lightAt(v.x, v.y + EYE_H, v.z, sky));
    gl.uniformMatrix4fv(this.entityU.uMVP, false, this.mvp);
    gl.uniformMatrix4fv(this.entityU.uModel, false, m);
    gl.enable(gl.BLEND);
    gl.bindVertexArray(this.cubeVao);
    gl.drawElements(gl.TRIANGLES, 36, gl.UNSIGNED_SHORT, 0);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
  }

  // -------------------------------------------------------------------------
  // Name tags
  //
  // DOM elements over the canvas rather than text drawn into it. Canvas text at this
  // scale has to be either blurry or enormous, and a name is the one thing on screen
  // that has to be readable at a glance.

  private placeTags(v: View): void {
    let used = 0;
    // Measured once, not once per player: `getBoundingClientRect` forces the browser
    // to settle the layout, and doing that inside a loop inside the frame is how a
    // crowd of six people costs six layout passes a frame.
    const width = this.canvas.width / this.dpr;
    const height = this.canvas.height / this.dpr;
    for (const p of v.players) {
      if (p.id === v.meId) continue;
      const at = project(this.viewProj, p.x, p.y + PLAYER_H + 0.42, p.z);
      // Behind the camera comes out at a perfectly plausible screen position with a
      // negative w, which is how everybody's name ends up stuck in one corner.
      if (at.w <= 0 || at.x < -1.4 || at.x > 1.4 || at.y < -1.4 || at.y > 1.4) continue;
      const dist = Math.hypot(p.x - v.x, p.y - v.y, p.z - v.z);
      if (dist > 90) continue;
      const el = this.tagFor(used++);
      el.style.transform = `translate(-50%, -100%) translate(${((at.x + 1) / 2) * width}px, ${((1 - at.y) / 2) * height}px)`;
      el.style.opacity = String(Math.max(0.25, 1 - dist / 90));
      if (el.textContent !== p.name) el.textContent = p.name;
      el.hidden = false;
    }
    for (let i = used; i < this.tagPool.length; i++) this.tagPool[i].hidden = true;
  }

  private tagFor(i: number): HTMLElement {
    while (this.tagPool.length <= i) {
      const el = document.createElement('div');
      el.className = 'tag';
      this.tags.appendChild(el);
      this.tagPool.push(el);
    }
    return this.tagPool[i];
  }

  /** Where a world point lands on the page, for anything the DOM needs to point at. */
  screenOf(x: number, y: number, z: number): { x: number; y: number; visible: boolean } {
    const at = project(this.viewProj, x, y, z);
    return {
      x: ((at.x + 1) / 2) * (this.canvas.width / this.dpr),
      y: ((1 - at.y) / 2) * (this.canvas.height / this.dpr),
      visible: at.w > 0,
    };
  }
}

// ---------------------------------------------------------------------------
// Time of day
//
// One number, 0..1, decides the colour of everything. It comes from the server so
// that two people standing next to each other are in the same evening.

interface SkyColors {
  zenith: Float32Array;
  horizon: Float32Array;
  fog: Float32Array;
  sun: Float32Array;
  bright: number;
  night: number;
  sunX: number;
  sunY: number;
  sunZ: number;
  fogNear: number;
  fogFar: number;
}

const scratch = {
  zenith: new Float32Array(3),
  horizon: new Float32Array(3),
  fog: new Float32Array(3),
  sun: new Float32Array(3),
};

function skyColors(day: number, underwater: boolean): SkyColors {
  // The sun rises in the east at 0.25 and sets in the west at 0.75, going over the
  // top rather than round the side — which is only worth saying because getting the
  // sign wrong puts it underground at noon.
  const angle = (day - 0.25) * Math.PI * 2;
  const sunY = Math.sin(angle);
  const sunX = Math.cos(angle) * 0.86;
  const sunZ = Math.cos(angle) * 0.5;
  const len = Math.hypot(sunX, sunY, sunZ) || 1;

  /*
   * How bright the sun is, as a smooth curve through dawn rather than a step.
   *
   * The floor is not zero. A pitch-black night in a game with no light sources you
   * start with is a game you quit; a fifth of daylight is dark enough to want a lamp
   * and light enough to walk home by.
   */
  const dayness = clamp01((sunY + 0.14) / 0.42);
  const bright = 0.2 + 0.8 * dayness;
  /*
   * How much of the night sky is out.
   *
   * Measured from well BELOW the horizon rather than from it, because the sun is
   * still up when it is touching the horizon — and the first version, which started
   * the stars as soon as the sun dipped, produced a sky four-fifths full of stars
   * with the sun visibly still setting into the sea underneath them.
   */
  const night = 1 - clamp01((sunY + 0.17) / 0.24);
  // Dusk: the sun reddens as it gets close to the horizon, in both directions.
  const low = clamp01(1 - Math.abs(sunY) / 0.32) * clamp01((sunY + 0.2) / 0.2);

  const zenith = mixColor(scratch.zenith, [0.05, 0.06, 0.14], [0.28, 0.5, 0.86], dayness);
  const horizon = mixColor(scratch.horizon, [0.09, 0.1, 0.17], [0.65, 0.78, 0.94], dayness);
  // Warm the horizon at sunrise and sunset, which is most of what makes a day feel
  // like it is passing rather than like a brightness slider being dragged.
  horizon[0] = Math.min(1, horizon[0] + low * 0.55);
  horizon[1] = Math.min(1, horizon[1] + low * 0.16);
  horizon[2] = Math.max(0, horizon[2] - low * 0.16);

  const sun = mixColor(scratch.sun, [0.42, 0.48, 0.72], [1.0, 0.99, 0.95], dayness);
  sun[0] = Math.min(1.1, sun[0] + low * 0.2);
  sun[2] = Math.max(0, sun[2] - low * 0.22);

  const fog = scratch.fog;
  if (underwater) {
    // Under the surface the whole world is short-range and blue. It is the cheapest
    // possible "you are in the water" and it works instantly.
    fog[0] = 0.09;
    fog[1] = 0.24 * (0.4 + bright * 0.6);
    fog[2] = 0.42 * (0.4 + bright * 0.6);
    /*
     * And so is the sky. Water blocks only build the faces that touch something
     * else, so from inside a lake there is a clear line of sight out through the
     * side of it — and the sky, drawn behind everything and fogged by nothing, came
     * through it. A sunset with stars in it, seen from the bottom of the sea.
     * Painting the sky in the water's own colour is what MOST games do here and it
     * is right for the same reason: underwater, the sky is not a thing you can see.
     */
    zenith.set(fog);
    horizon.set(fog);
  } else {
    fog.set(horizon);
  }

  return {
    zenith,
    horizon,
    fog,
    sun,
    bright,
    night,
    sunX: sunX / len,
    sunY: sunY / len,
    sunZ: sunZ / len,
    fogNear: underwater ? 0.5 : FOG_NEAR,
    fogFar: underwater ? 22 : FOG_FAR,
  };
}

function mixColor(out: Float32Array, a: number[], b: number[], t: number): Float32Array {
  for (let i = 0; i < 3; i++) out[i] = a[i] + (b[i] - a[i]) * t;
  return out;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Eyes. Dark rather than black, so they read as a face and not as two holes. */
const EYE: [number, number, number] = [0.12, 0.11, 0.14];

/** A colour from a hue, so every player is a different and consistent one. */
function hsl(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const m = l - c / 2;
  const t: [number, number, number] =
    hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
  return [t[0] + m, t[1] + m, t[2] + m];
}

/** The twelve edges of a unit cube, as pairs of points. */
const BOX_LINES = (() => {
  const c: [number, number, number][] = [];
  for (let i = 0; i < 8; i++) {
    c.push([(i & 1 ? 0.5 : -0.5), (i & 2 ? 0.5 : -0.5), (i & 4 ? 0.5 : -0.5)]);
  }
  const edges: [number, number][] = [
    [0, 1], [2, 3], [4, 5], [6, 7],
    [0, 2], [1, 3], [4, 6], [5, 7],
    [0, 4], [1, 5], [2, 6], [3, 7],
  ];
  const out = new Float32Array(edges.length * 6);
  edges.forEach(([a, b], i) => {
    out.set(c[a], i * 6);
    out.set(c[b], i * 6 + 3);
  });
  return out;
})();
