/* Demeter in the wheat, rendered as ASCII.
 *
 * Two stages, after the way ASCII game renderers work:
 *
 *  1. Paint. A full-colour scene is painted with Canvas 2D in "world"
 *     units (1 = viewport height) at 2x3 samples per character cell.
 *     Sky, hills and the statue (a photograph, prepared by
 *     pipeline/statue_cutout.py) are cached; the wheat, torch flame and
 *     chaff are repainted every frame.
 *
 *  2. Glyph. WebGL2 reduces each cell to a 2x3 grid of ink samples and
 *     picks the printable-ASCII glyph whose own 2x3 ink distribution is
 *     nearest (shape-matching, not just brightness), coloured with the
 *     cell's average colour. Torch sparks, and the maxim they gather
 *     into, are forced glyphs laid over the result. A second pass draws
 *     the glyphs from an atlas onto the white page.
 *
 * The camera (world -> screen) lives in one place, so zooming is a
 * matter of changing it and repainting the cached layers.
 */
(function () {
  const canvas = document.getElementById("scene");
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const MAXIM = "SALUS POPULI SUPREMA LEX ESTO";
  const MONO = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace';
  const SERIF = '"Times New Roman", Times, Georgia, serif';
  const GLYPHS = Array.from({ length: 95 }, (_, k) => String.fromCharCode(32 + k)).join("");
  const SX = 2, SY = 3; // paint samples per cell: one per glyph-shape region

  const HORIZON = 0.6;
  const PALETTE = {
    paper: [1, 1, 1],
    skyTop: "#ffffff",
    skyLow: "#f6efe1",
    sun: "rgba(246, 226, 178, 0.9)",
    hillFar: "#e3e5e8",
    hillNear: "#d3d6d6",
    hazeField: "#eadcb5",
    gold: [214, 162, 58],
    goldShade: [150, 102, 28],
    goldLight: [244, 214, 136],
    stem: [182, 140, 62],
  };
  const rgb = (c, a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
  const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const HAZE = [234, 220, 181];

  function hash(i, j, k) {
    let h = (i * 374761393 + j * 668265263 + k * 1442695041) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }

  // ---------------------------------------------------------------- layout
  let W, H, dpr, Wd, Hd, cwd, chd, cw, ch, cols, rows, SW, SH;
  let fcw, fch, fcols, frows, fcwCss, fchCss; // fine (ember) grid
  let S, zoom = 1, camX = 0, camY = HORIZON;
  const paint = document.createElement("canvas");
  const pctx = paint.getContext("2d");
  let bgCache, figCache;
  let mid = [], near = [], chaff = [];

  // world -> paint-canvas transform
  function worldTransform(g) {
    const kx = SW / (cols * cw), ky = SH / (rows * ch);
    g.setTransform(kx * S, 0, 0, ky * S, kx * (W / 2 - camX * S), ky * (H * HORIZON - camY * S));
  }

  function layout() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth;
    H = window.innerHeight;
    Wd = Math.round(W * dpr);
    Hd = Math.round(H * dpr);
    canvas.width = Wd;
    canvas.height = Hd;
    canvas.style.width = W + "px";
    canvas.style.height = H + "px";

    const fontCss = W < 700 ? 3.6 : 4.5;
    cwd = Math.max(3, Math.round(fontCss * 0.62 * dpr));
    chd = Math.max(5, Math.round(fontCss * 1.0 * dpr));
    cw = cwd / dpr;
    ch = chd / dpr;
    cols = Math.ceil(Wd / cwd);
    rows = Math.ceil(Hd / chd);
    // The ember layer (sparks and the maxim) uses glyphs half as big.
    fcw = Math.max(2, Math.round(cwd / 2));
    fch = Math.max(3, Math.round(chd / 2));
    fcols = Math.ceil(Wd / fcw);
    frows = Math.ceil(Hd / fch);
    fcwCss = fcw / dpr;
    fchCss = fch / dpr;
    SW = cols * SX;
    SH = rows * SY;
    paint.width = SW;
    paint.height = SH;

    S = Math.min(H, W * 1.25) * zoom;
    seed();
    buildEmberTargets();
    bgCache = cacheLayer(paintBackground);
    figCache = cacheLayer(paintFigure);
    glSetup();
  }

  function cacheLayer(fn) {
    const c = document.createElement("canvas");
    c.width = SW;
    c.height = SH;
    const g = c.getContext("2d");
    worldTransform(g);
    fn(g);
    return c;
  }

  // ------------------------------------------------------------- painting
  function oval(g, x, y, rx, ry, rot, style) {
    g.beginPath();
    g.ellipse(x, y, Math.abs(rx), Math.abs(ry), rot, 0, Math.PI * 2);
    g.fillStyle = style;
    g.fill();
  }
  function radial(g, x, y, r, stops) {
    const grd = g.createRadialGradient(x, y, 0, x, y, r);
    for (const [o, c] of stops) grd.addColorStop(o, c);
    return grd;
  }
  function linear(g, x0, y0, x1, y1, stops) {
    const grd = g.createLinearGradient(x0, y0, x1, y1);
    for (const [o, c] of stops) grd.addColorStop(o, c);
    return grd;
  }
  function paintBackground(g) {
    const xl = -W / 2 / S - 1, xr = W / 2 / S + 1;
    // Sky
    g.fillStyle = linear(g, 0, -1, 0, HORIZON, [[0, PALETTE.skyTop], [0.7, "#fdfbf6"], [1, PALETTE.skyLow]]);
    g.fillRect(xl, -2, xr - xl, 4);
    // Low sun behind her head
    g.fillStyle = radial(g, 0, 0.27, 0.34, [[0, PALETTE.sun], [0.55, "rgba(246,226,178,0.55)"], [0.62, "rgba(246,226,178,0.18)"], [1, "rgba(246,226,178,0)"]]);
    g.fillRect(-0.4, -0.1, 0.8, 0.8);
    // Hills
    const hill = (y0, amp, f, ph, style) => {
      g.beginPath();
      g.moveTo(xl, HORIZON + 0.02);
      for (let x = xl; x <= xr; x += 0.01) {
        g.lineTo(x, y0 - amp * (0.6 * Math.sin(x * f + ph) + 0.3 * Math.sin(x * f * 2.7 + ph * 2) + 0.1 * Math.sin(x * f * 7.1)));
      }
      g.lineTo(xr, HORIZON + 0.02);
      g.fillStyle = style;
      g.fill();
    };
    hill(HORIZON - 0.03, 0.025, 2.1, 0.5, PALETTE.hillFar);
    hill(HORIZON - 0.012, 0.016, 3.3, 2.0, PALETTE.hillNear);
    // A line of distant cypresses
    for (let k = 0; k < 9; k++) {
      const x = -0.9 + k * 0.23 + hash(k, 1, 1) * 0.1;
      if (Math.abs(x) < 0.3) continue;
      const h = 0.025 + hash(k, 2, 2) * 0.02;
      oval(g, x, HORIZON - 0.008 - h / 2, 0.006, h / 2, 0, "#b9bfb9");
    }
    // Far field: hazy gold toward the horizon
    g.fillStyle = linear(g, 0, HORIZON - 0.01, 0, 1.05, [[0, PALETTE.hazeField], [0.3, "#ecd8a2"], [1, "#e3c27a"]]);
    g.fillRect(xl, HORIZON - 0.005, xr - xl, 1);
    // Speckle of distant ears
    for (let k = 0; k < 2600; k++) {
      const d = Math.pow(hash(k, 3, 3), 1.6);
      const y = HORIZON + d * 0.4;
      const x = xl + hash(k, 4, 4) * (xr - xl);
      const c = hash(k, 5, 5) < 0.5 ? mix(PALETTE.goldShade, HAZE, 1 - d) : mix(PALETTE.goldLight, HAZE, (1 - d) * 0.7);
      oval(g, x, y, 0.002 + d * 0.004, 0.001 + d * 0.006, 0, rgb(c, 0.9));
    }
  }

  // ---------------------------------------------------------------- figure
  // A photograph of a bronze statue of Demeter, cut out and cropped to
  // her upper body. Placement is in image pixels: STATUE.face is the
  // centre of her face, STATUE.cup the rim of her torch, where the live
  // flame is lit (the bronze flame has been erased from the image).
  const STATUE = {
    src: "assets/demeter-statue.png",
    face: [240, 150],
    cup: [98, 77],
    crownTop: 58, // top of her wreath
    scale: 0.00095, // world units per image pixel
    faceAt: [0, 0.42], // where her face sits in the world
  };
  const statue = new Image();
  statue.src = STATUE.src;
  const toWorld = ([px, py]) => [
    STATUE.faceAt[0] + (px - STATUE.face[0]) * STATUE.scale,
    STATUE.faceAt[1] + (py - STATUE.face[1]) * STATUE.scale,
  ];
  const TORCH = toWorld(STATUE.cup);
  const STAND_DEPTH = 0.9; // field depth (stalk base y) at which she stands

  function paintFigure(g) {
    const [x0, y0] = toWorld([0, 0]);
    g.drawImage(statue, x0, y0, statue.naturalWidth * STATUE.scale, statue.naturalHeight * STATUE.scale);

    // ---- fade her into the wheat
    g.save();
    g.globalCompositeOperation = "destination-out";
    const fadeA = toWorld([0, 395])[1], fadeB = toWorld([0, 455])[1];
    g.fillStyle = linear(g, 0, fadeA, 0, fadeB, [[0, "rgba(0,0,0,0)"], [1, "rgba(0,0,0,1)"]]);
    g.fillRect(-1, fadeA, 2, 1);
    g.restore();
  }

  // An ear of wheat: grains in two offset rows along the axis, with awns.
  // (x, y) is the base of the ear; a is the direction it points.
  function ear(g, x, y, a, len, light, awns) {
    const ca = Math.cos(a), sa = Math.sin(a);
    const base = mix(PALETTE.goldShade, PALETTE.gold, light);
    const hi = mix(PALETTE.gold, PALETTE.goldLight, light);
    const n = 7;
    const gw = len * 0.16, gl = len * 0.2;
    for (let k = 0; k < n; k++) {
      const u = (k + 0.5) / n;
      const taper = 1 - 0.45 * u;
      for (const s of [-1, 1]) {
        const off = s * gw * 0.55 * taper;
        const px = x + ca * len * u - sa * off;
        const py = y + sa * len * u + ca * off;
        oval(g, px, py, gl * 0.55 * taper, gw * 0.5 * taper, a + s * 0.35, rgb(s < 0 ? base : hi));
      }
      if (awns && len > 0.012) {
        const px = x + ca * len * u, py = y + sa * len * u;
        for (const s of [-1, 1]) {
          const aa = a + s * 0.28;
          g.beginPath();
          g.moveTo(px, py);
          g.lineTo(px + Math.cos(aa) * len * 0.75, py + Math.sin(aa) * len * 0.75);
          g.lineWidth = len * 0.025;
          g.strokeStyle = rgb(hi, 0.7);
          g.stroke();
        }
      }
    }
  }

  // ----------------------------------------------------------------- wheat
  function seed() {
    mid = [];
    near = [];
    chaff = [];
    const xl = -W / 2 / S - 0.1, xr = W / 2 / S + 0.1;
    const span = xr - xl;
    const nMid = Math.round(1700 * span / 1.6);
    // Fewer stalks right in front of her, so she rises clear of the field.
    const sparse = (x, k, amt) => hash(k, 6, 7) < amt * Math.max(0, 1 - Math.abs(x) / 0.22);
    for (let k = 0; k < nMid; k++) {
      const d = 0.05 + 0.95 * Math.pow(hash(k, 1, 7), 1.5);
      const x = xl + hash(k, 2, 7) * span;
      if (sparse(x, k, 0.35)) continue;
      mid.push({ x, base: HORIZON + d * 0.48, h: 0.02 + d * 0.19 * (0.8 + 0.4 * hash(k, 3, 7)), d, ph: hash(k, 4, 7) * 6.28, tone: hash(k, 5, 7) });
    }
    mid.sort((a, b) => a.base - b.base);
    const nNear = Math.round(260 * span / 1.6);
    for (let k = 0; k < nNear; k++) {
      const base = 1.08 + hash(k, 1, 8) * 0.5;
      const tipY = 0.62 + hash(k, 2, 8) * 0.18;
      const x = xl + hash(k, 3, 8) * span;
      if (sparse(x, k + 7919, 0.55)) continue;
      near.push({ x, base, h: base - tipY, d: 1 + (base - 1.08), ph: hash(k, 4, 8) * 6.28, tone: hash(k, 5, 8) });
    }
    near.sort((a, b) => a.base - b.base);
    for (let k = 0; k < 70; k++) chaff.push({ x: xl + hash(k, 1, 9) * span, y: 0.02 + hash(k, 2, 9) * 0.55, s: hash(k, 3, 9), ph: hash(k, 4, 9) * 6.28 });
  }

  // Gust fronts rolling across the field, left to right.
  function wind(x, y, t) {
    const a = Math.sin(x * 6.5 - t * 1.15 + y * 4);
    const b = Math.sin(x * 2.1 - t * 0.5 + 1.3);
    return 0.5 + 0.3 * a + 0.2 * b;
  }

  function stalk(g, s, t, big) {
    const w = wind(s.x, s.base, t);
    const lean = (0.12 + 0.55 * w + 0.06 * Math.sin(t * 1.9 + s.ph)) * s.h * 0.45;
    const tipX = s.x + lean, tipY = s.base - s.h + Math.abs(lean) * 0.25;
    const haze = big ? 0 : (1 - s.d) * 0.65;
    const stemC = mix(mix(PALETTE.stem, PALETTE.goldShade, s.tone * 0.5), HAZE, haze);
    g.beginPath();
    g.moveTo(s.x, s.base);
    g.quadraticCurveTo(s.x + lean * 0.1, s.base - s.h * 0.5, tipX, tipY);
    g.lineWidth = Math.max(0.0012, s.h * (big ? 0.012 : 0.018));
    g.strokeStyle = rgb(stemC);
    g.stroke();
    const a = Math.atan2(tipY - (s.base - s.h * 0.5), tipX - (s.x + lean * 0.1));
    const len = big ? Math.min(s.h * 0.2, 0.075) : Math.min(s.h * 0.24, 0.06);
    const light = Math.min(1, 0.25 + s.tone * 0.35 + w * 0.6);
    if (len * S < 6) {
      // Too small for grains: a single elongated ear.
      const c = mix(mix(PALETTE.goldShade, PALETTE.goldLight, light), HAZE, haze);
      oval(g, tipX + Math.cos(a) * len * 0.5, tipY + Math.sin(a) * len * 0.5, len * 0.55, len * 0.18, a, rgb(c));
    } else {
      ear(g, tipX, tipY, a, len, light * (1 - haze * 0.5), big || len * S > 14);
    }
  }

  // ---------------------------------------------------------- animated bits
  function paintFlame(g, t) {
    const [x, y] = TORCH;
    const w = wind(x, y, t);
    const flick = 0.85 + 0.15 * Math.sin(t * 11) * Math.sin(t * 7.3 + 1);
    // Glow
    g.fillStyle = radial(g, x, y - 0.03, 0.12 * flick, [[0, "rgba(255,200,120,0.55)"], [1, "rgba(255,200,120,0)"]]);
    g.fillRect(x - 0.2, y - 0.25, 0.4, 0.4);
    // Tongues
    for (let k = 0; k < 7; k++) {
      const ph = t * (5 + k * 0.7) + k * 1.9;
      const hgt = (0.07 + 0.035 * Math.sin(ph) + 0.02 * (k % 3)) * flick;
      const lean = (w - 0.3) * 0.05 + Math.sin(ph * 0.7) * 0.008;
      const bx = x + (k - 3) * 0.003;
      const wd = 0.011 - Math.abs(k - 3) * 0.0012;
      g.beginPath();
      g.moveTo(bx - wd, y + 0.004);
      g.bezierCurveTo(bx - wd * 1.3, y - hgt * 0.4, bx + lean * 0.6 - wd * 0.3, y - hgt * 0.7, bx + lean, y - hgt);
      g.bezierCurveTo(bx + lean * 0.6 + wd * 0.3, y - hgt * 0.7, bx + wd * 1.3, y - hgt * 0.4, bx + wd, y + 0.004);
      g.closePath();
      const c = k === 3 ? "rgba(255,226,150,0.95)" : k % 2 ? "rgba(214,70,34,0.85)" : "rgba(178,34,34,0.8)";
      g.fillStyle = c;
      g.fill();
    }
    oval(g, x, y - 0.012, 0.006, 0.012, 0, "rgba(255,240,200,0.95)");
  }

  // ----------------------------------------------------------------- embers
  // Sparks from the torch, drawn as forced glyphs on top of everything.
  // They rise and sway in a wind that turns back and forth. Once a cycle,
  // a swarm streams up from the flame and settles into the maxim above
  // her head (each letter built from copies of itself), holds, and is
  // blown away. Every spark's position is a pure function of time, so
  // nothing is stored between frames.
  const EMBER_GLYPHS = "'.`*,'.";
  const CYCLE = 26; // seconds per gather / hold / scatter cycle
  const GATHER = 8, HOLD = 13.5, SCATTER = 19.5; // phase starts within a cycle
  const AMBIENT = 46;
  const textMask = document.createElement("canvas");
  let targets = []; // [{x, y, ch, r}] in world units, one per letter cell
  let targetXMin = 0, targetXMax = 1, textCy = 0, textHalfH = 0;

  const breeze = (t) => 0.7 * Math.sin(t * 0.33) + 0.3 * Math.sin(t * 0.91 + 1);
  const ease = (u) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));

  // Lay the maxim out once per resize, at one pixel per cell, and keep
  // every cell that falls inside a letter as a target.
  function buildEmberTargets() {
    textMask.width = fcols;
    textMask.height = frows;
    const m = textMask.getContext("2d", { willReadFrequently: true });
    let fontH = 0.044;
    const font = () => `700 ${fontH * S}px ${SERIF}`;
    m.font = font();
    const maxW = Math.min(0.82, (W * 0.9) / S);
    // Letter spacing below adds 0.12 fontH per character.
    const textW = m.measureText(MAXIM).width / S + MAXIM.length * fontH * 0.12;
    if (textW > maxW) fontH *= maxW / textW;
    const cy = toWorld([0, STATUE.crownTop])[1] - 0.125; // clear of the flame
    textCy = cy;
    textHalfH = fontH * 0.5;
    m.setTransform(S / fcwCss, 0, 0, S / fchCss, (W / 2 - camX * S) / fcwCss, (H * HORIZON - camY * S) / fchCss);
    m.font = font();
    m.textAlign = "left";
    m.textBaseline = "middle";
    m.fillStyle = "#000";
    // Draw letter by letter so each cell knows which letter it belongs to.
    const spacing = fontH * 0.12;
    const widths = [...MAXIM].map((c) => m.measureText(c).width / S + spacing);
    let x = -widths.reduce((a, b) => a + b, 0) / 2;
    targets = [];
    const seen = new Uint8Array(fcols * frows);
    [...MAXIM].forEach((c, k) => {
      const x0 = x;
      x += widths[k];
      if (c === " ") return;
      m.save();
      m.setTransform(1, 0, 0, 1, 0, 0);
      m.clearRect(0, 0, fcols, frows);
      m.restore();
      m.save();
      m.translate(x0 + spacing / 2, cy);
      m.scale(1 / S, 1 / S);
      m.fillText(c, 0, 0);
      m.restore();
      const d = m.getImageData(0, 0, fcols, frows).data;
      for (let q = 0; q < fcols * frows; q++) {
        if (d[4 * q + 3] < 110 || seen[q]) continue;
        seen[q] = 1;
        const i = q % fcols, j = (q / fcols) | 0;
        targets.push({
          x: camX + ((i + 0.5) * fcwCss - W / 2) / S,
          y: camY + ((j + 0.5) * fchCss - H * HORIZON) / S,
          ch: c,
          r: hash(q, 3, 21),
        });
      }
    });
    targetXMin = Math.min(...targets.map((p) => p.x));
    targetXMax = Math.max(...targets.map((p) => p.x));
  }

  function wordsGlow(t) {
    const u = t - Math.floor(t / CYCLE) * CYCLE;
    return ease((u - GATHER - 2) / 3) * (1 - ease((u - SCATTER) / 2.5));
  }

  const cellOf = (x, y) => [
    Math.floor((W / 2 + (x - camX) * S) / fcwCss),
    Math.floor((H * HORIZON + (y - camY) * S) / fchCss),
  ];

  function putEmber(x, y, glyph, rgbCol) {
    const [i, j] = cellOf(x, y);
    if (i < 0 || j < 0 || i >= fcols || j >= frows) return;
    const q = 4 * (j * fcols + i);
    emberData[q] = rgbCol[0];
    emberData[q + 1] = rgbCol[1];
    emberData[q + 2] = rgbCol[2];
    emberData[q + 3] = glyph.charCodeAt(0) - 32;
  }

  // Ember colour: hot (pale gold) -> firebrick -> dark, by heat in [0, 1].
  function heatColor(h) {
    const a = [120, 18, 16], b = [178, 34, 34], c = [228, 120, 46];
    return h < 0.5 ? mix(a, b, h * 2) : mix(b, c, (h - 0.5) * 2);
  }

  function emberCells(t) {
    emberData.fill(0);
    const [tx, ty] = [TORCH[0], TORCH[1] - 0.05];
    const wind = breeze(t);

    // Ambient sparks, always rising and swaying.
    for (let k = 0; k < AMBIENT; k++) {
      const r = hash(k, 7, 21);
      const life = (t * (0.18 + 0.1 * r) + k / AMBIENT) % 1;
      const x = tx + (wind * 0.22 + 0.04 * Math.sin(t * 0.6 + r * 6)) * life + 0.018 * Math.sin(life * 7 + r * 9);
      const y = ty - life * (0.26 + 0.1 * r);
      if (hash(k, Math.floor(t * 6), 22) < life * 0.6) continue; // flicker out as they cool
      putEmber(x, y, EMBER_GLYPHS[(k + Math.floor(t * 3)) % EMBER_GLYPHS.length], heatColor(1 - life));
    }

    // The words.
    const cycle = Math.floor(t / CYCLE);
    const u = t - cycle * CYCLE;
    if (u < GATHER) return emberData;
    const dir = cycle % 2 ? -1 : 1; // the gust alternates sides each time
    for (const p of targets) {
      const start = GATHER + p.r * 3.2;
      if (u < start) continue;
      const dur = 1.5 + hash(p.r * 1e6, 1, 23) * 1.1;
      const s = (u - start) / dur;
      const span = (p.x - targetXMin) / Math.max(1e-6, targetXMax - targetXMin);
      const leave = SCATTER + (dir > 0 ? span : 1 - span) * 2.2 + p.r * 0.6;
      let x, y, glyph, col;
      if (s < 1) {
        // In flight: a curve up out of the flame, bowed by the wind.
        const e = ease(s);
        const cx = (tx + p.x) / 2 + wind * 0.12 + (p.r - 0.5) * 0.18;
        const cyy = Math.min(ty, p.y) - 0.06 - p.r * 0.08;
        x = (1 - e) * (1 - e) * tx + 2 * (1 - e) * e * cx + e * e * p.x;
        y = (1 - e) * (1 - e) * ty + 2 * (1 - e) * e * cyy + e * e * p.y;
        glyph = s > 0.85 ? p.ch : EMBER_GLYPHS[Math.floor(p.r * 50 + t * 4) % EMBER_GLYPHS.length];
        col = heatColor(1 - s * 0.4);
      } else if (u < leave) {
        // Settled: the letter, glowing and flickering.
        x = p.x;
        y = p.y;
        const glow = 0.72 + 0.22 * Math.sin(t * 2.3 + p.r * 40) * Math.sin(t * 1.3 + p.x * 30);
        glyph = hash(p.r * 1e6, Math.floor(t * 5), 24) < 0.03 ? "*" : p.ch;
        col = heatColor(Math.max(0, Math.min(1, glow)));
      } else {
        // Blown away, cooling as it goes.
        const v = u - leave;
        if (v > 3.2 || hash(p.r * 1e6, Math.floor(t * 6), 25) < v / 3.2) continue;
        x = p.x + dir * (0.07 * v + 0.03 * v * v) + 0.015 * Math.sin(v * 3 + p.r * 20);
        y = p.y - 0.035 * v - 0.01 * Math.sin(v * 2 + p.r * 9);
        glyph = v < 0.4 ? p.ch : EMBER_GLYPHS[Math.floor(p.r * 50 + t * 4) % EMBER_GLYPHS.length];
        col = heatColor(Math.max(0, 0.6 - v * 0.2));
      }
      putEmber(x, y, glyph, col);
    }
    return emberData;
  }

  function paintChaff(g, t) {
    const xl = -W / 2 / S - 0.1, span = W / S + 0.2;
    for (const p of chaff) {
      const x = xl + ((p.x - xl + t * (0.012 + p.s * 0.02)) % span);
      const y = p.y + Math.sin(t * 0.7 + p.ph) * 0.015;
      oval(g, x, y, 0.0018 + p.s * 0.0018, 0.001, Math.sin(t + p.ph), `rgba(196,160,80,${0.35 + p.s * 0.4})`);
    }
  }

  function paintFrame(t) {
    const g = pctx;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.drawImage(bgCache, 0, 0);
    worldTransform(g);
    // She stands about as far off as the nearest of the middle stalks:
    // those behind her first, then her, then the ones in front.
    let k = 0;
    while (k < mid.length && mid[k].base < STAND_DEPTH) stalk(g, mid[k++], t, false);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.drawImage(figCache, 0, 0);
    worldTransform(g);
    paintFlame(g, t);
    while (k < mid.length) stalk(g, mid[k++], t, false);
    for (const s of near) stalk(g, s, t, true);
    paintChaff(g, t);
    // A warm haze behind the words while they burn.
    const glow = wordsGlow(t);
    if (glow > 0.01) {
      g.save();
      g.translate(0, textCy);
      g.scale(1, (textHalfH * 3.2) / 0.5);
      g.fillStyle = radial(g, 0, 0, 0.5, [[0, `rgba(255,196,150,${0.32 * glow})`], [1, "rgba(255,196,150,0)"]]);
      g.fillRect(-0.6, -0.5, 1.2, 1);
      g.restore();
    }
  }

  // -------------------------------------------------------------- WebGL2
  let gl, progCell, progDraw, cellTex, cellFbo, sceneTex, atlasTex, fineTex, fineAtlasTex, vao, shapeA, shapeB;
  let emberData;

  // Heavier weights: at a few pixels tall, regular strokes antialias to
  // a faint grey.
  function glyphAtlas(w, h, weight) {
    const a = document.createElement("canvas");
    a.width = 16 * w;
    a.height = 6 * h;
    const g = a.getContext("2d", { willReadFrequently: true });
    g.fillStyle = "#fff";
    g.font = `${weight} ${Math.round(h * 0.92)}px ${MONO}`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    for (let k = 0; k < 95; k++) {
      g.fillText(GLYPHS[k], (k % 16) * w + w / 2, Math.floor(k / 16) * h + h / 2 + h * 0.04);
    }
    return a;
  }

  function buildAtlas() {
    const a = glyphAtlas(cwd, chd, 600);
    const g = a.getContext("2d", { willReadFrequently: true });
    // 2x3 ink distribution of each glyph
    const d = g.getImageData(0, 0, a.width, a.height).data;
    const v = [];
    let max = 0;
    for (let k = 0; k < 95; k++) {
      const ox = (k % 16) * cwd, oy = Math.floor(k / 16) * chd;
      const r = [0, 0, 0, 0, 0, 0], n = [0, 0, 0, 0, 0, 0];
      for (let y = 0; y < chd; y++) {
        for (let x = 0; x < cwd; x++) {
          const ri = Math.min(2, Math.floor((y / chd) * 3)) * 2 + Math.min(1, Math.floor((x / cwd) * 2));
          r[ri] += d[4 * ((oy + y) * a.width + ox + x) + 3] / 255;
          n[ri]++;
        }
      }
      for (let i = 0; i < 6; i++) { r[i] /= n[i]; max = Math.max(max, r[i]); }
      v.push(r);
    }
    shapeA = new Float32Array(96 * 4);
    shapeB = new Float32Array(96 * 4);
    v.forEach((r, k) => {
      shapeA.set([r[0] / max, r[1] / max, r[2] / max, r[3] / max], k * 4);
      shapeB.set([r[4] / max, r[5] / max, 0, 0], k * 4);
    });
    return a;
  }

  const VS = `#version 300 es
    in vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }`;

  const FS_CELL = `#version 300 es
    precision highp float;
    uniform sampler2D uScene;
    uniform vec2 uCells;
    uniform vec2 uScenePx;
    uniform vec4 uA[96];
    uniform vec4 uB[96];
    uniform float uSeed;
    out vec4 o;
    float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
    void main() {
      vec2 c = floor(gl_FragCoord.xy);
      float rowTop = uCells.y - 1.0 - c.y;
      vec3 col = vec3(0.0);
      float s[6];
      float mx = 0.0;
      for (int i = 0; i < 6; i++) {
        vec2 px = vec2(c.x * 2.0 + float(i % 2), rowTop * 3.0 + float(i / 2)) + 0.5;
        vec3 t = texture(uScene, px / uScenePx).rgb;
        col += t;
        float lum = dot(t, vec3(0.299, 0.587, 0.114));
        float mn = min(t.r, min(t.g, t.b));
        float ink = clamp(1.0 - (0.55 * mn + 0.45 * lum), 0.0, 1.0);
        ink = pow(ink, 1.7) * 1.1;
        s[i] = ink;
        mx = max(mx, ink);
      }
      col /= 6.0;
      if (mx < 0.012) { o = vec4(0.0); return; }
      // Sharpen within the cell so edges choose edge-shaped glyphs.
      float n = hash(c + uSeed) - 0.5;
      vec4 qa, qb;
      for (int i = 0; i < 6; i++) {
        float v = mx * pow(s[i] / mx, 1.5);
        v = clamp(v + n * 0.12 * (0.3 + mx), 0.0, 1.0);
        if (i < 4) qa[i] = v; else qb[i - 4] = v;
      }
      float best = 1e9; int bi = 0;
      for (int k = 0; k < 95; k++) {
        vec4 da = qa - uA[k];
        vec2 db = qb.xy - uB[k].xy;
        // Small per-cell, per-glyph jitter: among glyphs that fit about
        // equally well, a different one wins in each cell, which gives
        // flat areas a woven, many-lettered texture instead of one glyph.
        float e = dot(da, da) + dot(db, db) + 0.035 * mx * hash(c * 1.7 + float(k) * 13.1 + uSeed);
        if (e < best) { best = e; bi = k; }
      }
      // Colour reads lighter through a glyph's thin strokes than as a
      // flat fill, so deepen it a little.
      vec3 g = pow(col, vec3(1.6));
      o = vec4(g, float(bi) / 255.0);
    }`;

  const FS_DRAW = `#version 300 es
    precision highp float;
    uniform sampler2D uCell;
    uniform sampler2D uAtlas;
    uniform vec2 uCellPx;
    uniform vec2 uCells;
    uniform float uHd;
    uniform sampler2D uFine;
    uniform sampler2D uFineAtlas;
    uniform vec2 uFineCellPx;
    out vec4 o;
    void main() {
      vec2 p = vec2(gl_FragCoord.x, uHd - gl_FragCoord.y);
      // Embers and the maxim, on the fine grid, over everything.
      vec2 fc = floor(p / uFineCellPx);
      vec4 e = texelFetch(uFine, ivec2(fc), 0);
      if (e.a > 0.0) {
        float gi = floor(e.a * 255.0 + 0.5);
        vec2 f = (p - fc * uFineCellPx) / uFineCellPx;
        vec2 tile = vec2(mod(gi, 16.0), floor(gi / 16.0));
        float a = min(1.0, texture(uFineAtlas, (tile + f) / vec2(16.0, 6.0)).a * 1.7);
        if (a > 0.04) { o = vec4(mix(vec3(1.0), e.rgb, a), 1.0); return; }
      }
      vec2 cell = floor(p / uCellPx);
      vec4 c = texelFetch(uCell, ivec2(cell.x, uCells.y - 1.0 - cell.y), 0);
      float gi = floor(c.a * 255.0 + 0.5);
      vec2 f = (p - cell * uCellPx) / uCellPx;
      vec2 tile = vec2(mod(gi, 16.0), floor(gi / 16.0));
      float a = min(1.0, texture(uAtlas, (tile + f) / vec2(16.0, 6.0)).a * 1.35);
      o = vec4(mix(vec3(1.0), c.rgb, a), 1.0);
    }`;

  function compile(fs) {
    const pr = gl.createProgram();
    for (const [type, src] of [[gl.VERTEX_SHADER, VS], [gl.FRAGMENT_SHADER, fs]]) {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
      gl.attachShader(pr, sh);
    }
    gl.linkProgram(pr);
    if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(pr));
    return pr;
  }

  function tex(filter) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  function glSetup() {
    if (location.hash === "#paint") return; // debug: show the painting
    if (!gl) {
      gl = canvas.getContext("webgl2", { antialias: false, alpha: false });
      if (!gl) return;
      progCell = compile(FS_CELL);
      progDraw = compile(FS_DRAW);
      vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      sceneTex = tex(gl.LINEAR);
      atlasTex = tex(gl.NEAREST);
      cellTex = tex(gl.NEAREST);
      fineTex = tex(gl.NEAREST);
      fineAtlasTex = tex(gl.NEAREST);
      cellFbo = gl.createFramebuffer();
    }
    const atlas = buildAtlas();
    gl.bindTexture(gl.TEXTURE_2D, atlasTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlas);
    gl.bindTexture(gl.TEXTURE_2D, cellTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, cols, rows, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindTexture(gl.TEXTURE_2D, fineAtlasTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, glyphAtlas(fcw, fch, 700));
    emberData = new Uint8Array(fcols * frows * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, cellFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, cellTex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  function render(t) {
    paintFrame(t);
    if (!gl) {
      // No WebGL2: show the painting itself.
      const c2 = canvas.getContext("2d");
      c2.drawImage(paint, 0, 0, Wd, Hd);
      return;
    }
    gl.bindTexture(gl.TEXTURE_2D, sceneTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, paint);

    gl.bindFramebuffer(gl.FRAMEBUFFER, cellFbo);
    gl.viewport(0, 0, cols, rows);
    gl.useProgram(progCell);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, sceneTex);
    gl.uniform1i(gl.getUniformLocation(progCell, "uScene"), 0);
    gl.uniform2f(gl.getUniformLocation(progCell, "uCells"), cols, rows);
    gl.uniform2f(gl.getUniformLocation(progCell, "uScenePx"), SW, SH);
    gl.uniform4fv(gl.getUniformLocation(progCell, "uA"), shapeA);
    gl.uniform4fv(gl.getUniformLocation(progCell, "uB"), shapeB);
    gl.uniform1f(gl.getUniformLocation(progCell, "uSeed"), Math.floor(t * 0.8) % 97);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, Wd, Hd);
    gl.useProgram(progDraw);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, cellTex);
    gl.uniform1i(gl.getUniformLocation(progDraw, "uCell"), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, atlasTex);
    gl.uniform1i(gl.getUniformLocation(progDraw, "uAtlas"), 1);
    gl.uniform2f(gl.getUniformLocation(progDraw, "uCellPx"), cwd, chd);
    gl.uniform2f(gl.getUniformLocation(progDraw, "uCells"), cols, rows);
    gl.uniform1f(gl.getUniformLocation(progDraw, "uHd"), Hd);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, fineTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, fcols, frows, 0, gl.RGBA, gl.UNSIGNED_BYTE, emberCells(t));
    gl.uniform1i(gl.getUniformLocation(progDraw, "uFine"), 2);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, fineAtlasTex);
    gl.uniform1i(gl.getUniformLocation(progDraw, "uFineAtlas"), 3);
    gl.uniform2f(gl.getUniformLocation(progDraw, "uFineCellPx"), fcw, fch);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // ------------------------------------------------------------------ run
  let resizeTimer;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { layout(); if (reduceMotion) render(6); }, 120);
  });

  // #t=SECONDS starts the scene at a given moment (handy for checking the
  // ember lettering without waiting for it).
  const tStart = parseFloat((location.hash.match(/t=([\d.]+)/) || [])[1]) || 6;
  const t0 = performance.now();
  let last = -1e9;
  function frame(now) {
    if (now - last >= 1000 / 30) {
      last = now;
      render((now - t0) / 1000 + tStart);
    }
    requestAnimationFrame(frame);
  }
  statue.decode().then(() => {
    layout();
    if (reduceMotion) render(6);
    else requestAnimationFrame(frame);
  });
})();
