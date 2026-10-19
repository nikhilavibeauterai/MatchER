// ---------------------------------------------------------------- the sprite layer: every small print on the GPU
// The sea's small prints (the ones without an image element of their own) are instanced quads drawn from the atlas
// sheets: each sheet is uploaded once, each draw call covers every print on that sheet, and the camera is a uniform.
// Only visible quads are submitted, with a stable depth per print so texture batching cannot reorder a stack.
// A pan or a zoom costs one pass over the visible quads, every print is a
// real thumbnail at any size (a dot of paper is never needed). Slow waves change only uniforms. The fragment shader
// paints the same polaroid as drawCard in photo-sea.js: paper 3:4, the picture contained at the top of its window,
// corners rounded in proportion. photo-sea.js keeps its 2D canvas for browsers without WebGL2 (and for the `gpu` knob).
class SpriteLayer {
  static VERTEX = `#version 300 es
    precision highp float;
    layout(location=0) in vec2 q;      // unit quad corner
    layout(location=1) in vec3 pos;    // centre x, centre y (sea units), width
    layout(location=2) in vec4 cell;   // u0, v0, width, height of the picture on the sheet (texels); width 0 = no picture yet
    layout(location=3) in vec4 look;   // opacity, then the card's three wobble randoms
    layout(location=4) in float aspect;
    layout(location=5) in float depth;
    layout(location=6) in vec4 swell;   // shared stack spatial pairs for the two pocket axes
    layout(location=7) in vec3 ripple;  // drifting warp's spatial pair, then the stack width
    uniform vec2 view;                 // the sea's size (css px)
    uniform vec3 cam;                  // zoom, tx, ty
    uniform float time;                // ms
    uniform vec4 wob;                  // period ms, degrees, speed spread, force spread
    uniform float wobDelay;            // delay spread
    uniform vec2 waves;                // height in screen pixels, crest ripple strength
    uniform vec2 travel[3];            // travelling sine/cosine pairs, shared by every print
    out vec2 vq; out vec4 vcell; out float vopacity; out float vpx; out float vaspect;
    void main() {
      float w = pos.z, h = w * 4.0 / 3.0;
      vec2 corner = (q - 0.5) * vec2(w, h);
      float period = wob.x * (1.0 + (look.z * 2.0 - 1.0) * wob.z);
      float deg = wob.y * (1.0 + (look.w * 2.0 - 1.0) * wob.w);
      float angle = wob.y == 0.0 ? 0.0 : sin((time / period + look.y * wobDelay) * 6.2831853) * deg * 0.017453292;
      float c = cos(angle), s = sin(angle);
      vec2 r = vec2(corner.x * c - corner.y * s, corner.x * s + corner.y * c);
      vec2 lift = vec2(0.0);
      if (waves.x > 0.0) {
        float t = clamp((ripple.z * cam.x - 64.0) / 156.0, 0.0, 1.0);
        float amplitude = min(waves.x, max(4.0, ripple.z * 0.8)) / max(1.0, cam.x) * (1.0 - t * t * (3.0 - 2.0 * t));
        float a = swell.x * travel[0].y - swell.y * travel[0].x, ac = swell.y * travel[0].y + swell.x * travel[0].x;
        float b = swell.z * travel[1].y - swell.w * travel[1].x, bc = swell.w * travel[1].y + swell.z * travel[1].x;
        float c = ripple.x * travel[2].y - ripple.y * travel[2].x, cc = ripple.y * travel[2].y + ripple.x * travel[2].x;
        float wa = b * 0.5 + c * 0.35, wb = a * 0.45 - cc * 0.3;
        float ta = 1.0 / (1.0 + wa * wa), tb = 1.0 / (1.0 + wb * wb);
        float A = a * (1.0 - wa * wa) * ta + ac * 2.0 * wa * ta, Ac = ac * (1.0 - wa * wa) * ta - a * 2.0 * wa * ta;
        float B = b * (1.0 - wb * wb) * tb + bc * 2.0 * wb * tb, Bc = bc * (1.0 - wb * wb) * tb - b * 2.0 * wb * tb;
        float pocket = A * B + 0.28 * c, ridge = max(0.0, 1.0 - abs(pocket) * 1.4);
        float fine = A * (3.0 - 4.0 * A * A) * Bc * (4.0 * Bc * Bc - 3.0);
        float cross = Ac * (4.0 * Ac * Ac - 3.0) * B * (3.0 - 4.0 * B * B), gain = 0.2 + 0.8 * ridge * ridge;
        lift = vec2(0.68 * Ac * B + 0.22 * c + waves.y * 0.12 * gain * cross,
                    -0.68 * A * Bc + 0.22 * cc + waves.y * 0.12 * gain * fine) * amplitude / (1.0 + waves.y * 0.15);
      }
      vec2 screen = (pos.xy + lift + r) * cam.x + cam.yz;
      gl_Position = vec4(screen.x / view.x * 2.0 - 1.0, 1.0 - screen.y / view.y * 2.0, depth, 1.0);
      vq = q; vcell = cell; vopacity = look.x; vpx = w * cam.x; vaspect = aspect;
    }`;
  static FRAGMENT = `#version 300 es
    precision highp float;
    in vec2 vq; in vec4 vcell; in float vopacity; in float vpx; in float vaspect;
    uniform sampler2D sheet; uniform vec2 sheetSize;
    out vec4 color;
    void main() {
      // Card-local coordinates in widths: x across [0,1], y down [0,4/3]. The window sits 5.5% in from the sides
      // and the top with a 17% chin; the picture is contained at the top of it, centred, and the rest is paper.
      float x = vq.x, y = vq.y * 4.0 / 3.0;
      vec3 rgb = vec3(0.957, 0.937, 0.902);
      float wx0 = 0.055, ww = 0.89, wy0 = 0.055, wh = 4.0 / 3.0 - 0.225;
      if (vcell.z > 0.0) {
        float aspect = vaspect > 0.0 ? vaspect : vcell.z / vcell.w;
        float pw = min(ww, wh * aspect), ph = pw / aspect, px0 = wx0 + (ww - pw) * 0.5;
        if (x >= px0 && x < px0 + pw && y >= wy0 && y < wy0 + ph) {
          // Sample half a texel in from the cell's edges so a neighbour on the sheet never bleeds in.
          vec2 uv = vec2(vcell.x + 0.5 + (x - px0) / pw * (vcell.z - 1.0), vcell.y + 0.5 + (y - wy0) / ph * (vcell.w - 1.0)) / sheetSize;
          rgb = texture(sheet, uv).rgb;
        }
      } else if (x >= wx0 && x < wx0 + ww && y >= wy0 && y < wy0 + wh) rgb = vec3(0.788, 0.761, 0.706);  // blank: the sheet is still on its way
      // Rounded corners (1.5% of the width) and a one-pixel soft edge.
      float r = 0.015;
      vec2 d = abs(vec2(x, y) - vec2(0.5, 2.0 / 3.0)) - vec2(0.5 - r, 2.0 / 3.0 - r);
      float dist = length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - r;
      float a = vopacity * clamp(0.5 - dist * max(vpx, 1.0), 0.0, 1.0);
      if (a <= 0.0) discard;
      color = vec4(rgb * a, a);
    }`;
  static STRIDE = 20;  // x, y, w, cell[4], look[4], aspect, depth, three spatial pairs, stack width

  constructor(canvas) {
    const gl = canvas.getContext("webgl2", { alpha: true, antialias: false, depth: true, stencil: false, premultipliedAlpha: true, preserveDrawingBuffer: false, powerPreference: "high-performance" });
    if (!gl) throw new Error("WebGL2 unavailable");
    this.gl = gl; this.canvas = canvas; this.textures = new Map(); this.lost = false;
    canvas.addEventListener("webglcontextlost", (e) => { e.preventDefault(); this.lost = true; }, { passive: false });
    canvas.addEventListener("webglcontextrestored", () => { this.lost = false; this.textures.clear(); this.setup(); });
    this.setup();
  }
  setup() {
    const gl = this.gl, compile = (type, src) => {
      const sh = gl.createShader(type); gl.shaderSource(sh, src); gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) || "shader");
      return sh;
    };
    const program = gl.createProgram();
    gl.attachShader(program, compile(gl.VERTEX_SHADER, SpriteLayer.VERTEX)); gl.attachShader(program, compile(gl.FRAGMENT_SHADER, SpriteLayer.FRAGMENT));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || "program");
    this.program = program;
    this.u = {}; for (const name of ["view", "cam", "time", "wob", "wobDelay", "waves", "travel", "sheet", "sheetSize"]) this.u[name] = gl.getUniformLocation(program, name);
    this.vao = gl.createVertexArray(); gl.bindVertexArray(this.vao);
    const quad = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.instances = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, this.instances);
    const stride = SpriteLayer.STRIDE * 4;
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride, 0); gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 4, gl.FLOAT, false, stride, 12); gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 4, gl.FLOAT, false, stride, 28); gl.vertexAttribDivisor(3, 1);
    gl.enableVertexAttribArray(4); gl.vertexAttribPointer(4, 1, gl.FLOAT, false, stride, 44); gl.vertexAttribDivisor(4, 1);
    gl.enableVertexAttribArray(5); gl.vertexAttribPointer(5, 1, gl.FLOAT, false, stride, 48); gl.vertexAttribDivisor(5, 1);
    gl.enableVertexAttribArray(6); gl.vertexAttribPointer(6, 4, gl.FLOAT, false, stride, 52); gl.vertexAttribDivisor(6, 1);
    gl.enableVertexAttribArray(7); gl.vertexAttribPointer(7, 3, gl.FLOAT, false, stride, 68); gl.vertexAttribDivisor(7, 1);
    gl.bindVertexArray(null);
    this.blank = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, this.blank);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([201, 194, 180, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  }
  // One texture per sheet (an atlas image or a mutable preview page), uploaded again only when its version moves.
  texture(image, version) {
    const gl = this.gl;
    let t = this.textures.get(image);
    const width = image.naturalWidth || image.width, height = image.naturalHeight || image.height;
    if (t && t.version === version && t.width === width && t.height === height) return t;
    if (!t) {
      t = { tex: gl.createTexture(), version, width, height };
      this.textures.set(image, t);
      gl.bindTexture(gl.TEXTURE_2D, t.tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    } else { t.version = version; t.width = width; t.height = height; gl.bindTexture(gl.TEXTURE_2D, t.tex); }
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    gl.generateMipmap(gl.TEXTURE_2D);
    return t;
  }
  // Sheets the sea no longer uses give their texture memory back.
  prune(live) { for (const [image, t] of this.textures) if (!live.has(image)) { this.gl.deleteTexture(t.tex); this.textures.delete(image); } }
  // Draw every batch ({image, version, data, n, upload}): one upload per changed batch, one draw call per batch.
  draw({ W, H, dpr, zoom, tx, ty, time, wobble, waves = [0, 0], travel = [0,1,0,1,0,1] }, batches, liveImages = null) {
    const gl = this.gl, canvas = this.canvas;
    if (this.lost) return false;
    const cw = Math.max(1, Math.round(W * dpr)), ch = Math.max(1, Math.round(H * dpr));
    if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; canvas.style.width = `${W}px`; canvas.style.height = `${H}px`; }
    gl.viewport(0, 0, cw, ch);
    gl.clearColor(0, 0, 0, 0); gl.clearDepth(1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (!batches.length) { if(liveImages)this.prune(liveImages);return true; }
    gl.useProgram(this.program); gl.bindVertexArray(this.vao);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LESS);
    gl.uniform2f(this.u.view, W, H); gl.uniform3f(this.u.cam, zoom, tx, ty); gl.uniform1f(this.u.time, time);
    gl.uniform4f(this.u.wob, wobble[0], wobble[1], wobble[2], wobble[3]); gl.uniform1f(this.u.wobDelay, wobble[4]);
    gl.uniform2f(this.u.waves, waves[0], waves[1]);gl.uniform2fv(this.u.travel, travel);
    gl.uniform1i(this.u.sheet, 0); gl.activeTexture(gl.TEXTURE0);
    const live = new Set(liveImages||[]);
    for (const b of batches) {
      if (!b.n) continue;
      if (b.image) { live.add(b.image); const t = this.texture(b.image, b.version); gl.bindTexture(gl.TEXTURE_2D, t.tex); gl.uniform2f(this.u.sheetSize, t.width, t.height); }
      else { gl.bindTexture(gl.TEXTURE_2D, this.blank); gl.uniform2f(this.u.sheetSize, 1, 1); }
      if (!b.buffer) b.buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, b.buffer);
      if (b.upload) { gl.bufferData(gl.ARRAY_BUFFER, b.data.subarray(0, b.n * SpriteLayer.STRIDE), gl.DYNAMIC_DRAW); b.upload = false; }
      const stride = SpriteLayer.STRIDE * 4;
      gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride, 0); gl.vertexAttribPointer(2, 4, gl.FLOAT, false, stride, 12); gl.vertexAttribPointer(3, 4, gl.FLOAT, false, stride, 28);
      gl.vertexAttribPointer(4, 1, gl.FLOAT, false, stride, 44);
      gl.vertexAttribPointer(5, 1, gl.FLOAT, false, stride, 48);
      gl.vertexAttribPointer(6, 4, gl.FLOAT, false, stride, 52); gl.vertexAttribPointer(7, 3, gl.FLOAT, false, stride, 68);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, b.n);
    }
    gl.bindVertexArray(null);
    this.prune(live);
    return true;
  }
  release(batches) { for (const b of batches || []) if (b.buffer) { this.gl.deleteBuffer(b.buffer); b.buffer = null; } }
  destroy() {
    const gl = this.gl;
    for (const t of this.textures.values()) gl.deleteTexture(t.tex);
    this.textures.clear(); gl.deleteTexture(this.blank);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    this.canvas.width = this.canvas.height = 0;
  }
}
if (typeof module !== "undefined") module.exports = { SpriteLayer };
