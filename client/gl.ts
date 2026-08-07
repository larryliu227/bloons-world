/**
 * BLOONS WORLD — matrices, shaders and the frustum.
 *
 * Everything WebGL needs that is not about blocks. There is no maths library in the
 * dependencies and there is not going to be: a voxel renderer needs about nine matrix
 * operations, all of them are twenty lines, and none of them are ever going to change.
 * A third-party one would be six hundred kilobytes of node_modules to avoid writing
 * `perspective`.
 *
 * Matrices are COLUMN-MAJOR Float32Arrays of sixteen, which is what WebGL wants and
 * therefore what everything here produces: `m[col * 4 + row]`. Getting that backwards
 * is the classic three hours of a scene that renders as either nothing at all or as
 * everything transposed through the floor.
 */

export type Mat4 = Float32Array;

export function mat4(): Mat4 {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

export function identity(out: Mat4): Mat4 {
  out.fill(0);
  out[0] = out[5] = out[10] = out[15] = 1;
  return out;
}

/**
 * A right-handed perspective projection looking down -Z, with the clip range WebGL
 * expects. `fovy` is the VERTICAL field of view in radians, so the horizontal one
 * widens on a wide window instead of the picture squashing.
 */
export function perspective(out: Mat4, fovy: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovy / 2);
  out.fill(0);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = (far + near) / (near - far);
  out[11] = -1;
  out[14] = (2 * far * near) / (near - far);
  return out;
}

export function multiply(out: Mat4, a: Mat4, b: Mat4): Mat4 {
  // Written out rather than looped: this runs a few dozen times a frame and the
  // loop version spends most of its time on index arithmetic.
  const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
  const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
  const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
  const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
  for (let i = 0; i < 4; i++) {
    const b0 = b[i * 4], b1 = b[i * 4 + 1], b2 = b[i * 4 + 2], b3 = b[i * 4 + 3];
    out[i * 4] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
    out[i * 4 + 1] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
    out[i * 4 + 2] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
    out[i * 4 + 3] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
  }
  return out;
}

/** A view matrix for an eye at `e` looking along `d`. `d` need not be normalised. */
export function lookAlong(out: Mat4, ex: number, ey: number, ez: number, dx: number, dy: number, dz: number): Mat4 {
  const dl = Math.hypot(dx, dy, dz) || 1;
  const fx = dx / dl;
  const fy = dy / dl;
  const fz = dz / dl;
  /*
   * Right is world-up crossed with backward, which for an up of (0, 1, 0) collapses
   * to (-forwardZ, 0, forwardX) — a quarter turn of the forward direction, flattened.
   *
   * Looking exactly up or exactly down makes that vector zero and the view matrix
   * degenerate, which is the real reason the pitch limit stops just short of
   * vertical rather than at it. A camera that loses its right vector does not tip
   * over gracefully; it renders one frame of noise and then nothing.
   */
  const rx = -fz;
  const ry = 0;
  const rz = fx;
  const rl = Math.hypot(rx, ry, rz) || 1;
  const sx = rx / rl;
  const sy = ry / rl;
  const sz = rz / rl;
  // Up is right crossed with forward, which is already unit length.
  const ux = sy * fz - sz * fy;
  const uy = sz * fx - sx * fz;
  const uz = sx * fy - sy * fx;

  out[0] = sx; out[1] = ux; out[2] = -fx; out[3] = 0;
  out[4] = sy; out[5] = uy; out[6] = -fy; out[7] = 0;
  out[8] = sz; out[9] = uz; out[10] = -fz; out[11] = 0;
  out[12] = -(sx * ex + sy * ey + sz * ez);
  out[13] = -(ux * ex + uy * ey + uz * ez);
  out[14] = fx * ex + fy * ey + fz * ez;
  out[15] = 1;
  return out;
}

export function fromTranslation(out: Mat4, x: number, y: number, z: number): Mat4 {
  identity(out);
  out[12] = x;
  out[13] = y;
  out[14] = z;
  return out;
}

export function scale(out: Mat4, m: Mat4, x: number, y: number, z: number): Mat4 {
  for (let i = 0; i < 4; i++) {
    out[i] = m[i] * x;
    out[4 + i] = m[4 + i] * y;
    out[8 + i] = m[8 + i] * z;
    out[12 + i] = m[12 + i];
  }
  return out;
}

export function rotateY(out: Mat4, m: Mat4, rad: number): Mat4 {
  const s = Math.sin(rad);
  const c = Math.cos(rad);
  const a00 = m[0], a01 = m[1], a02 = m[2], a03 = m[3];
  const a20 = m[8], a21 = m[9], a22 = m[10], a23 = m[11];
  if (out !== m) {
    out[4] = m[4]; out[5] = m[5]; out[6] = m[6]; out[7] = m[7];
    out[12] = m[12]; out[13] = m[13]; out[14] = m[14]; out[15] = m[15];
  }
  out[0] = a00 * c - a20 * s;
  out[1] = a01 * c - a21 * s;
  out[2] = a02 * c - a22 * s;
  out[3] = a03 * c - a23 * s;
  out[8] = a00 * s + a20 * c;
  out[9] = a01 * s + a21 * c;
  out[10] = a02 * s + a22 * c;
  out[11] = a03 * s + a23 * c;
  return out;
}

export function rotateX(out: Mat4, m: Mat4, rad: number): Mat4 {
  const s = Math.sin(rad);
  const c = Math.cos(rad);
  const a10 = m[4], a11 = m[5], a12 = m[6], a13 = m[7];
  const a20 = m[8], a21 = m[9], a22 = m[10], a23 = m[11];
  if (out !== m) {
    out[0] = m[0]; out[1] = m[1]; out[2] = m[2]; out[3] = m[3];
    out[12] = m[12]; out[13] = m[13]; out[14] = m[14]; out[15] = m[15];
  }
  out[4] = a10 * c + a20 * s;
  out[5] = a11 * c + a21 * s;
  out[6] = a12 * c + a22 * s;
  out[7] = a13 * c + a23 * s;
  out[8] = a20 * c - a10 * s;
  out[9] = a21 * c - a11 * s;
  out[10] = a22 * c - a12 * s;
  out[11] = a23 * c - a13 * s;
  return out;
}

export function rotateZ(out: Mat4, m: Mat4, rad: number): Mat4 {
  const s = Math.sin(rad);
  const c = Math.cos(rad);
  const a00 = m[0], a01 = m[1], a02 = m[2], a03 = m[3];
  const a10 = m[4], a11 = m[5], a12 = m[6], a13 = m[7];
  if (out !== m) {
    out[8] = m[8]; out[9] = m[9]; out[10] = m[10]; out[11] = m[11];
    out[12] = m[12]; out[13] = m[13]; out[14] = m[14]; out[15] = m[15];
  }
  out[0] = a00 * c + a10 * s;
  out[1] = a01 * c + a11 * s;
  out[2] = a02 * c + a12 * s;
  out[3] = a03 * c + a13 * s;
  out[4] = a10 * c - a00 * s;
  out[5] = a11 * c - a01 * s;
  out[6] = a12 * c - a02 * s;
  out[7] = a13 * c - a03 * s;
  return out;
}

/** General inverse. Only used on the view-projection, once a frame, for the sky. */
export function invert(out: Mat4, a: Mat4): Mat4 | null {
  const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
  const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
  const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
  const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];

  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;

  const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) return null;
  const d = 1 / det;

  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * d;
  out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * d;
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * d;
  out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * d;
  out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * d;
  out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * d;
  out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * d;
  out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * d;
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * d;
  out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * d;
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * d;
  out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * d;
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * d;
  out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * d;
  out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * d;
  out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * d;
  return out;
}

/**
 * Push a world point through a matrix and divide. Returns w as well, because a name
 * tag behind the camera comes out at a perfectly plausible screen position with a
 * negative w, and drawing it there puts everybody's name in the corner of the sky.
 */
export function project(m: Mat4, x: number, y: number, z: number): { x: number; y: number; w: number } {
  const cx = m[0] * x + m[4] * y + m[8] * z + m[12];
  const cy = m[1] * x + m[5] * y + m[9] * z + m[13];
  const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
  return { x: cx / cw, y: cy / cw, w: cw };
}

// ---------------------------------------------------------------------------
// Frustum culling
//
// Six planes pulled straight out of the view-projection matrix, which is the trick
// nobody believes until they try it: the rows of that matrix, added to and subtracted
// from the w row, ARE the clip planes in world space. Gribb and Hartmann, 2001.
//
// Worth it here because the world is 256 chunks and a 70-degree field of view can
// see maybe a fifth of them. Culling the rest is one dot product each and saves four
// fifths of the draw calls.

export type Frustum = Float32Array;

export function frustum(): Frustum {
  return new Float32Array(24);
}

export function extractFrustum(out: Frustum, m: Mat4): Frustum {
  const rows = [
    [m[0], m[4], m[8], m[12]],
    [m[1], m[5], m[9], m[13]],
    [m[2], m[6], m[10], m[14]],
    [m[3], m[7], m[11], m[15]],
  ];
  const planes = [
    [rows[3][0] + rows[0][0], rows[3][1] + rows[0][1], rows[3][2] + rows[0][2], rows[3][3] + rows[0][3]],
    [rows[3][0] - rows[0][0], rows[3][1] - rows[0][1], rows[3][2] - rows[0][2], rows[3][3] - rows[0][3]],
    [rows[3][0] + rows[1][0], rows[3][1] + rows[1][1], rows[3][2] + rows[1][2], rows[3][3] + rows[1][3]],
    [rows[3][0] - rows[1][0], rows[3][1] - rows[1][1], rows[3][2] - rows[1][2], rows[3][3] - rows[1][3]],
    [rows[3][0] + rows[2][0], rows[3][1] + rows[2][1], rows[3][2] + rows[2][2], rows[3][3] + rows[2][3]],
    [rows[3][0] - rows[2][0], rows[3][1] - rows[2][1], rows[3][2] - rows[2][2], rows[3][3] - rows[2][3]],
  ];
  for (let i = 0; i < 6; i++) {
    const [a, b, c, d] = planes[i];
    const len = Math.hypot(a, b, c) || 1;
    out[i * 4] = a / len;
    out[i * 4 + 1] = b / len;
    out[i * 4 + 2] = c / len;
    out[i * 4 + 3] = d / len;
  }
  return out;
}

/** Is any part of this box in front of all six planes? */
export function boxVisible(
  f: Frustum,
  x0: number, y0: number, z0: number,
  x1: number, y1: number, z1: number,
): boolean {
  for (let i = 0; i < 6; i++) {
    const a = f[i * 4];
    const b = f[i * 4 + 1];
    const c = f[i * 4 + 2];
    const d = f[i * 4 + 3];
    // The "positive vertex": the corner furthest along the plane's normal. If even
    // that one is behind the plane, every other corner is too.
    const px = a >= 0 ? x1 : x0;
    const py = b >= 0 ? y1 : y0;
    const pz = c >= 0 ? z1 : z0;
    if (a * px + b * py + c * pz + d < 0) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Shaders

export function compile(gl: WebGL2RenderingContext, vertexSrc: string, fragmentSrc: string, name: string): WebGLProgram {
  const program = gl.createProgram();
  if (!program) throw new Error('gl: could not create a program');
  const vs = shader(gl, gl.VERTEX_SHADER, vertexSrc, `${name} vertex`);
  const fs = shader(gl, gl.FRAGMENT_SHADER, fragmentSrc, `${name} fragment`);
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`gl: ${name} would not link — ${gl.getProgramInfoLog(program) ?? ''}`);
  }
  // The objects are reference-counted by the program; deleting them here just says
  // "nothing else will attach these", and stops two hundred shader objects piling up
  // on a page that hot-reloads.
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  return program;
}

function shader(gl: WebGL2RenderingContext, kind: number, src: string, name: string): WebGLShader {
  const s = gl.createShader(kind);
  if (!s) throw new Error('gl: could not create a shader');
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s) ?? '';
    // The line numbers in a driver's error message are useless without the source
    // they refer to, and this source is generated in a template literal.
    const numbered = src
      .split('\n')
      .map((line, i) => `${String(i + 1).padStart(3)} | ${line}`)
      .join('\n');
    throw new Error(`gl: ${name} would not compile — ${log}\n${numbered}`);
  }
  return s;
}

/** Every uniform a program has, looked up once, by name. */
export function uniforms(gl: WebGL2RenderingContext, program: WebGLProgram): Record<string, WebGLUniformLocation> {
  const out: Record<string, WebGLUniformLocation> = {};
  const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) as number;
  for (let i = 0; i < count; i++) {
    const info = gl.getActiveUniform(program, i);
    if (!info) continue;
    // An array uniform is reported as `name[0]`; ask for it under its plain name.
    const name = info.name.replace(/\[0\]$/, '');
    const loc = gl.getUniformLocation(program, info.name);
    if (loc) out[name] = loc;
  }
  return out;
}
