/**
 * Particle head scene — plain WebGL, no dependencies.
 *
 *  - Background: navy gradient + volumetric "god ray" light beams + glow + grain
 *  - Head: ~56k particles sampled from a 3D head scan (js/head-data.js),
 *    lit from the upper left, with chromatic fringes and depth of field.
 *    The neck slowly dissolves into drifting dust.
 *  - Stars: small drifting specks in front of and behind the head.
 *  - Interaction: the head turns toward the pointer, and particles near / under the
 *    cursor get dragged along with it and spring back (CPU spring simulation).
 */
(function () {
  'use strict';

  var canvas = document.getElementById('scene');
  var DATA = window.HEAD_POINTS;
  if (!canvas || !DATA) return;

  var gl =
    canvas.getContext('webgl', { antialias: false, alpha: false, depth: false, powerPreference: 'high-performance' }) ||
    canvas.getContext('experimental-webgl');
  if (!gl) {
    document.documentElement.classList.add('no-webgl');
    return;
  }

  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ------------------------------------------------------------------------
   * Tunables
   * --------------------------------------------------------------------- */
  var CFG = {
    fov: 30, // vertical field of view, degrees
    viewHeight: 8.0, // world units visible vertically on landscape screens
    viewWidthMin: 6.2, // ...but always keep at least this much width (portrait)
    headPos: [0.72, 1.62, 0], // where the head sits in the world
    pivot: [0, 1.85, -0.35], // rotation pivot in model space (centre of skull)
    baseYaw: -0.74, // face turned toward the left of the screen…
    basePitch: 0.3, // …and tilted down, so the crown catches the light
    followYaw: 0.38, // how much the head turns toward the pointer
    followPitch: 0.16,
    fuzzRatio: 0.24, // extra loose particles floating around the surface
    stars: 900,
    // pointer physics
    radius: 0.85, // influence radius in world units
    drag: 12, // how strongly particles are carried with the pointer
    push: 2.6, // gentle outward push away from the cursor
    spring: 16, // pull back to rest position
    damping: 3.6,
    maxOffset: 1.25,
  };

  /* ------------------------------------------------------------------------
   * Decode baked head data
   * --------------------------------------------------------------------- */
  var BASE = DATA.count;
  var raw = atob(DATA.data);
  var bytes = new Uint8Array(raw.length);
  for (var i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  var qPos = new Int16Array(bytes.buffer, 0, BASE * 3);
  var qNrm = new Int8Array(bytes.buffer, BASE * 6, BASE * 3);

  // Seeded random so the cloud looks the same on every load
  var seed = 7;
  function rand() {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  var FUZZ = Math.round(BASE * CFG.fuzzRatio);
  var HEAD = BASE + FUZZ; // particles taking part in the pointer simulation
  var STARS = CFG.stars;
  var TOTAL = HEAD + STARS;
  var GLOW = Math.round(BASE / 4); // particles re-drawn as a soft bloom layer

  var aRest = new Float32Array(TOTAL * 3);
  var aNormal = new Float32Array(TOTAL * 3);
  var aRand = new Float32Array(TOTAL * 4);
  var aMeta = new Float32Array(TOTAL * 2); // x: kind (0 head, 1 fuzz, 2 star), y: size factor
  var offsets = new Float32Array(TOTAL * 3); // pointer displacement (local space)
  var velocity = new Float32Array(HEAD * 3);

  var s = DATA.scale / 32767;
  var px = CFG.pivot[0], py = CFG.pivot[1], pz = CFG.pivot[2];

  for (i = 0; i < BASE; i++) {
    var nx = qNrm[i * 3] / 127, ny = qNrm[i * 3 + 1] / 127, nz = qNrm[i * 3 + 2] / 127;
    // Give the surface a little thickness
    var lift = (rand() - 0.35) * 0.07;
    aRest[i * 3] = qPos[i * 3] * s - px + nx * lift;
    aRest[i * 3 + 1] = qPos[i * 3 + 1] * s - py + ny * lift;
    aRest[i * 3 + 2] = qPos[i * 3 + 2] * s - pz + nz * lift;
    aNormal[i * 3] = nx;
    aNormal[i * 3 + 1] = ny;
    aNormal[i * 3 + 2] = nz;
    aMeta[i * 2] = 0;
    aMeta[i * 2 + 1] = 0.7 + Math.pow(rand(), 3) * 1.1;
  }

  for (i = BASE; i < HEAD; i++) {
    var src = Math.floor(rand() * BASE);
    var fnx = aNormal[src * 3], fny = aNormal[src * 3 + 1], fnz = aNormal[src * 3 + 2];
    var far = rand() < 0.12;
    var d = far ? 0.25 + rand() * 0.9 : 0.04 + Math.pow(rand(), 2) * 0.32;
    var j = far ? 0.35 : 0.08;
    aRest[i * 3] = aRest[src * 3] + fnx * d + (rand() - 0.5) * j;
    aRest[i * 3 + 1] = aRest[src * 3 + 1] + fny * d + (rand() - 0.5) * j;
    aRest[i * 3 + 2] = aRest[src * 3 + 2] + fnz * d + (rand() - 0.5) * j;
    aNormal[i * 3] = fnx;
    aNormal[i * 3 + 1] = fny;
    aNormal[i * 3 + 2] = fnz;
    aMeta[i * 2] = 1;
    aMeta[i * 2 + 1] = 0.5 + rand() * 0.9;
  }

  for (i = HEAD; i < TOTAL; i++) {
    var near = rand() < 0.06;
    aRest[i * 3] = (rand() - 0.5) * (near ? 9 : 30);
    aRest[i * 3 + 1] = (rand() - 0.5) * (near ? 7 : 20);
    aRest[i * 3 + 2] = near ? 3 + rand() * 4 : -14 + rand() * 14;
    aNormal[i * 3 + 2] = 1;
    aMeta[i * 2] = 2;
    aMeta[i * 2 + 1] = near ? 1.4 + rand() * 1.4 : 0.55 + Math.pow(rand(), 4) * 1.6;
  }

  for (i = 0; i < TOTAL * 4; i++) aRand[i] = rand();

  /* ------------------------------------------------------------------------
   * Shaders
   * --------------------------------------------------------------------- */
  var FULLSCREEN_VS = [
    'attribute vec2 aPos;',
    'varying vec2 vUv;',
    'void main(){ vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }',
  ].join('\n');

  var BG_FS = [
    'precision highp float;',
    'varying vec2 vUv;',
    'uniform vec2 uRes;',
    'uniform float uTime;',
    'uniform vec2 uHead;', // head centre in uv
    'uniform vec2 uMouse;', // -1..1
    '',
    'float hash(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }',
    'float noise(vec2 p){',
    '  vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);',
    '  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);',
    '}',
    'float fbm(vec2 p){ float v = 0.0; float a = 0.5; for (int i = 0; i < 4; i++){ v += a * noise(p); p = p * 2.03 + 17.1; a *= 0.5; } return v; }',
    '',
    'void main(){',
    '  float aspect = uRes.x / uRes.y;',
    '  vec2 uv = vUv;',
    '  vec2 p = vec2(uv.x * aspect, uv.y);',
    '',
    '  // Base: deep navy, brighter toward the upper left',
    '  float dTL = length((uv - vec2(-0.05, 1.05)) * vec2(1.0, 0.85));',
    '  vec3 col = mix(vec3(0.09, 0.135, 0.28), vec3(0.022, 0.032, 0.07), smoothstep(0.05, 1.25, dTL));',
    '',
    '  // Soft glow behind the head',
    '  vec2 hp = vec2(uHead.x * aspect, uHead.y);',
    '  float hd = length((p - hp) * vec2(1.0, 0.8));',
    '  col += vec3(0.03, 0.045, 0.1) * exp(-hd * hd * 4.5);',
    '',
    '  // Volumetric light beams fanning out from a source off-screen top-left',
    '  vec2 src = vec2(-0.55 * aspect + uMouse.x * 0.04, 1.6 + uMouse.y * 0.03);',
    '  vec2 v = p - src;',
    '  float ang = atan(v.y, v.x);',
    '  float r = length(v);',
    '  float t = uTime * 0.035;',
    '  float n1 = fbm(vec2(ang * 4.2 + t * 1.3, t * 0.6));',
    '  float n2 = fbm(vec2(ang * 9.0 - t * 1.1, 3.7 + t * 0.4));',
    '  float beams = smoothstep(0.36, 0.74, n1) * 1.0 + smoothstep(0.48, 0.8, n2) * 0.4;',
    '  float breakup = 0.55 + 0.45 * fbm(vec2(ang * 5.0, r * 1.6 - uTime * 0.05));',
    '  float fall = (1.0 - smoothstep(0.9, 3.3, r)) * smoothstep(0.35, 1.2, r);',
    '  vec3 beamCol = vec3(0.15, 0.25, 0.56);',
    '  col += beamCol * beams * breakup * fall * 0.62;',
    '',
    '  // Faint secondary haze drifting across',
    '  float haze = fbm(p * 1.4 + vec2(uTime * 0.01, -uTime * 0.006));',
    '  col += vec3(0.02, 0.035, 0.09) * smoothstep(0.45, 0.9, haze);',
    '',
    '  // Vignette, heavier at the bottom',
    '  float vig = 1.0 - smoothstep(0.25, 1.35, length((uv - vec2(0.5, 0.62)) * vec2(1.0, 1.25)));',
    '  col *= mix(0.45, 1.0, vig);',
    '  col *= mix(0.55, 1.0, smoothstep(0.0, 0.35, uv.y));',
    '',
    '  // Film grain + dithering',
    '  col += (hash(gl_FragCoord.xy + fract(uTime) * 91.7) - 0.5) * 0.022;',
    '  gl_FragColor = vec4(col, 1.0);',
    '}',
  ].join('\n');

  var POINTS_VS = [
    'precision highp float;',
    'attribute vec3 aRest;',
    'attribute vec3 aNormal;',
    'attribute vec4 aRand;',
    'attribute vec2 aMeta;',
    'attribute vec3 aOffset;',
    '',
    'uniform mat4 uProj;',
    'uniform mat4 uView;',
    'uniform mat3 uRot;',
    'uniform vec3 uHeadPos;',
    'uniform vec3 uCamPos;',
    'uniform vec3 uLight;',
    'uniform float uPivotY;',
    'uniform float uTime;',
    'uniform float uIntro;',
    'uniform float uSize;',
    'uniform float uFocus;',
    'uniform float uViewH;', // viewport height in device pixels
    'uniform float uGlow;', // 1 = soft bloom pass
    '',
    'varying vec3 vColor;',
    'varying vec2 vCA;',
    'varying float vRadius;',
    'varying float vSprite;',
    'varying float vSoft;',
    '',
    // Ashima / Stefan Gustavson simplex noise (MIT)
    'vec3 mod289(vec3 x){ return x - floor(x * (1.0 / 289.0)) * 289.0; }',
    'vec4 mod289(vec4 x){ return x - floor(x * (1.0 / 289.0)) * 289.0; }',
    'vec4 permute(vec4 x){ return mod289(((x * 34.0) + 1.0) * x); }',
    'vec4 taylorInvSqrt(vec4 r){ return 1.79284291400159 - 0.85373472095314 * r; }',
    'float snoise(vec3 v){',
    '  const vec2 C = vec2(1.0/6.0, 1.0/3.0); const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);',
    '  vec3 i = floor(v + dot(v, C.yyy)); vec3 x0 = v - i + dot(i, C.xxx);',
    '  vec3 g = step(x0.yzx, x0.xyz); vec3 l = 1.0 - g; vec3 i1 = min(g.xyz, l.zxy); vec3 i2 = max(g.xyz, l.zxy);',
    '  vec3 x1 = x0 - i1 + C.xxx; vec3 x2 = x0 - i2 + C.yyy; vec3 x3 = x0 - D.yyy;',
    '  i = mod289(i);',
    '  vec4 p = permute(permute(permute(i.z + vec4(0.0, i1.z, i2.z, 1.0)) + i.y + vec4(0.0, i1.y, i2.y, 1.0)) + i.x + vec4(0.0, i1.x, i2.x, 1.0));',
    '  float n_ = 0.142857142857; vec3 ns = n_ * D.wyz - D.xzx;',
    '  vec4 j = p - 49.0 * floor(p * ns.z * ns.z); vec4 x_ = floor(j * ns.z); vec4 y_ = floor(j - 7.0 * x_);',
    '  vec4 x = x_ * ns.x + ns.yyyy; vec4 y = y_ * ns.x + ns.yyyy; vec4 h = 1.0 - abs(x) - abs(y);',
    '  vec4 b0 = vec4(x.xy, y.xy); vec4 b1 = vec4(x.zw, y.zw);',
    '  vec4 s0 = floor(b0) * 2.0 + 1.0; vec4 s1 = floor(b1) * 2.0 + 1.0; vec4 sh = -step(h, vec4(0.0));',
    '  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy; vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;',
    '  vec3 p0 = vec3(a0.xy, h.x); vec3 p1 = vec3(a0.zw, h.y); vec3 p2 = vec3(a1.xy, h.z); vec3 p3 = vec3(a1.zw, h.w);',
    '  vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));',
    '  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;',
    '  vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0); m = m * m;',
    '  return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));',
    '}',
    '',
    'void main(){',
    '  float kind = aMeta.x;',
    '  vec3 world;',
    '  vec3 n = uRot * aNormal;',
    '  float alpha = 1.0;',
    '  float cocScale = 1.0;',
    '',
    '  if (kind < 1.5) {',
    '    // ---- head / fuzz particles (model space → world) ----',
    '    vec3 local = aRest + aOffset;',
    '    float t = uTime * 0.12;',
    '    vec3 q = local * 0.55 + vec3(0.0, -t, t * 0.5);',
    '    vec3 flow = vec3(snoise(q), snoise(q + 19.1), snoise(q + 41.7));',
    '    float amp = kind > 0.5 ? 0.11 : 0.035;',
    '    local += flow * amp;',
    '    // tiny per-particle shimmer',
    '    local += 0.012 * vec3(sin(uTime * 1.3 + aRand.x * 40.0), sin(uTime * 1.1 + aRand.y * 40.0), sin(uTime * 1.7 + aRand.z * 40.0));',
    '',
    '    world = uRot * local + uHeadPos;',
    '',
    '    // Dissolve the neck: particles below the jaw fall away and fade out',
    '    float my = aRest.y + uPivotY;',
    '    float dis = 1.0 - smoothstep(-2.9, -0.1, my);',
    '    float cyc = fract(uTime * (0.035 + aRand.w * 0.05) + aRand.x);',
    '    vec3 drift = vec3(flow.x * 0.9 + (aRand.y - 0.5) * 1.4, -cyc * 2.6, flow.z * 0.6);',
    '    world += drift * dis * dis;',
    '    alpha *= 1.0 - dis * (0.35 + 0.65 * cyc);',
    '    alpha *= 1.0 - (1.0 - smoothstep(-2.9, -0.9, my)) * 0.85;',
    '',
    '    // Intro: particles gather from a wide cloud',
    '    float it = clamp((uIntro - aRand.z * 0.45) / 0.55, 0.0, 1.0);',
    '    float e = 1.0 - pow(1.0 - it, 3.0);',
    '    vec3 scatter = uHeadPos + normalize(aRand.xyz - 0.5 + 0.001) * (5.0 + aRand.w * 9.0);',
    '    world = mix(scatter, world, e);',
    '    alpha *= 0.15 + 0.85 * it;',
    '  } else {',
    '    // ---- stars ----',
    '    world = aRest;',
    '    world.x += sin(uTime * 0.03 + aRand.x * 6.283) * 0.6;',
    '    world.y += mod(aRest.y + 10.0 + uTime * (0.02 + aRand.y * 0.05), 20.0) - 10.0 - aRest.y;',
    '    alpha *= smoothstep(0.0, 0.6, uIntro);',
    '    cocScale = 0.12;',
    '  }',
    '',
    '  vec4 view = uView * vec4(world, 1.0);',
    '  gl_Position = uProj * view;',
    '  float depth = -view.z;',
    '',
    '  // ---- lighting ----',
    '  vec3 color;',
    '  float tw = 0.7 + 0.3 * sin(uTime * (0.8 + aRand.w * 2.4) + aRand.x * 60.0);',
    '  float sparkle = pow(max(0.0, sin(uTime * (0.35 + aRand.y * 0.6) + aRand.z * 80.0)), 40.0) * 1.8;',
    '  if (kind < 1.5) {',
    '    vec3 V = normalize(uCamPos - world);',
    '    float diff = max(dot(n, uLight), 0.0);',
    '    float wrap = clamp(dot(n, uLight) * 0.5 + 0.5, 0.0, 1.0);',
    '    float rim = pow(1.0 - clamp(abs(dot(n, V)), 0.0, 1.0), 3.0);',
    '    float b = 0.035 + 1.35 * pow(diff, 1.6) + 0.08 * wrap + 0.16 * rim;',
    '    if (kind > 0.5) b *= 0.45;',
    '    b *= tw;',
    '    vec3 dim = vec3(0.2, 0.3, 0.68);',
    '    vec3 lit = vec3(0.93, 0.96, 1.0);',
    '    color = mix(dim, lit, smoothstep(0.2, 1.05, b)) * (b + sparkle);',
    '  } else {',
    '    color = vec3(0.75, 0.83, 1.0) * (0.5 + 0.5 * aRand.z) * (tw + sparkle);',
    '  }',
    '',
    '  // ---- size + depth of field ----',
    '  float base = uSize * aMeta.y * (12.0 / depth);',
    '  float coc = abs(depth - uFocus) * uViewH * 0.0026 * cocScale;',
    '  float size = base + coc;',
    '  alpha *= clamp((base * base) / (size * size), 0.05, 1.0);',
    '  vSoft = clamp(coc / (base + coc + 0.001), 0.0, 1.0);',
    '',
    '  // ---- chromatic aberration: split RGB outward from screen centre ----',
    '  vec2 ndc = gl_Position.xy / gl_Position.w;',
    '  float ca = (0.9 + length(ndc) * 1.5 + coc * 0.15) * uViewH / 1100.0;',
    '  vCA = vec2(ndc.x, -ndc.y) * ca;',
    '  vRadius = size * 0.5;',
    '  vSprite = size + length(vCA) * 2.0 + 2.0;',
    '  if (uGlow > 0.5) {',
    '    // bloom: big, faint, blurry copies of a subset of the particles',
    '    vSoft = 1.0;',
    '    vCA = vec2(0.0);',
    '    vRadius = base * 3.0 + uViewH * 0.011;',
    '    vSprite = vRadius * 2.0 + 2.0;',
    '    alpha *= 0.0055;',
    '  }',
    '  gl_PointSize = vSprite;',
    '  vColor = color * alpha;',
    '}',
  ].join('\n');

  var POINTS_FS = [
    'precision mediump float;',
    'varying vec3 vColor;',
    'varying vec2 vCA;',
    'varying float vRadius;',
    'varying float vSprite;',
    'varying float vSoft;',
    'float disc(vec2 p){',
    '  float d = length(p);',
    '  float inner = vRadius * (1.0 - vSoft) * 0.6;',
    '  return 1.0 - smoothstep(inner - 0.35, vRadius + 0.6, d);',
    '}',
    'void main(){',
    '  vec2 p = (gl_PointCoord - 0.5) * vSprite;',
    '  vec3 m = vec3(disc(p + vCA), disc(p), disc(p - vCA));',
    '  if (m.r + m.g + m.b < 0.004) discard;',
    '  gl_FragColor = vec4(vColor * m, 1.0);',
    '}',
  ].join('\n');

  function compile(type, source) {
    var sh = gl.createShader(type);
    gl.shaderSource(sh, source);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(sh) || 'shader compile failed');
    }
    return sh;
  }

  function program(vs, fs) {
    var p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || 'link failed');
    var info = { program: p, attrib: {}, uniform: {} };
    var na = gl.getProgramParameter(p, gl.ACTIVE_ATTRIBUTES);
    for (var a = 0; a < na; a++) {
      var an = gl.getActiveAttrib(p, a).name;
      info.attrib[an] = gl.getAttribLocation(p, an);
    }
    var nu = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (var u = 0; u < nu; u++) {
      var un = gl.getActiveUniform(p, u).name;
      info.uniform[un] = gl.getUniformLocation(p, un);
    }
    return info;
  }

  var bgProg, ptProg;
  try {
    bgProg = program(FULLSCREEN_VS, BG_FS);
    ptProg = program(POINTS_VS, POINTS_FS);
  } catch (err) {
    console.error(err);
    document.documentElement.classList.add('no-webgl');
    return;
  }

  function buffer(data, usage) {
    var b = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, data, usage || gl.STATIC_DRAW);
    return b;
  }

  var quadBuf = buffer(new Float32Array([-1, -1, 3, -1, -1, 3]));
  var restBuf = buffer(aRest);
  var normalBuf = buffer(aNormal);
  var randBuf = buffer(aRand);
  var metaBuf = buffer(aMeta);
  var offsetBuf = buffer(offsets, gl.DYNAMIC_DRAW);

  function bindAttrib(prog, name, buf, size) {
    var loc = prog.attrib[name];
    if (loc === undefined || loc < 0) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
  }

  function disableAttribs(prog) {
    for (var k in prog.attrib) gl.disableVertexAttribArray(prog.attrib[k]);
  }

  /* ------------------------------------------------------------------------
   * Small math helpers (column-major matrices, like WebGL expects)
   * --------------------------------------------------------------------- */
  function perspective(fovy, aspect, near, far) {
    var f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
    return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
  }

  function lookAt(eye, target) {
    var zx = eye[0] - target[0], zy = eye[1] - target[1], zz = eye[2] - target[2];
    var zl = Math.hypot(zx, zy, zz);
    zx /= zl; zy /= zl; zz /= zl;
    // x = up(0,1,0) × z
    var xx = zz, xy = 0, xz = -zx;
    var xl = Math.hypot(xx, xy, xz);
    xx /= xl; xy /= xl; xz /= xl;
    var yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
    return new Float32Array([
      xx, yx, zx, 0,
      xy, yy, zy, 0,
      xz, yz, zz, 0,
      -(xx * eye[0] + xy * eye[1] + xz * eye[2]),
      -(yx * eye[0] + yy * eye[1] + yz * eye[2]),
      -(zx * eye[0] + zy * eye[1] + zz * eye[2]),
      1,
    ]);
  }

  // Rotation = Ry(yaw) * Rx(pitch), column-major mat3
  function rotation(yaw, pitch) {
    var cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
    return new Float32Array([cy, 0, -sy, sy * sp, cp, cy * sp, sy * cp, -sp, cy * cp]);
  }

  /* ------------------------------------------------------------------------
   * Pointer
   * --------------------------------------------------------------------- */
  var pointer = {
    x: 0, y: 0, // NDC -1..1 (y up)
    px: 0, py: 0, // previous frame NDC
    active: false,
    seen: false,
    smoothX: 0, smoothY: 0, // for head-follow
    vx: 0, vy: 0, // smoothed world-space velocity
  };

  function onPointer(e) {
    pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
    pointer.y = -((e.clientY / window.innerHeight) * 2 - 1);
    if (!pointer.seen || !pointer.active) {
      // (re)entering: don't treat the jump as a fast swipe
      pointer.px = pointer.x;
      pointer.py = pointer.y;
      pointer.seen = true;
    }
    pointer.active = true;
  }
  function release() {
    pointer.active = false;
  }
  window.addEventListener('pointermove', onPointer, { passive: true });
  window.addEventListener('pointerdown', onPointer, { passive: true });
  window.addEventListener('pointerup', function (e) { if (e.pointerType !== 'mouse') release(); });
  window.addEventListener('pointercancel', release);
  window.addEventListener('blur', release);
  // mouse left the window
  document.addEventListener('mouseout', function (e) { if (!e.relatedTarget) release(); });

  /* ------------------------------------------------------------------------
   * Resize
   * --------------------------------------------------------------------- */
  var W = 1, H = 1, DPR = 1, aspect = 1, camDist = 12, viewH = 7, proj;
  var fovRad = (CFG.fov * Math.PI) / 180;

  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 1.75);
    W = Math.max(1, Math.floor(window.innerWidth * DPR));
    H = Math.max(1, Math.floor(window.innerHeight * DPR));
    canvas.width = W;
    canvas.height = H;
    aspect = W / H;
    viewH = Math.max(CFG.viewHeight, CFG.viewWidthMin / aspect);
    camDist = viewH / 2 / Math.tan(fovRad / 2);
    proj = perspective(fovRad, aspect, 0.1, 100);
    gl.viewport(0, 0, W, H);
  }
  window.addEventListener('resize', resize);
  resize();

  /* ------------------------------------------------------------------------
   * Pointer → particle simulation (runs on the CPU, uploads offsets)
   * --------------------------------------------------------------------- */
  var awake = false; // skip work when everything is at rest

  function simulate(dt, rot, eye) {
    // Pointer velocity in world units/sec at the head's depth
    var halfH = Math.tan(fovRad / 2) * camDist;
    var dxw = (pointer.x - pointer.px) * halfH * aspect;
    var dyw = (pointer.y - pointer.py) * halfH;
    pointer.px = pointer.x;
    pointer.py = pointer.y;
    var k = 1 - Math.exp(-dt * 18);
    pointer.vx += (dxw / dt - pointer.vx) * k;
    pointer.vy += (dyw / dt - pointer.vy) * k;
    // clamp very fast flicks
    var sp = Math.hypot(pointer.vx, pointer.vy), maxSp = 22;
    if (sp > maxSp) { pointer.vx *= maxSp / sp; pointer.vy *= maxSp / sp; }

    var hx = CFG.headPos[0], hy = CFG.headPos[1], hz = CFG.headPos[2];

    // Ray from camera through the pointer, in world space
    var tx = pointer.x * halfH * aspect, ty = pointer.y * halfH;
    // eye looks at (0, lookY, 0); approximate ray dir through the image plane at the head
    var rdx = tx - eye[0], rdy = ty + lookY - eye[1], rdz = 0 - eye[2];
    var rl = Math.hypot(rdx, rdy, rdz);
    rdx /= rl; rdy /= rl; rdz /= rl;

    // Transform ray + velocity into the head's local (model) space: local = R^T (world - headPos)
    // rot is column-major: columns are R's columns, so R^T v = (col0·v, col1·v, col2·v)
    function toLocal(x, y, z, out) {
      out[0] = rot[0] * x + rot[1] * y + rot[2] * z;
      out[1] = rot[3] * x + rot[4] * y + rot[5] * z;
      out[2] = rot[6] * x + rot[7] * y + rot[8] * z;
    }
    var ro = [0, 0, 0], rd = [0, 0, 0], mv = [0, 0, 0];
    toLocal(eye[0] - hx, eye[1] - hy, eye[2] - hz, ro);
    toLocal(rdx, rdy, rdz, rd);
    toLocal(pointer.vx, pointer.vy, 0, mv);

    var R = CFG.radius, R2 = R * R;
    var hasPointer = pointer.active && pointer.seen;
    var drag = CFG.drag, push = CFG.push, kS = CFG.spring, damp = Math.exp(-CFG.damping * dt);
    var maxO = CFG.maxOffset, maxO2 = maxO * maxO;
    var moving = false;

    for (var i = 0; i < HEAD; i++) {
      var i3 = i * 3;
      var ox = offsets[i3], oy = offsets[i3 + 1], oz = offsets[i3 + 2];
      var vx = velocity[i3], vy = velocity[i3 + 1], vz = velocity[i3 + 2];
      var resting = ox === 0 && oy === 0 && oz === 0 && vx === 0 && vy === 0 && vz === 0;

      if (hasPointer) {
        var wx = aRest[i3] + ox - ro[0], wy = aRest[i3 + 1] + oy - ro[1], wz = aRest[i3 + 2] + oz - ro[2];
        var t = wx * rd[0] + wy * rd[1] + wz * rd[2];
        var cx = wx - rd[0] * t, cy = wy - rd[1] * t, cz = wz - rd[2] * t;
        var d2 = cx * cx + cy * cy + cz * cz;
        if (d2 < R2) {
          var f = 1 - d2 / R2;
          f *= f;
          // carry particles along with the pointer
          var a = drag * f * dt;
          vx += (mv[0] - vx) * a;
          vy += (mv[1] - vy) * a;
          vz += (mv[2] - vz) * a;
          // and gently part them around the cursor
          var inv = push * f * dt / Math.sqrt(d2 + 0.0004);
          vx += cx * inv;
          vy += cy * inv;
          vz += cz * inv;
          resting = false;
        }
      }
      if (resting) continue;

      // spring back home
      vx = (vx - ox * kS * dt) * damp;
      vy = (vy - oy * kS * dt) * damp;
      vz = (vz - oz * kS * dt) * damp;
      ox += vx * dt;
      oy += vy * dt;
      oz += vz * dt;

      var o2 = ox * ox + oy * oy + oz * oz;
      if (o2 > maxO2) {
        var sc = maxO / Math.sqrt(o2);
        ox *= sc; oy *= sc; oz *= sc;
      }
      if (o2 < 1e-8 && vx * vx + vy * vy + vz * vz < 1e-8) {
        ox = oy = oz = vx = vy = vz = 0;
      } else {
        moving = true;
      }
      offsets[i3] = ox; offsets[i3 + 1] = oy; offsets[i3 + 2] = oz;
      velocity[i3] = vx; velocity[i3 + 1] = vy; velocity[i3 + 2] = vz;
    }

    if (moving || awake) {
      gl.bindBuffer(gl.ARRAY_BUFFER, offsetBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, offsets.subarray(0, HEAD * 3));
    }
    awake = moving;
  }

  /* ------------------------------------------------------------------------
   * Render loop
   * --------------------------------------------------------------------- */
  var light = (function () {
    var l = [-0.62, 0.45, 0.68], n = Math.hypot(l[0], l[1], l[2]);
    return new Float32Array([l[0] / n, l[1] / n, l[2] / n]);
  })();

  var lookY = 0;
  var yaw = CFG.baseYaw, pitch = CFG.basePitch;
  var start = performance.now();
  var last = start;
  var introDur = reduceMotion ? 0.001 : 3.2;

  function frame(now) {
    var dt = Math.min(0.05, Math.max(0.001, (now - last) / 1000));
    last = now;
    var time = (now - start) / 1000;
    var intro = Math.min(1, time / introDur);

    // Smooth pointer for head-follow + camera parallax
    var fk = 1 - Math.exp(-dt * 2.4);
    var tx = pointer.active ? pointer.x : 0, ty = pointer.active ? pointer.y : 0;
    pointer.smoothX += (tx - pointer.smoothX) * fk;
    pointer.smoothY += (ty - pointer.smoothY) * fk;

    var idle = reduceMotion ? 0 : 1;
    var targetYaw = CFG.baseYaw + pointer.smoothX * CFG.followYaw + Math.sin(time * 0.21) * 0.06 * idle;
    var targetPitch = CFG.basePitch - pointer.smoothY * CFG.followPitch + Math.sin(time * 0.17 + 1.3) * 0.025 * idle;
    var rk = 1 - Math.exp(-dt * 3.0);
    yaw += (targetYaw - yaw) * rk;
    pitch += (targetPitch - pitch) * rk;
    var rot = rotation(yaw, pitch);

    var eye = [pointer.smoothX * 0.35, lookY + pointer.smoothY * 0.2, camDist];
    var view = lookAt(eye, [0, lookY, 0]);

    simulate(dt, rot, eye);

    // --- background ---
    gl.disable(gl.BLEND);
    gl.useProgram(bgProg.program);
    bindAttrib(bgProg, 'aPos', quadBuf, 2);
    var hu = bgProg.uniform;
    gl.uniform2f(hu.uRes, W, H);
    gl.uniform1f(hu.uTime, time);
    // head centre (world headPos + pivot offset ≈ headPos) projected to uv
    var headScreenY = 0.5 + (CFG.headPos[1] + 0.3 - lookY) / viewH;
    gl.uniform2f(hu.uHead, 0.5 + CFG.headPos[0] / (viewH * aspect), headScreenY);
    gl.uniform2f(hu.uMouse, pointer.smoothX, pointer.smoothY);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    disableAttribs(bgProg);

    // --- particles ---
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(ptProg.program);
    bindAttrib(ptProg, 'aRest', restBuf, 3);
    bindAttrib(ptProg, 'aNormal', normalBuf, 3);
    bindAttrib(ptProg, 'aRand', randBuf, 4);
    bindAttrib(ptProg, 'aMeta', metaBuf, 2);
    bindAttrib(ptProg, 'aOffset', offsetBuf, 3);
    var pu = ptProg.uniform;
    gl.uniformMatrix4fv(pu.uProj, false, proj);
    gl.uniformMatrix4fv(pu.uView, false, view);
    gl.uniformMatrix3fv(pu.uRot, false, rot);
    gl.uniform3fv(pu.uHeadPos, CFG.headPos);
    gl.uniform3fv(pu.uCamPos, eye);
    gl.uniform3fv(pu.uLight, light);
    gl.uniform1f(pu.uPivotY, CFG.pivot[1]);
    gl.uniform1f(pu.uTime, reduceMotion ? time * 0.3 : time);
    gl.uniform1f(pu.uIntro, intro);
    // point size scales with the viewport so density looks the same everywhere
    gl.uniform1f(pu.uSize, Math.max(1.3, Math.min(4.2, H / 480)) * (camDist / 12) * 0.92);
    gl.uniform1f(pu.uFocus, camDist - CFG.headPos[2] - 0.6);
    gl.uniform1f(pu.uViewH, H);
    gl.uniform1f(pu.uGlow, 1);
    gl.drawArrays(gl.POINTS, 0, GLOW); // particles are in random order, so the first N are a random subset
    gl.uniform1f(pu.uGlow, 0);
    gl.drawArrays(gl.POINTS, 0, TOTAL);
    disableAttribs(ptProg);

    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);

  // Exposed for tweaking from the dev-tools console, e.g. NoemaScene.config.radius = 1.4
  window.NoemaScene = { config: CFG };
})();
