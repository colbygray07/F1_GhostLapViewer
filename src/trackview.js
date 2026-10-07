// Draws the circuit and the three cars on a <canvas>.
// The track itself is drawn once into an offscreen canvas; each frame only
// redraws the cars on top of it.

const TRAIL_MS = 1400;

function readableText(hex) {
  const v = parseInt(hex.replace('#', ''), 16);
  const r = (v >> 16) & 255;
  const g = (v >> 8) & 255;
  const b = v & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? '#14181E' : '#FFFFFF';
}

export class TrackView {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.base = document.createElement('canvas');
    this.drivers = [];
    this.outline = [];
    this.t = 0;
    new ResizeObserver(() => this.resize()).observe(canvas);
  }

  setData({ drivers, rotation, sectorTimes, circuit }) {
    this.drivers = drivers;
    // Official outline and orientation when we have them, else the fastest car's path.
    this.outline = circuit?.outline ?? drivers[0].outline;
    this.fixedRotation = circuit ? circuit.rotation : rotation;
    this.corners = circuit?.corners ?? [];
    this.metresPerUnit = drivers[0].metresPerUnit;
    const ref = drivers[0];
    this.sectorPoints = sectorTimes.map((t) => ({ a: ref.posAt(t), b: ref.posAt(t + 150) }));
    this.resize();
  }

  // Pick the rotation that lets the track fill the canvas best.
  bestRotation(width, height) {
    if (this.fixedRotation != null) return (this.fixedRotation * Math.PI) / 180;
    const pts = this.outline.filter((_, i) => i % 6 === 0);
    let best = { angle: 0, scale: 0 };
    for (let deg = 0; deg < 180; deg += 3) {
      const a = (deg * Math.PI) / 180;
      const cos = Math.cos(a);
      const sin = Math.sin(a);
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const p of pts) {
        const x = p.x * cos - p.y * sin;
        const y = p.x * sin + p.y * cos;
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      }
      const scale = Math.min(width / (maxX - minX), height / (maxY - minY));
      if (scale > best.scale) best = { angle: a, scale };
    }
    return best.angle;
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width || !this.outline.length) return;
    const dpr = window.devicePixelRatio || 1;
    this.w = rect.width;
    this.h = rect.height;
    for (const c of [this.canvas, this.base]) {
      c.width = Math.round(rect.width * dpr);
      c.height = Math.round(rect.height * dpr);
    }
    this.dpr = dpr;

    const pad = Math.max(44, Math.min(this.w, this.h) * 0.09);
    const angle = this.bestRotation(this.w - pad * 2, this.h - pad * 2);
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const rotated = this.outline.map((p) => ({ x: p.x * cos - p.y * sin, y: p.x * sin + p.y * cos }));
    const xs = rotated.map((p) => p.x);
    const ys = rotated.map((p) => p.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const scale = Math.min((this.w - pad * 2) / (maxX - minX), (this.h - pad * 2) / (maxY - minY));
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;

    // World coordinates (OpenF1 x/y) to screen pixels. Screen y points down.
    this.toScreen = (p) => {
      const x = p.x * cos - p.y * sin;
      const y = p.x * sin + p.y * cos;
      return { x: (x - cx) * scale + this.w / 2, y: -(y - cy) * scale + this.h / 2 };
    };
    this.trackWidth = Math.max(9, Math.min(this.w, this.h) * 0.024);
    this.drawBase();
    this.draw(this.t);
  }

  drawBase() {
    const ctx = this.base.getContext('2d');
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    const pts = this.outline.map(this.toScreen);

    const path = new Path2D();
    pts.forEach((p, i) => (i ? path.lineTo(p.x, p.y) : path.moveTo(p.x, p.y)));
    path.closePath();

    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    // Soft shadow under the track, then the edge lines, then the asphalt.
    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.6)';
    ctx.shadowBlur = 18;
    ctx.strokeStyle = '#3A4250';
    ctx.lineWidth = this.trackWidth + 6;
    ctx.stroke(path);
    ctx.restore();
    ctx.strokeStyle = '#C9CED6';
    ctx.lineWidth = this.trackWidth + 2;
    ctx.stroke(path);
    ctx.strokeStyle = '#272D36';
    ctx.lineWidth = this.trackWidth;
    ctx.stroke(path);

    // Sector boundaries.
    const labels = ['S2', 'S3'];
    this.sectorPoints.forEach(({ a, b }, i) => {
      this.drawTick(ctx, this.toScreen(a), this.toScreen(b), '#FFD23F', 2);
      const pa = this.toScreen(a);
      ctx.fillStyle = '#FFD23F';
      ctx.font = '600 12px Barlow, system-ui, sans-serif';
      ctx.fillText(labels[i], pa.x + this.trackWidth, pa.y - this.trackWidth);
    });

    // Chequered start/finish line.
    this.drawChequer(ctx, pts[0], pts[Math.min(4, pts.length - 1)]);

    // Corner numbers, offset from the track in the direction the data suggests.
    const offset = 45 / (this.metresPerUnit || 0.1);
    ctx.font = '700 11px Barlow, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const c of this.corners) {
      const a = (c.angle * Math.PI) / 180;
      const on = this.toScreen({ x: c.x, y: c.y });
      const at = this.toScreen({ x: c.x + offset * Math.cos(a), y: c.y + offset * Math.sin(a) });
      ctx.strokeStyle = 'rgba(140, 149, 162, 0.6)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(on.x, on.y);
      ctx.lineTo(at.x, at.y);
      ctx.stroke();
      ctx.fillStyle = '#2C333D';
      ctx.beginPath();
      ctx.arc(at.x, at.y, 10, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#ECEEF1';
      ctx.fillText(c.label, at.x, at.y + 0.5);
    }
    ctx.textAlign = 'start';
    ctx.textBaseline = 'alphabetic';
  }

  drawTick(ctx, a, b, colour, width) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    const half = this.trackWidth * 0.95;
    ctx.strokeStyle = colour;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(a.x - nx * half, a.y - ny * half);
    ctx.lineTo(a.x + nx * half, a.y + ny * half);
    ctx.stroke();
  }

  drawChequer(ctx, a, b) {
    const angle = Math.atan2(b.y - a.y, b.x - a.x);
    const cell = this.trackWidth / 3;
    ctx.save();
    ctx.translate(a.x, a.y);
    ctx.rotate(angle);
    for (let col = 0; col < 2; col++) {
      for (let row = 0; row < 3; row++) {
        ctx.fillStyle = (row + col) % 2 ? '#14181E' : '#F2F2F2';
        ctx.fillRect(col * cell - cell, row * cell - this.trackWidth / 2, cell, cell);
      }
    }
    ctx.restore();
  }

  draw(t) {
    this.t = t;
    if (!this.toScreen) return;
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.drawImage(this.base, 0, 0);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    const cars = this.drivers.map((d) => ({ d, p: this.toScreen(d.posAt(Math.min(t, d.duration))) }));

    // Trails first so every car sits on top of every trail.
    for (const { d } of cars) {
      const pts = d.trail(Math.min(t, d.duration), TRAIL_MS).map(this.toScreen);
      ctx.lineCap = 'round';
      ctx.lineWidth = this.trackWidth * 0.42;
      ctx.strokeStyle = d.colour;
      for (let i = 1; i < pts.length; i++) {
        ctx.globalAlpha = (i / pts.length) * 0.7;
        ctx.beginPath();
        ctx.moveTo(pts[i - 1].x, pts[i - 1].y);
        ctx.lineTo(pts[i].x, pts[i].y);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    // Draw the leader last so it stays on top.
    const r = Math.max(6, this.trackWidth * 0.55);
    for (const { d, p } of [...cars].reverse()) {
      // Glow in the team colour so each car pops off the track.
      ctx.save();
      ctx.shadowColor = d.colour;
      ctx.shadowBlur = 14;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = d.ring ? 'rgba(0,0,0,0)' : d.colour;
      ctx.fill();
      ctx.restore();
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      if (d.ring) {
        ctx.fillStyle = '#14181E';
        ctx.fill();
        ctx.lineWidth = 3;
        ctx.strokeStyle = d.colour;
        ctx.stroke();
      } else {
        ctx.fillStyle = d.colour;
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#14181E';
        ctx.stroke();
      }
    }

    this.drawLabels(ctx, cars, r);
  }

  // Name tags, nudged apart so they never overlap.
  drawLabels(ctx, cars, r) {
    ctx.font = '700 13px Barlow, system-ui, sans-serif';
    const placed = [];
    for (const { d, p } of cars) {
      const w = ctx.measureText(d.acronym).width + 12;
      const h = 20;
      let x = p.x + r + 6;
      let y = p.y - r - h;
      if (x + w > this.w - 4) x = p.x - r - 6 - w;
      let guard = 0;
      while (placed.some((b) => x < b.x + b.w && x + w > b.x && y < b.y + b.h && y + h > b.y) && guard++ < 6) {
        y += h + 3;
      }
      placed.push({ x, y, w, h });
      ctx.fillStyle = d.ring ? '#14181E' : d.colour;
      ctx.strokeStyle = d.colour;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, 4);
      ctx.fill();
      if (d.ring) ctx.stroke();
      ctx.fillStyle = d.ring ? d.colour : readableText(d.colour);
      ctx.textBaseline = 'middle';
      ctx.fillText(d.acronym, x + 6, y + h / 2 + 1);
      ctx.textBaseline = 'alphabetic';
    }
  }
}