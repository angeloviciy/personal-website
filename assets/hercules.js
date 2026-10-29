/* Hercules and the Nemean lion, in a meadow below rocks and woods,
 * rendered as ASCII. A variant of the Demeter homepage (demeter.js),
 * sharing its renderer.
 *
 * Two stages, after the way ASCII game renderers work:
 *
 *  1. Paint. A full-colour scene is painted with Canvas 2D in "world"
 *     units (1 = viewport height) at 2x3 samples per character cell.
 *     Sky, crags, the far wood, tree limbs and the figures (Rubens'
 *     painting, matted by pipeline/painting_mask.py) are cached; the
 *     grass and the trees' leaves are repainted every frame.
 *
 *  2. Glyph. WebGL2 reduces each cell to a 2x3 grid of ink samples and
 *     picks the printable-ASCII glyph whose own 2x3 ink distribution is
 *     nearest (shape-matching, not just brightness), coloured with the
 *     cell's average colour. Hercules and the lion are matched the same
 *     way on a grid of glyphs half the size, so their faces hold detail.
 *     Leaves blown from the trees are forced glyphs on that fine grid,
 *     laid over the result, as is the motto above them. A second pass draws
 *     the glyphs from an atlas onto the white page.
 */
(function () {
  const canvas = document.getElementById("scene");
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const MONO = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace';
  const SERIF = '"Times New Roman", Times, Georgia, serif';
  const GLYPHS = Array.from({ length: 95 }, (_, k) => String.fromCharCode(32 + k)).join("");
  const SX = 2, SY = 3; // paint samples per cell: one per glyph-shape region

  const HORIZON = 0.62;
  const PALETTE = {
    skyTop: "#ffffff",
    skyLow: "#f3f4ee",
    rockLight: [178, 175, 164],
    rockMid: [132, 129, 118],
    rockDark: [100, 97, 89],
    rockShadow: [50, 48, 44],
    moss: [138, 150, 96],
    woodFar: [170, 184, 168],
    meadowFar: "#d9e2bf",
    bark: [92, 74, 58],
    leafDark: [44, 82, 44],
    leaf: [78, 124, 54],
    leafLight: [196, 208, 128],
    grassDark: [52, 98, 46],
    grass: [96, 142, 58],
    grassLight: [178, 190, 92],
  };
  const rgb = (c, a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
  const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const HAZE = [226, 232, 214];

  function hash(i, j, k) {
    let h = (i * 374761393 + j * 668265263 + k * 1442695041) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }

  // ---------------------------------------------------------------- layout
  let W, H, dpr, Wd, Hd, cwd, chd, cw, ch, cols, rows, SW, SH;
  let fcw, fch, fcols, frows, fcwCss, fchCss; // fine (leaf) grid
  let S, zoom = 1, camX = 0, camY = HORIZON;
  const paint = document.createElement("canvas");
  const pctx = paint.getContext("2d");
  let bgCache, figCache;
  const figPaint = document.createElement("canvas"); // figures, at 2x3 samples per fine cell
  const fctx = figPaint.getContext("2d");
  let fi0 = 0, fj0 = 0, figCols = 0, figRows = 0; // the figures' box on the fine grid
  let mid = [], near = [], seeds = [], trees = [], leaves = [];

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
    // The leaf layer (blown leaves and the maxim) uses glyphs half as big.
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
    buildBanner();
    bgCache = cacheLayer(paintBackground);
    figCache = cacheLayer(paintFigure);
    figureBox();
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
  const visible = () => [-W / 2 / S - 0.1, W / 2 / S + 0.1];

  // A crag: a heap of boulders and slabs, piled higher toward the middle.
  // Each stone is an irregular polygon cut into a lit face (upper left)
  // and a shadowed one, with a dark seam beneath. (x0, x1) its extent,
  // top its peak.
  function crag(g, x0, x1, top, base, k, haze) {
    const tone = (c, a = 1) => rgb(mix(c, HAZE, haze), a);
    const stones = [];
    const n = Math.round((x1 - x0) * 70);
    for (let i = 0; i < n; i++) {
      const u = hash(i, k, 31);
      const x = x0 + u * (x1 - x0);
      const peak = base - (base - top) * Math.pow(Math.sin(Math.PI * u), 0.7);
      const r = 0.025 + hash(i, k, 33) * 0.05;
      const y = peak + 0.02 + r * 0.4 + Math.pow(hash(i, k, 32), 0.8) * (base - peak);
      stones.push({ x, y, r, q: i });
    }
    stones.sort((p, q) => p.y - q.y); // far (higher) stones first
    // The cliff's body, which the stones are piled on and cut into.
    g.beginPath();
    g.moveTo(x0, base);
    for (let i = 0; i <= 40; i++) {
      const u = i / 40;
      const y = base - (base - top) * Math.pow(Math.sin(Math.PI * u), 0.7) + 0.02 + (hash(i, k, 30) - 0.5) * 0.025;
      g.lineTo(x0 + u * (x1 - x0), y);
    }
    g.lineTo(x1, base);
    g.closePath();
    g.fillStyle = tone(PALETTE.rockDark);
    g.fill();
    for (const st of stones) {
      const m = 7;
      const pts = [];
      for (let j = 0; j < m; j++) {
        const ang = (j / m) * Math.PI * 2 + hash(st.q, j, k + 34) * 0.6;
        const rr = st.r * (0.7 + hash(st.q, j, k + 35) * 0.45);
        pts.push([st.x + Math.cos(ang) * rr, st.y + Math.sin(ang) * rr * 0.7]);
      }
      const path = () => {
        g.beginPath();
        g.moveTo(pts[0][0], pts[0][1]);
        for (const p of pts) g.lineTo(p[0], p[1]);
        g.closePath();
      };
      // Seam of shadow under the stone.
      g.save();
      g.translate(0.004, 0.005);
      path();
      g.fillStyle = tone(PALETTE.rockShadow, 0.85);
      g.fill();
      g.restore();
      path();
      g.fillStyle = tone(hash(st.q, 1, k + 36) < 0.3 ? PALETTE.rockDark : PALETTE.rockMid);
      g.fill();
      // The lit face: the part of the stone up and left of a cut line.
      g.save();
      path();
      g.clip();
      const cut = (hash(st.q, 2, k + 37) - 0.5) * st.r * 0.6;
      g.beginPath();
      g.moveTo(st.x - st.r * 2, st.y - st.r * 2);
      g.lineTo(st.x + st.r * 1.2 + cut, st.y - st.r * 2);
      g.lineTo(st.x - st.r * 0.2 + cut, st.y + st.r * 0.3);
      g.lineTo(st.x - st.r * 2, st.y + st.r * 0.6);
      g.closePath();
      g.fillStyle = tone(PALETTE.rockLight);
      g.fill();
      // Moss in the crevices.
      for (let j = 0; j < 4; j++) {
        oval(g, st.x + (hash(st.q, j, k + 38) - 0.5) * st.r * 1.6, st.y + st.r * (0.2 + hash(st.q, j, k + 39) * 0.4), 0.004 + hash(st.q, j, k + 40) * 0.008, 0.002 + hash(st.q, j, k + 41) * 0.003, 0, tone(PALETTE.moss, 0.8));
      }
      g.restore();
    }
  }

  function paintBackground(g) {
    const [xl, xr] = visible();
    // Sky
    g.fillStyle = linear(g, 0, -1, 0, HORIZON, [[0, PALETTE.skyTop], [0.7, "#fcfcfa"], [1, PALETTE.skyLow]]);
    g.fillRect(xl - 1, -2, xr - xl + 2, 4);
    // Crags: a far, hazy range, then nearer cliffs to either side.
    crag(g, xl - 0.2, -0.05, HORIZON - 0.3, HORIZON + 0.01, 1, 0.4);
    crag(g, -0.15, xr + 0.25, HORIZON - 0.36, HORIZON + 0.01, 2, 0.35);
    crag(g, xl - 0.1, -0.3, HORIZON - 0.2, HORIZON + 0.02, 3, 0.05);
    crag(g, 0.3, xr + 0.1, HORIZON - 0.24, HORIZON + 0.02, 4, 0.02);
    // The far wood along the foot of the rocks: banks of rounded crowns.
    for (let k = 0; k < 1400; k++) {
      const x = xl + hash(k, 1, 51) * (xr - xl);
      const hgt = 0.03 + 0.05 * hash(Math.floor(x * 40), 2, 51);
      const y = HORIZON + 0.01 - hash(k, 3, 51) * hgt;
      const lit = hash(k, 4, 51);
      const c = mix(mix(PALETTE.leafDark, PALETTE.leafLight, lit * 0.6), HAZE, 0.45 + (y < HORIZON - 0.03 ? 0.1 : 0));
      oval(g, x, y, 0.006 + hash(k, 5, 51) * 0.007, 0.005 + hash(k, 6, 51) * 0.006, 0, rgb(c, 0.9));
    }
    // A nearer tree line: small round-crowned trees standing in the wood.
    for (let k = 0; k < 46; k++) {
      const x = xl + (k + hash(k, 1, 52)) / 46 * (xr - xl);
      if (Math.abs(x) < 0.12) continue;
      const hgt = 0.06 + hash(k, 2, 52) * 0.07;
      const by = HORIZON + 0.012;
      g.fillStyle = rgb(mix(PALETTE.bark, HAZE, 0.4));
      g.fillRect(x - 0.002, by - hgt * 0.5, 0.004, hgt * 0.5);
      for (let i = 0; i < 60; i++) {
        const ang = hash(k * 61 + i, 3, 52) * 6.283, rad = Math.sqrt(hash(k * 61 + i, 4, 52)) * hgt * 0.38;
        const lx = x + Math.cos(ang) * rad, ly = by - hgt * 0.62 + Math.sin(ang) * rad * 1.1;
        const lit = Math.max(0, Math.min(1, 0.5 - Math.cos(ang) * rad / hgt * 1.5 - Math.sin(ang) * rad / hgt * 1.5 + (hash(k * 61 + i, 5, 52) - 0.5) * 0.4));
        oval(g, lx, ly, 0.004, 0.003, 0, rgb(mix(mix(PALETTE.leafDark, PALETTE.leafLight, lit), HAZE, 0.3)));
      }
    }
    // Meadow, fading toward the wood.
    g.fillStyle = linear(g, 0, HORIZON, 0, 1.05, [[0, PALETTE.meadowFar], [0.35, "#dbe5bd"], [1, "#cfdcab"]]);
    g.fillRect(xl, HORIZON + 0.005, xr - xl, 1);
    // A speckle of far grass and a few flowers.
    for (let k = 0; k < 3200; k++) {
      const d = Math.pow(hash(k, 3, 3), 1.6);
      const y = HORIZON + 0.01 + d * 0.4;
      const x = xl + hash(k, 4, 4) * (xr - xl);
      const flower = hash(k, 6, 6) < 0.03;
      const c = flower ? [236, 228, 196] : hash(k, 5, 5) < 0.5 ? mix(PALETTE.grassDark, HAZE, 1 - d) : mix(PALETTE.grassLight, HAZE, (1 - d) * 0.7);
      oval(g, x, y, 0.001 + d * 0.002, 0.002 + d * 0.006, 0, rgb(c, 0.9));
    }
    for (const tr of trees) paintLimbs(g, tr);
  }

  // ---------------------------------------------------------------- trees
  // Each tree is grown once per layout: a trunk that forks into limbs,
  // with a cluster of leaves at the end of every twig. Limbs are cached
  // with the background; leaves are repainted each frame, swaying.
  function growTree(x, base, h, k, haze) {
    const tr = { limbs: [], haze, x, base, h };
    // Trunk, then a broad rounded crown of leaf clumps, each fed by a limb.
    const fork = [x + (hash(k, 1, 60) - 0.5) * h * 0.08, base - h * 0.42];
    tr.limbs.push([x, base, fork[0], fork[1], h * 0.075]);
    const cx = fork[0], cy = base - h * 0.68, rx = h * 0.42, ry = h * 0.3;
    const nClumps = 36;
    for (let c = 0; c < nClumps; c++) {
      const ang = hash(c, k, 61) * Math.PI * 2, rad = Math.sqrt(hash(c, k, 62)) * 0.85;
      const px = cx + Math.cos(ang) * rad * rx, py = cy + Math.sin(ang) * rad * ry;
      const cr = h * (0.08 + hash(c, k, 63) * 0.06);
      // Limb from the fork, bending up through a midpoint.
      const mx = (fork[0] + px) / 2 + (hash(c, k, 64) - 0.5) * h * 0.06, my = (fork[1] + py) / 2 + h * 0.03;
      tr.limbs.push([fork[0], fork[1], mx, my, h * 0.03]);
      tr.limbs.push([mx, my, px, py, h * 0.016]);
      // Clumps on the upper left of the crown catch the most light.
      const crownLit = 0.5 - (px - cx) / rx * 0.25 - (py - cy) / ry * 0.35;
      for (let i = 0; i < 100; i++) {
        const q = c * 211 + i;
        const a2 = hash(q, k, 65) * Math.PI * 2, r2 = Math.sqrt(hash(q, k, 66)) * cr;
        const lx = px + Math.cos(a2) * r2, ly = py + Math.sin(a2) * r2 * 0.85;
        const lit = Math.max(0, Math.min(1, crownLit + 0.35 - (lx - px) / cr * 0.2 - (ly - py) / cr * 0.45 + (hash(q, k, 67) - 0.5) * 0.35));
        leaves.push({ x: lx, y: ly, s: 0.0035 + hash(q, k, 68) * 0.004, a: hash(q, k, 69) * 3.14, lit, ph: hash(q, k, 70) * 6.28 + c, tr, sway: (base - ly) / h });
      }
    }
    return tr;
  }

  function paintLimbs(g, tr) {
    g.lineCap = "round";
    for (const [x0, y0, x1, y1, wd] of tr.limbs) {
      g.beginPath();
      g.moveTo(x0, y0);
      g.lineTo(x1, y1);
      g.lineWidth = wd;
      g.strokeStyle = rgb(mix(PALETTE.bark, HAZE, tr.haze));
      g.stroke();
      // Light down the left of the bark.
      if (wd > 0.006) {
        g.beginPath();
        g.moveTo(x0 - wd * 0.25, y0);
        g.lineTo(x1 - wd * 0.25, y1);
        g.lineWidth = wd * 0.25;
        g.strokeStyle = rgb(mix([160, 140, 116], HAZE, tr.haze), 0.8);
        g.stroke();
      }
    }
  }

  function paintLeaves(g, t) {
    for (const l of leaves) {
      const w = wind(l.tr.x, l.y, t);
      const dx = (w - 0.4) * 0.012 * l.sway + 0.0016 * Math.sin(t * 2.6 + l.ph);
      const dy = 0.001 * Math.sin(t * 3.1 + l.ph * 1.3);
      // Leaves turned by a gust show their pale undersides.
      const flip = Math.pow(Math.max(0, Math.sin(t * 2.2 + l.ph + l.x * 9)), 6) * w;
      const c = mix(mix(PALETTE.leafDark, PALETTE.leafLight, Math.min(1, l.lit + flip * 0.6)), HAZE, l.tr.haze);
      oval(g, l.x + dx, l.y + dy, l.s, l.s * 0.55, l.a + dx * 30, rgb(c));
    }
  }

  // ---------------------------------------------------------------- figure
  // Rubens, Hercules Strangling the Nemean Lion (c. 1639), matted from
  // its ground. Placement is in image pixels: FIGURE.head is the top of
  // Hercules' head.
  const FIGURE = {
    src: "assets/hercules-lion.png",
    head: [175, 37],
    scale: 0.0018, // world units per image pixel
    headAt: [0.03, 0.29], // where his head sits in the world
    fade: [253, 300], // image rows over which they sink into the grass
  };
  const figure = new Image();
  figure.src = FIGURE.src;
  const toWorld = ([px, py]) => [
    FIGURE.headAt[0] + (px - FIGURE.head[0]) * FIGURE.scale,
    FIGURE.headAt[1] + (py - FIGURE.head[1]) * FIGURE.scale,
  ];
  const STAND_DEPTH = 0.92; // meadow depth (blade base y) at which they stand

  function paintFigure(g) {
    const [x0, y0] = toWorld([0, 0]);
    g.drawImage(figure, x0, y0, figure.naturalWidth * FIGURE.scale, figure.naturalHeight * FIGURE.scale);
    g.save();
    g.globalCompositeOperation = "destination-out";
    const fadeA = toWorld([0, FIGURE.fade[0]])[1], fadeB = toWorld([0, FIGURE.fade[1]])[1];
    g.fillStyle = linear(g, 0, fadeA, 0, fadeB, [[0, "rgba(0,0,0,0)"], [1, "rgba(0,0,0,1)"]]);
    g.fillRect(-1, fadeA, 2, 1);
    g.restore();
  }

  // The fine grid box around the figures, and a canvas to paint them in.
  function figureBox() {
    let [x0, y0] = toWorld([0, 0]);
    let [x1, y1] = toWorld([figure.naturalWidth, FIGURE.fade[1]]);
    const ci = (x) => (W / 2 + (x - camX) * S) / fcwCss, cj = (y) => (H * HORIZON + (y - camY) * S) / fchCss;
    fi0 = Math.max(0, Math.floor(ci(x0)));
    fj0 = Math.max(0, Math.floor(cj(y0)));
    figCols = Math.max(0, Math.min(fcols, Math.ceil(ci(x1))) - fi0);
    figRows = Math.max(0, Math.min(frows, Math.ceil(cj(y1))) - fj0);
    figPaint.width = Math.max(1, figCols * SX);
    figPaint.height = Math.max(1, figRows * SY);
  }

  // The figures, with the blades that stand in front of them laid over
  // (only where they cover the figures: elsewhere the main grid has them).
  function paintFiguresFine(t, front) {
    const g = fctx;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, figPaint.width, figPaint.height);
    g.setTransform(SX * S / fcwCss, 0, 0, SY * S / fchCss, SX * ((W / 2 - camX * S) / fcwCss - fi0), SY * ((H * HORIZON - camY * S) / fchCss - fj0));
    paintFigure(g);
    g.globalCompositeOperation = "source-atop";
    for (const s of front) blade(g, s, t, !!s.big);
    g.globalCompositeOperation = "source-over";
  }

  // ----------------------------------------------------------------- grass
  function seed() {
    mid = [];
    near = [];
    seeds = [];
    leaves = [];
    const [xl, xr] = visible();
    const span = xr - xl;
    trees = [
      growTree(-0.66, HORIZON + 0.06, 0.5, 1, 0.04),
      growTree(0.7, HORIZON + 0.07, 0.52, 2, 0.02),
      growTree(-1.04, HORIZON + 0.03, 0.36, 3, 0.3),
      growTree(1.06, HORIZON + 0.03, 0.34, 4, 0.3),
    ].filter((tr) => tr.x > xl - 0.35 && tr.x < xr + 0.35);
    leaves = leaves.filter((l) => trees.includes(l.tr));
    // Fewer blades right in front of them, so they rise clear.
    const sparse = (x, k, amt) => hash(k, 6, 7) < amt * Math.max(0, 1 - Math.abs(x - 0.02) / 0.32);
    const nMid = Math.round(5200 * span / 1.6);
    for (let k = 0; k < nMid; k++) {
      const d = 0.03 + 0.97 * Math.pow(hash(k, 1, 7), 1.4);
      const x = xl + hash(k, 2, 7) * span;
      if (sparse(x, k, 0.35)) continue;
      mid.push({ x, base: HORIZON + 0.01 + d * 0.46, h: 0.012 + d * 0.13 * (0.6 + 0.8 * hash(k, 3, 7)), d, ph: hash(k, 4, 7) * 6.28, tone: hash(k, 5, 7), bend: hash(k, 6, 8) - 0.5 });
    }
    mid.sort((a, b) => a.base - b.base);
    const nNear = Math.round(170 * span / 1.6);
    for (let k = 0; k < nNear; k++) {
      const base = 1.06 + hash(k, 1, 8) * 0.3;
      const tipY = 0.7 + hash(k, 2, 8) * 0.2;
      const x = xl + hash(k, 3, 8) * span;
      if (sparse(x, k + 7919, 0.55)) continue;
      near.push({ big: true, x, base, h: base - tipY, d: 1, ph: hash(k, 4, 8) * 6.28, tone: hash(k, 5, 8), bend: hash(k, 6, 9) - 0.5 });
    }
    near.sort((a, b) => a.base - b.base);
    for (let k = 0; k < 60; k++) seeds.push({ x: xl + hash(k, 1, 9) * span, y: 0.2 + hash(k, 2, 9) * 0.6, s: hash(k, 3, 9), ph: hash(k, 4, 9) * 6.28 });
  }

  // Gust fronts rolling across the meadow, left to right.
  function wind(x, y, t) {
    const a = Math.sin(x * 6.5 - t * 1.15 + y * 4);
    const b = Math.sin(x * 2.1 - t * 0.5 + 1.3);
    return 0.5 + 0.3 * a + 0.2 * b;
  }

  // A blade: a tapering sliver curving over in the wind. Blades bent by a
  // gust catch the light, so the gusts show as pale bands rolling across.
  function blade(g, s, t, big) {
    const w = wind(s.x, s.base, t);
    const lean = (s.bend * 0.5 + 0.1 + 0.6 * w + 0.07 * Math.sin(t * 2.1 + s.ph)) * s.h * 0.55;
    const tipX = s.x + lean, tipY = s.base - s.h + Math.abs(lean) * 0.35;
    const haze = big ? 0 : (1 - s.d) * 0.6;
    const light = Math.min(1, 0.15 + s.tone * 0.4 + w * w * 0.7);
    const c = mix(mix(PALETTE.grassDark, s.tone < 0.15 ? PALETTE.grassLight : PALETTE.grass, light), HAZE, haze);
    const wb = big ? Math.max(0.0012, s.h * 0.011) : 0.0009 + s.h * 0.014;
    const cx = s.x + lean * 0.15, cy = s.base - s.h * 0.6;
    g.beginPath();
    g.moveTo(s.x - wb, s.base);
    g.quadraticCurveTo(cx - wb * 0.6, cy, tipX, tipY);
    g.quadraticCurveTo(cx + wb * 0.6, cy, s.x + wb, s.base);
    g.closePath();
    g.fillStyle = rgb(c);
    g.fill();
    if (big && s.tone > 0.82) {
      // A seed head on a few of the tallest.
      const a = Math.atan2(tipY - cy, tipX - cx);
      for (let i = 0; i < 5; i++) {
        oval(g, tipX - Math.cos(a) * i * 0.006, tipY - Math.sin(a) * i * 0.006, 0.004, 0.0016, a + (i % 2 ? 0.5 : -0.5), rgb(mix([150, 140, 82], [210, 196, 120], light)));
      }
    }
  }

  // ---------------------------------------------------------- motto
  // A line over their heads in forced glyphs on the fine grid. Every
  // letter is built from the same dense character, so all are equally
  // dark. A transparent link (#banner-link in the page) is laid over it.
  const BANNER = {
    text: "IT CAN BE DONE.",
    glyph: "M",
    y: 0.185, // centre line
    size: 0.028, // font height
    spacing: 0.32, // letter spacing, in font heights
  };
  const textMask = document.createElement("canvas");
  let letters = []; // [{x, y}] in world units, one per letter cell
  let bannerHW = 0.2; // half-width of the text
  let bannerHover = false;

  // Lay the lettering out once per resize, at one pixel per fine cell.
  function buildBanner() {
    textMask.width = fcols;
    textMask.height = frows;
    const m = textMask.getContext("2d", { willReadFrequently: true });
    m.setTransform(S / fcwCss, 0, 0, S / fchCss, (W / 2 - camX * S) / fcwCss, (H * HORIZON - camY * S) / fchCss);
    m.textAlign = "left";
    m.textBaseline = "middle";
    m.fillStyle = "#000";
    let size = BANNER.size;
    const measure = () => {
      m.font = `900 ${size * S}px ${SERIF}`;
      return [...BANNER.text].map((c) => m.measureText(c).width / S + size * BANNER.spacing);
    };
    let widths = measure();
    const maxW = Math.min(0.6, (W * 0.62) / S);
    const total = widths.reduce((p, q) => p + q, 0);
    if (total > maxW) { size *= maxW / total; widths = measure(); }
    const textW = widths.reduce((p, q) => p + q, 0);
    bannerHW = textW / 2;
    letters = [];
    const seen = new Uint8Array(fcols * frows);
    let x = -textW / 2;
    [...BANNER.text].forEach((c, k) => {
      const x0 = x;
      x += widths[k];
      if (c === " ") return;
      // Letter by letter, so each cell knows which letter it belongs to.
      m.save();
      m.setTransform(1, 0, 0, 1, 0, 0);
      m.clearRect(0, 0, fcols, frows);
      m.restore();
      m.save();
      m.translate(x0 + size * BANNER.spacing / 2, BANNER.y + size * 0.04);
      m.scale(1 / S, 1 / S);
      m.fillText(c, 0, 0);
      m.restore();
      const d = m.getImageData(0, 0, fcols, frows).data;
      for (let q = 0; q < fcols * frows; q++) {
        if (d[4 * q + 3] < 70 || seen[q]) continue;
        seen[q] = 1;
        const i = q % fcols, j = (q / fcols) | 0;
        letters.push({
          x: camX + ((i + 0.5) * fcwCss - W / 2) / S,
          y: camY + ((j + 0.5) * fchCss - H * HORIZON) / S,
        });
      }
    });
    placeBannerLink();
  }

  function placeBannerLink() {
    const el = document.getElementById("banner-link");
    if (!el) return;
    const sx = (x) => W / 2 + (x - camX) * S, sy = (y) => H * HORIZON + (y - camY) * S;
    const x0 = -bannerHW - 0.01, x1 = bannerHW + 0.01;
    const y0 = BANNER.y - BANNER.size, y1 = BANNER.y + BANNER.size;
    el.style.left = sx(x0) + "px";
    el.style.top = sy(y0) + "px";
    el.style.width = sx(x1) - sx(x0) + "px";
    el.style.height = sy(y1) - sy(y0) + "px";
    el.onmouseenter = () => (bannerHover = true);
    el.onmouseleave = () => (bannerHover = false);
  }

  const LETTER = [44, 30, 20], LETTER_HOVER = [150, 36, 28];

  // ----------------------------------------------------------------- leaves
  // Leaves torn from the trees, drawn as forced glyphs on top of
  // everything. They tumble on a breeze that
  // turns back and forth. Every leaf's position is a pure function of
  // time, so nothing is stored between frames.
  const LEAF_GLYPHS = ",'`~.^,";
  const AMBIENT = 40;
  const breeze = (t) => 0.7 * Math.sin(t * 0.33) + 0.3 * Math.sin(t * 0.91 + 1);

  const cellOf = (x, y) => [
    Math.floor((W / 2 + (x - camX) * S) / fcwCss),
    Math.floor((H * HORIZON + (y - camY) * S) / fchCss),
  ];

  function putLeaf(x, y, glyph, rgbCol) {
    const [i, j] = cellOf(x, y);
    if (i < 0 || j < 0 || i >= fcols || j >= frows) return;
    const q = 4 * (j * fcols + i);
    leafData[q] = rgbCol[0];
    leafData[q + 1] = rgbCol[1];
    leafData[q + 2] = rgbCol[2];
    leafData[q + 3] = glyph.charCodeAt(0) - 32;
  }

  // Leaf colour: deep green -> green -> turning gold -> russet, by u in [0, 1].
  function leafColor(u) {
    const a = [30, 74, 38], b = [70, 118, 40], c = [176, 140, 40], d = [150, 64, 30];
    return u < 0.4 ? mix(a, b, u / 0.4) : u < 0.75 ? mix(b, c, (u - 0.4) / 0.35) : mix(c, d, (u - 0.75) / 0.25);
  }

  function leafCells(t) {
    leafData.fill(0);
    // The motto, still.
    const ink = bannerHover ? LETTER_HOVER : LETTER;
    for (const p of letters) putLeaf(p.x, p.y, BANNER.glyph, ink);
    if (!leaves.length) return leafData;
    const wind = breeze(t);
    const src = (r) => leaves[Math.floor(r * leaves.length) % leaves.length];
    for (let k = 0; k < AMBIENT; k++) {
      const r = hash(k, 7, 21);
      const life = (t * (0.05 + 0.04 * r) + k / AMBIENT) % 1;
      const l = src(hash(k, Math.floor(t * (0.05 + 0.04 * r) + k / AMBIENT), 26));
      const x = l.x + (wind * 0.5 + 0.1) * life + 0.03 * Math.sin(life * 9 + r * 9);
      const y = l.y + life * (0.35 + 0.15 * r) - 0.02 * Math.sin(life * 5 + r * 4);
      if (life > 0.85 && hash(k, Math.floor(t * 6), 22) < (life - 0.85) * 7) continue;
      putLeaf(x, y, LEAF_GLYPHS[(k + Math.floor(t * 2.5)) % LEAF_GLYPHS.length], leafColor(0.2 + r * 0.8));
    }
    return leafData;
  }

  // Thistledown and pollen drifting over the meadow.
  function paintSeeds(g, t) {
    const [xl] = visible();
    const span = W / S + 0.2;
    for (const p of seeds) {
      const x = xl + ((p.x - xl + t * (0.01 + p.s * 0.018)) % span);
      const y = p.y + Math.sin(t * 0.6 + p.ph) * 0.02;
      oval(g, x, y, 0.0016 + p.s * 0.0016, 0.0016 + p.s * 0.0016, 0, `rgba(196,196,170,${0.35 + p.s * 0.4})`);
    }
  }

  function paintFrame(t) {
    const g = pctx;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.drawImage(bgCache, 0, 0);
    worldTransform(g);
    paintLeaves(g, t);
    // They stand about as far off as the nearest of the middle blades:
    // those behind them first, then the figures, then the ones in front.
    let k = 0;
    while (k < mid.length && mid[k].base < STAND_DEPTH) blade(g, mid[k++], t, false);
    const firstFront = k;
    if (!gl) {
      // No WebGL2: the figures go in the one painting.
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.drawImage(figCache, 0, 0);
      worldTransform(g);
    }
    while (k < mid.length) blade(g, mid[k++], t, false);
    for (const s of near) blade(g, s, t, true);
    if (gl && figCols) paintFiguresFine(t, mid.slice(firstFront).concat(near));
    paintSeeds(g, t);
  }

  // -------------------------------------------------------------- WebGL2
  let gl, progCell, progDraw, cellTex, cellFbo, sceneTex, atlasTex, fineTex, fineAtlasTex, vao, shapeA, shapeB;
  let figSceneTex, figCellTex, figFbo, fineShapeA, fineShapeB;
  let leafData;

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

  // 2x3 ink distribution of each glyph in an atlas of w x h cells.
  function shapeVectors(a, cwd, chd) {
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
    const A = new Float32Array(96 * 4);
    const B = new Float32Array(96 * 4);
    v.forEach((r, k) => {
      A.set([r[0] / max, r[1] / max, r[2] / max, r[3] / max], k * 4);
      B.set([r[4] / max, r[5] / max, 0, 0], k * 4);
    });
    return [A, B];
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
    uniform float uAlpha; // 1: the scene is a cut-out; skip cells it barely covers
    out vec4 o;
    float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
    void main() {
      vec2 c = floor(gl_FragCoord.xy);
      float rowTop = uCells.y - 1.0 - c.y;
      vec3 col = vec3(0.0);
      float s[6];
      float mx = 0.0, cover = 0.0;
      for (int i = 0; i < 6; i++) {
        vec2 px = vec2(c.x * 2.0 + float(i % 2), rowTop * 3.0 + float(i / 2)) + 0.5;
        vec4 t4 = texture(uScene, px / uScenePx);
        vec3 t = mix(vec3(1.0), t4.rgb, uAlpha > 0.5 ? t4.a : 1.0);
        cover += t4.a;
        col += t;
        float lum = dot(t, vec3(0.299, 0.587, 0.114));
        float mn = min(t.r, min(t.g, t.b));
        float ink = clamp(1.0 - (0.55 * mn + 0.45 * lum), 0.0, 1.0);
        ink = pow(ink, 1.7) * 1.1;
        s[i] = ink;
        mx = max(mx, ink);
      }
      col /= 6.0;
      // Dithered, so where the figures fade into the grass they scatter
      // into it rather than stopping at a hard edge.
      if (uAlpha > 0.5 && cover < 6.0 * (0.2 + 0.6 * hash(c * 3.1 + 7.0))) { o = vec4(0.0); return; }
      if (mx < 0.012 && uAlpha < 0.5) { o = vec4(0.0); return; }
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
      // In cut-out mode, alpha 0 means "not covered", so glyphs count from 1.
      o = vec4(g, float(bi + (uAlpha > 0.5 ? 1 : 0)) / 255.0);
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
    uniform sampler2D uFigCell;
    uniform vec2 uFigOrigin;
    uniform vec2 uFigCells;
    out vec4 o;
    void main() {
      vec2 p = vec2(gl_FragCoord.x, uHd - gl_FragCoord.y);
      // Blown leaves, on the fine grid, over everything.
      vec2 fc = floor(p / uFineCellPx);
      vec4 e = texelFetch(uFine, ivec2(fc), 0);
      if (e.a > 0.0) {
        float gi = floor(e.a * 255.0 + 0.5);
        vec2 f = (p - fc * uFineCellPx) / uFineCellPx;
        vec2 tile = vec2(mod(gi, 16.0), floor(gi / 16.0));
        float a = min(1.0, texture(uFineAtlas, (tile + f) / vec2(16.0, 6.0)).a * 1.7);
        if (a > 0.04) { o = vec4(mix(vec3(1.0), e.rgb, a), 1.0); return; }
      }
      // Hercules and the lion, on the same fine grid.
      vec2 ff = fc - uFigOrigin;
      if (ff.x >= 0.0 && ff.y >= 0.0 && ff.x < uFigCells.x && ff.y < uFigCells.y) {
        vec4 c = texelFetch(uFigCell, ivec2(ff.x, uFigCells.y - 1.0 - ff.y), 0);
        if (c.a > 0.0) {
          float gi = floor(c.a * 255.0 + 0.5) - 1.0;
          vec2 f = (p - fc * uFineCellPx) / uFineCellPx;
          vec2 tile = vec2(mod(gi, 16.0), floor(gi / 16.0));
          float a = min(1.0, texture(uFineAtlas, (tile + f) / vec2(16.0, 6.0)).a * 1.5);
          o = vec4(mix(vec3(1.0), c.rgb, a), 1.0);
          return;
        }
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
      figSceneTex = tex(gl.NEAREST);
      figCellTex = tex(gl.NEAREST);
      figFbo = gl.createFramebuffer();
    }
    const atlas = glyphAtlas(cwd, chd, 600);
    [shapeA, shapeB] = shapeVectors(atlas, cwd, chd);
    const fineAtlas = glyphAtlas(fcw, fch, 700);
    [fineShapeA, fineShapeB] = shapeVectors(fineAtlas, fcw, fch);
    gl.bindTexture(gl.TEXTURE_2D, atlasTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlas);
    gl.bindTexture(gl.TEXTURE_2D, cellTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, cols, rows, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindTexture(gl.TEXTURE_2D, fineAtlasTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, fineAtlas);
    gl.bindTexture(gl.TEXTURE_2D, figCellTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, Math.max(1, figCols), Math.max(1, figRows), 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, figFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, figCellTex, 0);
    leafData = new Uint8Array(fcols * frows * 4);
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
    // Glyph-match a painting into a cell texture.
    const cellPass = (srcTex, src, fbo, nc, nr, A, B, cutout) => {
      gl.bindTexture(gl.TEXTURE_2D, srcTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.viewport(0, 0, nc, nr);
      gl.useProgram(progCell);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, srcTex);
      gl.uniform1i(gl.getUniformLocation(progCell, "uScene"), 0);
      gl.uniform2f(gl.getUniformLocation(progCell, "uCells"), nc, nr);
      gl.uniform2f(gl.getUniformLocation(progCell, "uScenePx"), src.width, src.height);
      gl.uniform4fv(gl.getUniformLocation(progCell, "uA"), A);
      gl.uniform4fv(gl.getUniformLocation(progCell, "uB"), B);
      gl.uniform1f(gl.getUniformLocation(progCell, "uSeed"), Math.floor(t * 0.8) % 97);
      gl.uniform1f(gl.getUniformLocation(progCell, "uAlpha"), cutout ? 1 : 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
    gl.activeTexture(gl.TEXTURE0);
    cellPass(sceneTex, paint, cellFbo, cols, rows, shapeA, shapeB, false);
    if (figCols && figRows) cellPass(figSceneTex, figPaint, figFbo, figCols, figRows, fineShapeA, fineShapeB, true);

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
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, fcols, frows, 0, gl.RGBA, gl.UNSIGNED_BYTE, leafCells(t));
    gl.uniform1i(gl.getUniformLocation(progDraw, "uFine"), 2);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, fineAtlasTex);
    gl.uniform1i(gl.getUniformLocation(progDraw, "uFineAtlas"), 3);
    gl.uniform2f(gl.getUniformLocation(progDraw, "uFineCellPx"), fcw, fch);
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, figCellTex);
    gl.uniform1i(gl.getUniformLocation(progDraw, "uFigCell"), 4);
    gl.uniform2f(gl.getUniformLocation(progDraw, "uFigOrigin"), fi0, fj0);
    gl.uniform2f(gl.getUniformLocation(progDraw, "uFigCells"), figCols, figRows);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // ------------------------------------------------------------------ run
  let resizeTimer;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { layout(); if (reduceMotion) render(6); }, 120);
  });

  // #t=SECONDS starts the scene at a given moment.
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
  figure.decode().then(() => {
    layout();
    if (reduceMotion) render(6);
    else requestAnimationFrame(frame);
  });
})();
