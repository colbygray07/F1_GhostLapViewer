// A small line chart for telemetry. The x axis is "how far around the lap"
// (0 to 1), so all three drivers line up at the same point on track.

const PAD = { left: 52, right: 14, top: 12, bottom: 28 };

function niceStep(range, target = 5) {
  const raw = range / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  return (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
}

export function valueAt(points, x) {
  if (!points.length) return null;
  let lo = 0;
  let hi = points.length - 1;
  if (x <= points[0].x) return points[0].y;
  if (x >= points[hi].x) return points[hi].y;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid].x < x) lo = mid;
    else hi = mid;
  }
  const a = points[lo];
  const b = points[hi];
  return a.y + ((b.y - a.y) * (x - a.x)) / (b.x - a.x || 1);
}

export class LineChart {
  constructor(canvas, { formatTick, onHover, onSeek, zeroLine = false }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.formatTick = formatTick;
    this.onHover = onHover;
    this.onSeek = onSeek;
    this.zeroLine = zeroLine;
    this.series = [];
    this.markers = [];
    this.hoverX = null;

    new ResizeObserver(() => this.resize()).observe(canvas);
    canvas.addEventListener('pointermove', (e) => {
      this.hoverX = this.eventToX(e);
      this.onHover?.(this.hoverX);
      this.draw();
    });
    canvas.addEventListener('pointerleave', () => {
      this.hoverX = null;
      this.onHover?.(null);
      this.draw();
    });
    canvas.addEventListener('click', (e) => {
      const x = this.eventToX(e);
      if (x != null) this.onSeek?.(x);
    });
  }

  eventToX(e) {
    const rect = this.canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left - PAD.left) / (rect.width - PAD.left - PAD.right);
    return x >= 0 && x <= 1 ? x : null;
  }

  setData({ series, sectorMarks }) {
    this.series = series;
    this.sectorMarks = sectorMarks;
    const ys = series.flatMap((s) => s.points.map((p) => p.y));
    let min = Math.min(...ys);
    let max = Math.max(...ys);
    if (this.zeroLine) { min = Math.min(min, 0); max = Math.max(max, 0); }
    const step = niceStep(max - min || 1);
    this.yMin = Math.floor(min / step) * step;
    this.yMax = Math.ceil(max / step) * step;
    this.yStep = step;
    this.resize();
  }

  setMarkers(xs) {
    this.markers = xs;
    this.draw();
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width) return;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(rect.width * dpr);
    this.canvas.height = Math.round(rect.height * dpr);
    this.w = rect.width;
    this.h = rect.height;
    this.dpr = dpr;
    this.draw();
  }

  sx(x) { return PAD.left + x * (this.w - PAD.left - PAD.right); }
  sy(y) { return PAD.top + (1 - (y - this.yMin) / (this.yMax - this.yMin)) * (this.h - PAD.top - PAD.bottom); }

  draw() {
    if (!this.w || !this.series.length) return;
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    ctx.font = '500 12px Barlow, system-ui, sans-serif';

    // Horizontal grid and y labels.
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let y = this.yMin; y <= this.yMax + 1e-9; y += this.yStep) {
      const py = this.sy(y);
      const isZero = this.zeroLine && Math.abs(y) < 1e-9;
      ctx.strokeStyle = isZero ? '#5A6372' : '#262C35';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(PAD.left, py);
      ctx.lineTo(this.w - PAD.right, py);
      ctx.stroke();
      ctx.fillStyle = '#8C95A2';
      ctx.fillText(this.formatTick(y), PAD.left - 8, py);
    }

    // Sector bands along the bottom.
    const marks = [0, ...(this.sectorMarks ?? []), 1];
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    for (let i = 0; i < marks.length - 1; i++) {
      if (i > 0) {
        ctx.strokeStyle = 'rgba(255, 210, 63, 0.35)';
        ctx.setLineDash([3, 4]);
        ctx.beginPath();
        ctx.moveTo(this.sx(marks[i]), PAD.top);
        ctx.lineTo(this.sx(marks[i]), this.h - PAD.bottom);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.fillStyle = '#8C95A2';
      ctx.fillText(`Sector ${i + 1}`, this.sx((marks[i] + marks[i + 1]) / 2), this.h - 8);
    }

    // Lines.
    ctx.lineJoin = 'round';
    for (const s of this.series) {
      ctx.strokeStyle = s.colour;
      ctx.lineWidth = 1.75;
      ctx.setLineDash(s.dashed ? [6, 4] : []);
      ctx.beginPath();
      s.points.forEach((p, i) => (i ? ctx.lineTo(this.sx(p.x), this.sy(p.y)) : ctx.moveTo(this.sx(p.x), this.sy(p.y))));
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // Where each car is right now.
    this.series.forEach((s, i) => {
      const x = this.markers[i];
      if (x == null) return;
      const y = valueAt(s.points, x);
      ctx.beginPath();
      ctx.arc(this.sx(x), this.sy(y), 4.5, 0, Math.PI * 2);
      ctx.fillStyle = s.dashed ? '#14181E' : s.colour;
      ctx.fill();
      ctx.strokeStyle = s.dashed ? s.colour : '#14181E';
      ctx.lineWidth = 2;
      ctx.stroke();
    });

    if (this.hoverX != null) {
      ctx.strokeStyle = 'rgba(236, 238, 241, 0.5)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(this.sx(this.hoverX), PAD.top);
      ctx.lineTo(this.sx(this.hoverX), this.h - PAD.bottom);
      ctx.stroke();
    }
  }
}