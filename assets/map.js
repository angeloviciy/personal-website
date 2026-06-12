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
  const DAY_SECONDS = 14.5; // one full beat
  const KX = Math.cos((37.77 * Math.PI) / 180); // lon -> meters correction

  // Temporal low-pass over the day: each slice becomes a [1,2,4,2,1]/10
  // blend with its neighbors (±1 h). Sampling jitter vanishes and the
  // stepped service drops of the night wind-down round off into a smooth
  // wave; the day/night cycle itself spans many slices and is untouched.
  const KERNEL = [1, 2, 4, 2, 1];
  const raw = new Uint8Array(timesBuf);
  const cells = nx * ny;
  const times = new Float32Array(raw.length);
  for (let c = 0; c < cells; c++) {
    for (let s = 0; s < slices; s++) {
      if (raw[s * cells + c] === 255) { times[s * cells + c] = 255; continue; }
      let sum = 0, w = 0;
      for (let k = -2; k <= 2; k++) {
        const v = raw[((s + k + slices) % slices) * cells + c];
        if (v !== 255) { sum += v * KERNEL[k + 2]; w += KERNEL[k + 2]; }
      }
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
  // Unreachable samples become a phantom time whose radius lies beyond
  // the screen diagonal (set in resize), so streets never vanish in
  // place: they fly off the screen and glide back in.
  let phantomT = 999;
  function timeAt(s0, s1, frac, gx, gy) {
    let a = sample(s0, gx, gy);
    let b = sample(s1, gx, gy);
    if (a === UNREACHABLE) a = phantomT;
    if (b === UNREACHABLE) b = phantomT;
    return a + (b - a) * frac;
  }

  // --- Layout ---
  let W, H, cx, cy, rScale, segBreakSq;
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
    // Unreachable vertices park just beyond the screen diagonal, so the
    // exit is always completed out of view, on any aspect ratio.
    phantomT = Math.hypot(W, H) / 2 / rScale + 15;
    // A single street segment stretched longer than this is a line
    // straddling the reachability frontier — break it rather than draw
    // a radial streak across the screen.
    const segBreak = 0.2 * Math.min(W, H);
    segBreakSq = segBreak * segBreak;
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
      let px = 0, py = 0;
      for (let i = 0; i < n; i++) {
        const t = timeAt(s0, s1, frac, v[4 * i + 2], v[4 * i + 3]);
        const r = t * rScale;
        const x = cx + v[4 * i] * r;
        const y = cy - v[4 * i + 1] * r;
        const dx = x - px, dy = y - py;
        if (pen && dx * dx + dy * dy < segBreakSq) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
        pen = true;
        px = x;
        py = y;
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

  // Playback shaped into a heartbeat from the night's two real arcs: the
  // evening wind-down (21:00 -> 03:00) plays as the expansion, and the
  // actual dawn wake-up (03:00 -> 06:00) plays as the contraction — so the
  // return is not a mirrored replay but the city's own morning, with its
  // late drift and sudden rush home as service resumes. The flat daytime
  // is never played (the rest frame at 21:00 and the end frame at 06:00
  // look identical), so no midday tremor exists. Brief rests, equal-speed
  // motions. Segments: [pStart, pEnd, hourStart, hourEnd] (24+h = next day).
  const SEGMENTS = [
    [0.00, 0.04, 21, 21],  // rest, fully in (still frame)
    [0.04, 0.50, 21, 27],  // diastole: stretch out through the real evening
    [0.50, 0.54, 27, 27],  // hold, fully out
    [0.54, 1.00, 27, 30],  // systole: contract through the real dawn
  ];
  // Smootherstep: zero velocity AND zero acceleration at both ends, so
  // each motion swells from stillness and settles back without any jerk.
  function ease(u) {
    return u * u * u * (u * (u * 6 - 15) + 10);
  }
  function hourAt(p) {
    for (const [p0, p1, h0, h1] of SEGMENTS) {
      if (p <= p1) return h0 + (h1 - h0) * ease((p - p0) / (p1 - p0));
    }
    return 21;
  }

  const t0 = performance.now();
  const REST_END = SEGMENTS[0][1];
  const SLICE_06 = 12, SLICE_21 = 42; // 06:00 and 21:00, the two "in" poles
  function frame(now) {
    const p = ((now - t0) / 1000 / DAY_SECONDS) % 1;
    let s0, s1, frac;
    if (p < REST_END) {
      // Rest phase doubles as the seam: a direct crossfade from the dawn
      // arrival state (06:00) to the evening departure state (21:00).
      // The two are nearly identical, so this reads as stillness — but it
      // removes the once-per-beat snap the hard loop restart used to have.
      s0 = SLICE_06;
      s1 = SLICE_21;
      frac = ease(p / REST_END);
    } else {
      const dayFrac = (hourAt(p) % 24) / 24;
      const sPos = (dayFrac * slices) % slices;
      s0 = Math.floor(sPos);
      s1 = (s0 + 1) % slices;
      frac = sPos - s0;
    }

    // Pulse peaks at full stretch (middle of the hold phase).
    const pulse = Math.pow(0.5 + 0.5 * Math.cos((p - 0.52) * 2 * Math.PI), 3);

    ctx.clearRect(0, 0, W, H);
    drawRings(pulse);
    drawLines(minor, s0, s1, frac, `rgba(178,34,34,${0.14 + 0.10 * pulse})`, 0.6);
    drawLines(major, s0, s1, frac, `rgba(178,34,34,${0.45 + 0.25 * pulse})`, 1.1);

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
