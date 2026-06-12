/* Time-space map of San Francisco from 62 Moss Street.
 *
 * Projection: each street vertex keeps its true compass bearing from the
 * origin, but its distance from the center is its current travel time
 * (min of walking and transit). Isochrones are therefore fixed concentric
 * circles; the street grid stretches and compresses through them as the
 * day's timetable breathes.
 */
(async function () {
  const canvas = document.getElementById("map");
  const ctx = canvas.getContext("2d");

  const [meta, timesBuf, streets] = await Promise.all([
    fetch("assets/times.json").then((r) => r.json()),
    fetch("assets/times.bin").then((r) => r.arrayBuffer()),
    fetch("assets/streets.json").then((r) => r.json()),
  ]);
  const { nx, ny, slices } = meta;
  const [lonMin, latMin, lonMax, latMax] = meta.bbox;
  const [oLon, oLat] = meta.origin;

  const UNREACHABLE = 255;
  const RING_MINUTES = [15, 30, 45, 60];
  const OUTER_RINGS = [90, 120]; // the night zone
  const T_CUT = 148; // minutes beyond which streets are not drawn
  const DAY_SECONDS = 10; // one 24h loop = one heartbeat
  const KX = Math.cos((37.77 * Math.PI) / 180); // lon -> meters correction

  // Temporal low-pass over the day: each slice becomes a [1,2,1]/4 blend
  // with its neighbors. Slice-to-slice sampling jitter (±1-2 min) vanishes;
  // the day/night wave, which spans many slices, is untouched.
  const raw = new Uint8Array(timesBuf);
  const cells = nx * ny;
  const times = new Float32Array(raw.length);
  for (let c = 0; c < cells; c++) {
    for (let s = 0; s < slices; s++) {
      const v = raw[s * cells + c];
      if (v === 255) { times[s * cells + c] = 255; continue; }
      let sum = v * 2, w = 2;
      const prev = raw[((s + slices - 1) % slices) * cells + c];
      const next = raw[((s + 1) % slices) * cells + c];
      if (prev !== 255) { sum += prev; w += 1; }
      if (next !== 255) { sum += next; w += 1; }
      times[s * cells + c] = sum / w;
    }
  }

  // --- Precompute static per-vertex data: bearing + bilinear sample coords ---
  // Layout per vertex: [sinB, cosB, gx, gy] with gx/gy fractional grid coords.
  function prepare(lines) {
    return lines.map((flat) => {
      const n = flat.length / 2;
      const v = new Float32Array(n * 4);
      for (let i = 0; i < n; i++) {
        const lon = lonMin + (flat[2 * i] / 65535) * (lonMax - lonMin);
        const lat = latMin + (flat[2 * i + 1] / 65535) * (latMax - latMin);
        const dx = (lon - oLon) * KX;
        const dy = lat - oLat;
        const d = Math.hypot(dx, dy) || 1e-12;
        v[4 * i] = dx / d;
        v[4 * i + 1] = dy / d;
        v[4 * i + 2] = ((lon - lonMin) / (lonMax - lonMin)) * (nx - 1);
        v[4 * i + 3] = ((lat - latMin) / (latMax - latMin)) * (ny - 1);
      }
      return v;
    });
  }
  const major = prepare(streets.major);
  const minor = prepare(streets.minor);

  // Bilinear sample of one slice; 255 cells are excluded and weights
  // renormalized. Returns UNREACHABLE if all four corners are unreachable.
  function sample(slice, gx, gy) {
    const x0 = gx | 0, y0 = gy | 0;
    const x1 = Math.min(x0 + 1, nx - 1), y1 = Math.min(y0 + 1, ny - 1);
    const fx = gx - x0, fy = gy - y0;
    const base = slice * cells;
    let sum = 0, wsum = 0;
    const corners = [
      [times[base + y0 * nx + x0], (1 - fx) * (1 - fy)],
      [times[base + y0 * nx + x1], fx * (1 - fy)],
      [times[base + y1 * nx + x0], (1 - fx) * fy],
      [times[base + y1 * nx + x1], fx * fy],
    ];
    for (const [t, w] of corners) {
      if (t !== UNREACHABLE) { sum += t * w; wsum += w; }
    }
    return wsum > 0.05 ? sum / wsum : UNREACHABLE;
  }

  // Travel time at a continuous day position (in slices), per vertex.
  function timeAt(s0, s1, frac, gx, gy) {
    const a = sample(s0, gx, gy);
    const b = sample(s1, gx, gy);
    if (a === UNREACHABLE && b === UNREACHABLE) return UNREACHABLE;
    if (a === UNREACHABLE) return b;
    if (b === UNREACHABLE) return a;
    return a + (b - a) * frac;
  }

  // --- Layout ---
  let W, H, cx, cy, rScale;
  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = W + "px";
    canvas.style.height = H + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cx = W / 2;
    cy = H / 2;
    // Linear minutes->pixels. The reference city (~06:00, when travel is
    // easiest) sits compactly inside the small 60-min ring; the 120-min
    // ring touches the screen edge, so the night stretch runs off-screen.
    rScale = (0.48 * Math.min(W, H)) / 120;
  }
  resize();
  window.addEventListener("resize", resize);

  function drawLines(lines, s0, s1, frac, style, width) {
    ctx.strokeStyle = style;
    ctx.lineWidth = width;
    ctx.beginPath();
    for (const v of lines) {
      const n = v.length / 4;
      let pen = false;
      for (let i = 0; i < n; i++) {
        const t = timeAt(s0, s1, frac, v[4 * i + 2], v[4 * i + 3]);
        if (t === UNREACHABLE || t > T_CUT) { pen = false; continue; }
        const r = t * rScale;
        const x = cx + v[4 * i] * r;
        const y = cy - v[4 * i + 1] * r;
        if (pen) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
        pen = true;
      }
    }
    ctx.stroke();
  }

  function drawRings(pulse) {
    ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.fillStyle = "#777";
    ctx.strokeStyle = "#222";
    ctx.lineWidth = 0.75;
    for (const m of RING_MINUTES) {
      const r = m * rScale;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillText(m + " min", cx + r * Math.SQRT1_2 + 4, cy - r * Math.SQRT1_2 - 4);
    }
    ctx.strokeStyle = "#c9c9c9";
    ctx.fillStyle = "#b3b3b3";
    ctx.setLineDash([2, 5]);
    for (const m of OUTER_RINGS) {
      const r = m * rScale;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillText(m + " min", cx + r * Math.SQRT1_2 + 4, cy - r * Math.SQRT1_2 - 4);
    }
    ctx.setLineDash([]);
    ctx.fillStyle = "rgba(178, 34, 34, 0.9)";
    ctx.beginPath();
    ctx.arc(cx, cy, 2.5 + 2.5 * pulse, 0, Math.PI * 2);
    ctx.fill();
  }

  // Non-uniform playback shaped into a regular heartbeat. The visual
  // change all lives in the night hours, so the flat daytime is crossed
  // quickly and the stretch out / pull in get equal, unhurried halves.
  // Anchors map animation phase -> hour of day (monotonic; 30 = 06:00).
  const ANCHORS = [
    [0.00, 6],    // rest: the compact 06:00 city
    [0.20, 21],   // fast-forward through the (visually flat) day
    [0.55, 27],   // diastole: stretch out to 03:00
    [0.62, 27.5], // hold at full stretch
    [1.00, 30],   // systole: pull back in to 06:00
  ];
  function hourAt(p) {
    for (let i = 1; i < ANCHORS.length; i++) {
      const [p0, h0] = ANCHORS[i - 1];
      const [p1, h1] = ANCHORS[i];
      if (p <= p1) return h0 + ((p - p0) / (p1 - p0)) * (h1 - h0);
    }
    return ANCHORS[ANCHORS.length - 1][1];
  }

  const t0 = performance.now();
  function frame(now) {
    const p = ((now - t0) / 1000 / DAY_SECONDS) % 1;
    const dayFrac = (hourAt(p) % 24) / 24;
    const sPos = (dayFrac * slices) % slices;
    const s0 = Math.floor(sPos);
    const s1 = (s0 + 1) % slices;
    const frac = sPos - s0;

    // Pulse peaks at full stretch (middle of the hold phase).
    const pulse = Math.pow(0.5 + 0.5 * Math.cos((p - 0.585) * 2 * Math.PI), 3);

    ctx.clearRect(0, 0, W, H);
    drawRings(pulse);
    drawLines(minor, s0, s1, frac, `rgba(178,34,34,${0.14 + 0.10 * pulse})`, 0.6);
    drawLines(major, s0, s1, frac, `rgba(178,34,34,${0.45 + 0.25 * pulse})`, 1.1);

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
