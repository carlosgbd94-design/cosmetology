import React, { useState, useRef, useEffect, useLayoutEffect, useId } from 'react';
import { createPortal } from 'react-dom';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  Hand, MousePointer2, Search, ArrowUpRight, Minus, Circle, Square, Pencil, MapPin, Type, Focus, Eraser,
  Undo2, Redo2, Trash2, Download, Maximize, Minimize, Keyboard, SlidersHorizontal, Grid3x3, Columns2,
  ZoomIn, ZoomOut, ChevronLeft, ChevronRight, X, Sun, RotateCcw, Scan
} from 'lucide-react';

// ─────────────────────────────────────────────────────────────────────────────
// Visor profesional de evidencias fotográficas (antes / después).
//  · Zoom hasta ×24 (rueda, pellizco, botones, doble clic) y desplazamiento (arrastre, Espacio, clic central).
//  · Modos: comparar con deslizador, solo Antes, solo Después y lado a lado con vista sincronizada.
//  · Herramientas: puntero láser con estela, lupa, flecha, línea, círculo, rectángulo, lápiz, marcadores
//    numerados, texto, foco (atenúa todo salvo la zona) y borrador, con deshacer/rehacer.
//  · Ajustes de brillo/contraste/saturación, cuadrícula, minimapa y exportación a PNG (completa o zona visible).
// Las anotaciones viven en coordenadas de la imagen (no de la pantalla), así que siguen a la foto al hacer zoom.
// ─────────────────────────────────────────────────────────────────────────────

export type Tool = 'pan' | 'laser' | 'loupe' | 'arrow' | 'line' | 'ellipse' | 'rect' | 'pen' | 'pin' | 'text' | 'spot' | 'eraser';
type Mode = 'compare' | 'before' | 'after' | 'side';

interface Pt { x: number; y: number }
interface View { z: number; fx: number; fy: number }
interface TrailPt extends Pt { t: number }

export interface Annotation {
  id: string;
  kind: 'arrow' | 'line' | 'ellipse' | 'rect' | 'pen' | 'pin' | 'text' | 'spot';
  color: string;
  w: number;
  pts: Pt[];
  text?: string;
  n?: number;
}

export interface AnnStore { list: Annotation[]; past: Annotation[][]; future: Annotation[][] }
export type AnnStoreMap = Record<number, AnnStore>;

const MAX_Z = 24;
const UNITS = 1000; // ancho del lienzo de anotaciones; el alto es UNITS * alto/ancho de la foto
const COLORS = ['#ef4444', '#f59e0b', '#22c55e', '#3b82f6', '#ffffff', '#111827'];
const WIDTHS = [3, 6, 11];
const LASER_FADE_MS = 650;

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const uid = () => Math.random().toString(36).slice(2, 10);
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

function fitBox(sw: number, sh: number, iw: number, ih: number) {
  const s = Math.min(sw / iw, sh / ih);
  return { bw: iw * s, bh: ih * s };
}

// Mantiene la foto cubriendo la ventana: si cabe entera en un eje se centra, si no, no deja huecos.
function clampView(v: View, sw: number, sh: number, bw: number, bh: number): View {
  const z = clamp(v.z, 1, MAX_Z);
  const hx = sw / (2 * z * bw);
  const hy = sh / (2 * z * bh);
  return {
    z,
    fx: hx >= 0.5 ? 0.5 : clamp(v.fx, hx, 1 - hx),
    fy: hy >= 0.5 ? 0.5 : clamp(v.fy, hy, 1 - hy)
  };
}

function luminance(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

function distToSeg(p: Pt, a: Pt, b: Pt) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  if (l2 === 0) return dist(p, a);
  const t = clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / l2, 0, 1);
  return dist(p, { x: a.x + t * dx, y: a.y + t * dy });
}

const fontUnits = (w: number) => 14 + w * 4;

function hitTest(a: Annotation, p: Pt, tol: number): boolean {
  const [p0, p1] = a.pts;
  switch (a.kind) {
    case 'pen':
      for (let i = 1; i < a.pts.length; i++) if (distToSeg(p, a.pts[i - 1], a.pts[i]) <= tol + a.w) return true;
      return a.pts.length === 1 && dist(p, p0) <= tol + a.w;
    case 'line':
    case 'arrow':
      return !!p1 && distToSeg(p, p0, p1) <= tol + a.w;
    case 'rect': {
      if (!p1) return false;
      const x0 = Math.min(p0.x, p1.x), x1 = Math.max(p0.x, p1.x), y0 = Math.min(p0.y, p1.y), y1 = Math.max(p0.y, p1.y);
      const inside = p.x >= x0 - tol && p.x <= x1 + tol && p.y >= y0 - tol && p.y <= y1 + tol;
      const innerOut = p.x < x0 + tol || p.x > x1 - tol || p.y < y0 + tol || p.y > y1 - tol;
      return inside && innerOut;
    }
    case 'ellipse': {
      if (!p1) return false;
      const cx = (p0.x + p1.x) / 2, cy = (p0.y + p1.y) / 2;
      const rx = Math.max(Math.abs(p1.x - p0.x) / 2, 1), ry = Math.max(Math.abs(p1.y - p0.y) / 2, 1);
      const d = Math.hypot((p.x - cx) / rx, (p.y - cy) / ry);
      return Math.abs(d - 1) * Math.min(rx, ry) <= tol + a.w;
    }
    case 'spot':
      return !!p1 && dist(p, p0) <= dist(p0, p1);
    case 'pin':
      return dist(p, p0) <= 14 + a.w * 1.2 + tol;
    case 'text': {
      const f = fontUnits(a.w);
      const len = (a.text || '').length * f * 0.58;
      return p.x >= p0.x - tol && p.x <= p0.x + len + tol && p.y >= p0.y - f - tol && p.y <= p0.y + f * 0.3 + tol;
    }
  }
}

function renumberPins(list: Annotation[]): Annotation[] {
  let n = 0;
  return list.map(a => (a.kind === 'pin' ? { ...a, n: ++n } : a));
}

// ── Render de anotaciones (SVG en unidades de imagen) ───────────────────────

function pathFromPoints(pts: Pt[]) {
  if (pts.length === 1) return `M ${pts[0].x} ${pts[0].y} l 0.01 0`;
  if (pts.length === 2) return `M ${pts[0].x} ${pts[0].y} L ${pts[1].x} ${pts[1].y}`;
  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i].x + pts[i + 1].x) / 2, my = (pts[i].y + pts[i + 1].y) / 2;
    d += ` Q ${pts[i].x} ${pts[i].y} ${mx} ${my}`;
  }
  const last = pts[pts.length - 1];
  return d + ` L ${last.x} ${last.y}`;
}

function Shape({ a }: { a: Annotation }) {
  const [p0, p1] = a.pts;
  const stroke = (color: string, w: number) => ({ stroke: color, strokeWidth: w, fill: 'none', strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const });
  const HALO = 'rgba(0,0,0,0.45)';
  const haloW = a.w + 2.5;

  switch (a.kind) {
    case 'pen': {
      const d = pathFromPoints(a.pts);
      return <g><path d={d} {...stroke(HALO, haloW)} /><path d={d} {...stroke(a.color, a.w)} /></g>;
    }
    case 'line':
      if (!p1) return null;
      return <g><line x1={p0.x} y1={p0.y} x2={p1.x} y2={p1.y} {...stroke(HALO, haloW)} /><line x1={p0.x} y1={p0.y} x2={p1.x} y2={p1.y} {...stroke(a.color, a.w)} /></g>;
    case 'arrow': {
      if (!p1) return null;
      const ang = Math.atan2(p1.y - p0.y, p1.x - p0.x);
      const len = dist(p0, p1);
      const hl = Math.min(Math.max(22, a.w * 5), len * 0.8);
      const bx = p1.x - Math.cos(ang) * hl * 0.7, by = p1.y - Math.sin(ang) * hl * 0.7;
      const head = [
        `${p1.x},${p1.y}`,
        `${p1.x - hl * Math.cos(ang - 0.45)},${p1.y - hl * Math.sin(ang - 0.45)}`,
        `${p1.x - hl * Math.cos(ang + 0.45)},${p1.y - hl * Math.sin(ang + 0.45)}`
      ].join(' ');
      return (
        <g>
          <line x1={p0.x} y1={p0.y} x2={bx} y2={by} {...stroke(HALO, haloW)} />
          <polygon points={head} fill={HALO} stroke={HALO} strokeWidth={2.5} strokeLinejoin="round" />
          <line x1={p0.x} y1={p0.y} x2={bx} y2={by} {...stroke(a.color, a.w)} />
          <polygon points={head} fill={a.color} stroke={a.color} strokeWidth={1} strokeLinejoin="round" />
        </g>
      );
    }
    case 'rect': {
      if (!p1) return null;
      const r = { x: Math.min(p0.x, p1.x), y: Math.min(p0.y, p1.y), width: Math.abs(p1.x - p0.x), height: Math.abs(p1.y - p0.y), rx: 2 };
      return <g><rect {...r} {...stroke(HALO, haloW)} /><rect {...r} {...stroke(a.color, a.w)} /></g>;
    }
    case 'ellipse': {
      if (!p1) return null;
      const e = { cx: (p0.x + p1.x) / 2, cy: (p0.y + p1.y) / 2, rx: Math.abs(p1.x - p0.x) / 2, ry: Math.abs(p1.y - p0.y) / 2 };
      return <g><ellipse {...e} {...stroke(HALO, haloW)} /><ellipse {...e} {...stroke(a.color, a.w)} /></g>;
    }
    case 'pin': {
      const r = 14 + a.w * 1.2;
      const dark = luminance(a.color) > 0.55;
      return (
        <g>
          <circle cx={p0.x} cy={p0.y} r={r} fill={a.color} stroke={dark ? '#111827' : '#ffffff'} strokeWidth={3} />
          <text x={p0.x} y={p0.y} fontSize={r * 1.15} fontWeight={800} fontFamily="Arial, Helvetica, sans-serif" fill={dark ? '#111827' : '#ffffff'} textAnchor="middle" dominantBaseline="central">{a.n}</text>
        </g>
      );
    }
    case 'text':
      return (
        <text x={p0.x} y={p0.y} fontSize={fontUnits(a.w)} fontWeight={700} fontFamily="Arial, Helvetica, sans-serif" fill={a.color} stroke={luminance(a.color) > 0.5 ? 'rgba(0,0,0,0.75)' : 'rgba(255,255,255,0.85)'} strokeWidth={fontUnits(a.w) * 0.14} paintOrder="stroke" strokeLinejoin="round">
          {a.text}
        </text>
      );
    default:
      return null;
  }
}

function AnnotationsSvg({ anns, H, maskId, standalone, px }: { anns: Annotation[]; H: number; maskId: string; standalone?: boolean; px?: number }) {
  const spots = anns.filter(a => a.kind === 'spot' && a.pts.length > 1);
  const rest = anns.filter(a => a.kind !== 'spot');
  const sizing = standalone
    ? { xmlns: 'http://www.w3.org/2000/svg', width: px, height: (px || UNITS) * H / UNITS }
    : { style: { position: 'absolute' as const, inset: 0, width: '100%', height: '100%', pointerEvents: 'none' as const, overflow: 'visible' as const } };
  return (
    <svg viewBox={`0 0 ${UNITS} ${H}`} preserveAspectRatio="none" {...sizing}>
      {spots.length > 0 && (
        <>
          <defs>
            <mask id={maskId}>
              <rect x={0} y={0} width={UNITS} height={H} fill="#fff" />
              {spots.map(s => <circle key={s.id} cx={s.pts[0].x} cy={s.pts[0].y} r={dist(s.pts[0], s.pts[1])} fill="#000" />)}
            </mask>
          </defs>
          <rect x={0} y={0} width={UNITS} height={H} fill="rgba(0,0,0,0.62)" mask={`url(#${maskId})`} />
          {spots.map(s => <circle key={'o' + s.id} cx={s.pts[0].x} cy={s.pts[0].y} r={dist(s.pts[0], s.pts[1])} fill="none" stroke="rgba(255,255,255,0.85)" strokeWidth={2} strokeDasharray="8 6" />)}
        </>
      )}
      {rest.map(a => <Shape key={a.id} a={a} />)}
    </svg>
  );
}

// ── Capas de contenido (fotos + anotaciones) ────────────────────────────────

interface LayersProps {
  before?: string; after?: string;
  layout: 'compare' | 'before' | 'after';
  bw: number; bh: number; tx: number; ty: number; z: number;
  filter: string; anns: Annotation[]; H: number; grid: boolean; sliderPos: number; maskId: string;
}

function Layers({ before, after, layout, bw, bh, tx, ty, z, filter, anns, H, grid, sliderPos, maskId }: LayersProps) {
  const imgStyle: React.CSSProperties = { position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain', pointerEvents: 'none', userSelect: 'none', filter };
  const showAfter = layout === 'after' || (layout === 'compare' && !!after);
  const showBefore = layout === 'before' || (layout === 'compare' && !!before);
  const clipBefore = layout === 'compare' && !!after && !!before;
  return (
    <div style={{ position: 'absolute', left: 0, top: 0, width: bw, height: bh, transform: `translate(${tx}px, ${ty}px) scale(${z})`, transformOrigin: '0 0' }}>
      {showAfter && after && <img src={after} alt="Después" draggable={false} style={imgStyle} />}
      {showBefore && before && <img src={before} alt="Antes" draggable={false} style={{ ...imgStyle, clipPath: clipBefore ? `inset(0 ${(1 - sliderPos) * 100}% 0 0)` : undefined }} />}
      {grid && (
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
          {[25, 50, 75].map(p => (
            <React.Fragment key={p}>
              <line x1={p} y1={0} x2={p} y2={100} stroke="rgba(255,255,255,0.45)" strokeWidth={p === 50 ? 1.6 : 1} vectorEffect="non-scaling-stroke" strokeDasharray={p === 50 ? undefined : '4 4'} />
              <line x1={0} y1={p} x2={100} y2={p} stroke="rgba(255,255,255,0.45)" strokeWidth={p === 50 ? 1.6 : 1} vectorEffect="non-scaling-stroke" strokeDasharray={p === 50 ? undefined : '4 4'} />
            </React.Fragment>
          ))}
        </svg>
      )}
      <AnnotationsSvg anns={anns} H={H} maskId={maskId} />
    </div>
  );
}

// ── Escenario interactivo (zoom, desplazamiento, dibujo) ────────────────────

interface StageProps {
  before?: string; after?: string;
  layout: 'compare' | 'before' | 'after';
  iw: number; ih: number;
  view: View; onView: (v: View) => void;
  tool: Tool; color: string; width: number; spaceHeld: boolean;
  anns: Annotation[]; draft: Annotation | null;
  onDraft: (d: Annotation | null) => void;
  onCommit: (a: Annotation) => void;
  onErase: (id: string) => void;
  pinCount: number;
  laser: Pt | null; trail: TrailPt[]; onLaser: (p: Pt | null) => void;
  sliderPos: number; onSlider: (n: number) => void;
  filter: string; grid: boolean; loupeMag: number;
  showMinimap: boolean; badge?: string;
  onSize?: (w: number, h: number) => void;
}

function Stage(props: StageProps) {
  const { before, after, layout, iw, ih, view, tool, color, width, spaceHeld, anns, draft, laser, trail, sliderPos, filter, grid, loupeMag, showMinimap, badge } = props;
  const L = useRef(props);
  L.current = props;

  const rootRef = useRef<HTMLDivElement>(null);
  const sizeRef = useRef({ w: 0, h: 0 });
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [loupe, setLoupe] = useState<Pt | null>(null);
  const [textEdit, setTextEdit] = useState<{ x: number; y: number; value: string } | null>(null);
  const [panning, setPanning] = useState(false);
  const maskBase = useId().replace(/:/g, '');

  const pointers = useRef(new Map<number, Pt>());
  const gesture = useRef<
    | null
    | { type: 'pan'; p0: Pt; fx0: number; fy0: number }
    | { type: 'pinch'; d0: number; z0: number; ux0: number; uy0: number }
    | { type: 'text'; u: Pt } | { type: 'draw' } | { type: 'erase' } | { type: 'laser' } | { type: 'loupe' } | { type: 'slider' } | { type: 'mini' }
  >(null);

  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const update = () => {
      const r = el.getBoundingClientRect();
      sizeRef.current = { w: r.width, h: r.height };
      setSize({ w: r.width, h: r.height });
      L.current.onSize?.(r.width, r.height);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const H = UNITS * ih / iw;

  // Geometría vigente, calculada siempre con las props más recientes (los manejadores de eventos viven mucho).
  const geom = () => {
    const { w: sw, h: sh } = sizeRef.current;
    const { bw, bh } = fitBox(Math.max(sw, 1), Math.max(sh, 1), L.current.iw, L.current.ih);
    const v = clampView(L.current.view, sw, sh, bw, bh);
    return { sw, sh, bw, bh, v, tx: sw / 2 - v.z * v.fx * bw, ty: sh / 2 - v.z * v.fy * bh, H: UNITS * L.current.ih / L.current.iw };
  };
  const local = (e: { clientX: number; clientY: number }): Pt => {
    const r = rootRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const toUnit = (p: Pt, clampIt = true): Pt => {
    const g = geom();
    const x = ((p.x - g.tx) / (g.v.z * g.bw)) * UNITS;
    const y = ((p.y - g.ty) / (g.v.z * g.bh)) * g.H;
    return clampIt ? { x: clamp(x, 0, UNITS), y: clamp(y, 0, g.H) } : { x, y };
  };
  const setView = (v: View) => {
    const g = geom();
    L.current.onView(clampView(v, g.sw, g.sh, g.bw, g.bh));
  };
  const zoomAt = (p: Pt, newZ: number) => {
    const g = geom();
    const nz = clamp(newZ, 1, MAX_Z);
    const ux = (p.x - g.tx) / (g.v.z * g.bw);
    const uy = (p.y - g.ty) / (g.v.z * g.bh);
    setView({ z: nz, fx: ux - (p.x - g.sw / 2) / (nz * g.bw), fy: uy - (p.y - g.sh / 2) / (nz * g.bh) });
  };

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      const g = geom();
      zoomAt(local(e), g.v.z * Math.exp(-dy * (e.ctrlKey ? 0.006 : 0.002)));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const constrain = (kind: Annotation['kind'], a: Pt, b: Pt, shift: boolean): Pt => {
    if (!shift) return b;
    if (kind === 'line' || kind === 'arrow') {
      const ang = Math.round(Math.atan2(b.y - a.y, b.x - a.x) / (Math.PI / 4)) * (Math.PI / 4);
      const d = dist(a, b);
      return { x: a.x + Math.cos(ang) * d, y: a.y + Math.sin(ang) * d };
    }
    if (kind === 'rect' || kind === 'ellipse') {
      const s = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      return { x: a.x + Math.sign(b.x - a.x || 1) * s, y: a.y + Math.sign(b.y - a.y || 1) * s };
    }
    return b;
  };

  const eraseAt = (p: Pt) => {
    const u = toUnit(p, false);
    const list = L.current.anns;
    for (let i = list.length - 1; i >= 0; i--) {
      if (hitTest(list[i], u, 10)) { L.current.onErase(list[i].id); return; }
    }
  };

  const textRef = useRef(textEdit);
  textRef.current = textEdit;
  const commitText = () => {
    const prev = textRef.current;
    if (!prev) return;
    textRef.current = null;
    setTextEdit(null);
    if (prev.value.trim()) {
      L.current.onCommit({ id: uid(), kind: 'text', color: L.current.color, w: L.current.width, pts: [{ x: prev.x, y: prev.y }], text: prev.value.trim() });
    }
  };

  const onPointerDown = (e: React.PointerEvent) => {
    const p = local(e);
    rootRef.current!.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, p);

    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      const g = geom();
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      L.current.onDraft(null);
      setLoupe(null);
      gesture.current = {
        type: 'pinch', d0: Math.max(dist(a, b), 1), z0: g.v.z,
        ux0: (mid.x - g.tx) / (g.v.z * g.bw), uy0: (mid.y - g.ty) / (g.v.z * g.bh)
      };
      return;
    }
    if (pointers.current.size > 2) return;

    const t = L.current.tool;
    if (textEdit) commitText();

    const g = geom();
    if (e.button === 1 || e.button === 2 || L.current.spaceHeld || t === 'pan') {
      gesture.current = { type: 'pan', p0: p, fx0: g.v.fx, fy0: g.v.fy };
      setPanning(true);
      return;
    }
    const u = toUnit(p);
    const base = { id: uid(), color: L.current.color, w: L.current.width };

    switch (t) {
      case 'laser':
        gesture.current = { type: 'laser' };
        L.current.onLaser(u);
        break;
      case 'loupe':
        gesture.current = { type: 'loupe' };
        setLoupe(p);
        break;
      case 'eraser':
        gesture.current = { type: 'erase' };
        eraseAt(p);
        break;
      case 'pin':
        L.current.onCommit({ ...base, kind: 'pin', pts: [u], n: L.current.pinCount + 1 });
        break;
      case 'text':
        // El campo se abre al soltar: si se creara ahora, el foco por defecto del clic lo cerraría.
        gesture.current = { type: 'text', u };
        break;
      case 'pen':
        gesture.current = { type: 'draw' };
        L.current.onDraft({ ...base, kind: 'pen', pts: [u] });
        break;
      default:
        gesture.current = { type: 'draw' };
        L.current.onDraft({ ...base, kind: t as Annotation['kind'], pts: [u, u] });
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const p = local(e);
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, p);
    const gs = gesture.current;
    const g = geom();
    const t = L.current.tool;

    if (gs?.type === 'pinch' && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const nz = clamp(gs.z0 * dist(a, b) / gs.d0, 1, MAX_Z);
      setView({ z: nz, fx: gs.ux0 - (mid.x - g.sw / 2) / (nz * g.bw), fy: gs.uy0 - (mid.y - g.sh / 2) / (nz * g.bh) });
      return;
    }
    if (gs?.type === 'pan') {
      setView({ z: g.v.z, fx: gs.fx0 - (p.x - gs.p0.x) / (g.v.z * g.bw), fy: gs.fy0 - (p.y - gs.p0.y) / (g.v.z * g.bh) });
      return;
    }
    if (gs?.type === 'draw' && L.current.draft) {
      const d = L.current.draft;
      const u = toUnit(p);
      if (d.kind === 'pen') {
        const last = d.pts[d.pts.length - 1];
        if (dist(last, u) >= 1.5) L.current.onDraft({ ...d, pts: [...d.pts, u] });
      } else {
        L.current.onDraft({ ...d, pts: [d.pts[0], constrain(d.kind, d.pts[0], u, e.shiftKey)] });
      }
      return;
    }
    if (gs?.type === 'erase') { eraseAt(p); return; }
    if (gs?.type === 'slider') return;

    // Movimiento sin botón (ratón) o arrastre con laser / lupa.
    if (t === 'laser' && (gs?.type === 'laser' || e.pointerType === 'mouse')) L.current.onLaser(toUnit(p));
    if (t === 'loupe' && (gs?.type === 'loupe' || e.pointerType === 'mouse')) setLoupe(p);
  };

  const endPointer = (e: React.PointerEvent) => {
    const gs = gesture.current;
    pointers.current.delete(e.pointerId);
    if (gs?.type === 'text') setTextEdit({ x: gs.u.x, y: gs.u.y, value: '' });
    if (gs?.type === 'draw') {
      const d = L.current.draft;
      if (d) {
        const ok = d.kind === 'pen'
          ? d.pts.length >= 2 && d.pts.reduce((s, q, i) => (i ? s + dist(q, d.pts[i - 1]) : 0), 0) > 4
          : dist(d.pts[0], d.pts[1]) > 5;
        if (ok) L.current.onCommit(d);
        L.current.onDraft(null);
      }
    }
    if (gs?.type === 'pinch') {
      if (pointers.current.size < 2) gesture.current = null;
    } else {
      gesture.current = null;
    }
    setPanning(false);
    if (e.pointerType !== 'mouse') {
      if (L.current.tool === 'laser') L.current.onLaser(null);
      if (L.current.tool === 'loupe') setLoupe(null);
    }
  };

  const onPointerLeave = (e: React.PointerEvent) => {
    if (e.pointerType === 'mouse' && !gesture.current) {
      L.current.onLaser(null);
      setLoupe(null);
    }
  };

  // ── derivados de render ──
  const { w: sw, h: sh } = size;
  const ready = sw > 0 && sh > 0;
  const { bw, bh } = fitBox(Math.max(sw, 1), Math.max(sh, 1), iw, ih);
  const v = clampView(view, sw, sh, bw, bh);
  const tx = sw / 2 - v.z * v.fx * bw;
  const ty = sh / 2 - v.z * v.fy * bh;
  const toScreen = (p: Pt): Pt => ({ x: tx + v.z * (p.x / UNITS) * bw, y: ty + v.z * (p.y / H) * bh });

  const sliderActive = layout === 'compare' && !!before && !!after;
  const sliderX = tx + v.z * bw * sliderPos;
  const lineTop = Math.max(0, ty), lineBottom = Math.min(sh, ty + v.z * bh);

  const startSlider = (e: React.PointerEvent) => {
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    gesture.current = { type: 'slider' };
  };
  const moveSlider = (e: React.PointerEvent) => {
    if (gesture.current?.type !== 'slider') return;
    const g = geom();
    L.current.onSlider(clamp((local(e).x - g.tx) / (g.v.z * g.bw), 0, 1));
  };
  const endSlider = (e: React.PointerEvent) => {
    e.stopPropagation();
    if (gesture.current?.type === 'slider') gesture.current = null;
  };

  const drawAnns = draft ? [...anns, draft] : anns;
  const cursor = panning ? 'grabbing'
    : spaceHeld || tool === 'pan' ? 'grab'
    : tool === 'text' ? 'text'
    : tool === 'loupe' || tool === 'laser' ? 'none'
    : 'crosshair';

  const LS = 168;
  const loupeNode = tool === 'loupe' && loupe && ready && (
    <div style={{ position: 'absolute', left: loupe.x - LS / 2, top: loupe.y - LS / 2, width: LS, height: LS, borderRadius: '50%', overflow: 'hidden', border: '3px solid #fff', boxShadow: '0 8px 30px rgba(0,0,0,0.6), 0 0 0 1px rgba(0,0,0,0.5)', background: '#000', pointerEvents: 'none', zIndex: 30 }}>
      <Layers
        before={before} after={after} layout={layout} bw={bw} bh={bh}
        tx={LS / 2 + loupeMag * (tx - loupe.x)} ty={LS / 2 + loupeMag * (ty - loupe.y)} z={loupeMag * v.z}
        filter={filter} anns={drawAnns} H={H} grid={false} sliderPos={sliderPos} maskId={maskBase + 'l'}
      />
      <div style={{ position: 'absolute', left: LS / 2 - 8, top: LS / 2, width: 16, height: 1, background: 'rgba(255,255,255,0.8)' }} />
      <div style={{ position: 'absolute', left: LS / 2, top: LS / 2 - 8, width: 1, height: 16, background: 'rgba(255,255,255,0.8)' }} />
    </div>
  );

  const now = performance.now();
  const laserNode = ready && (laser || trail.length > 0) && (
    <svg width={sw} height={sh} style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 25 }}>
      {trail.map((pt, i) => {
        if (i === 0) return null;
        const a = toScreen(trail[i - 1]), b = toScreen(pt);
        const age = clamp(1 - (now - pt.t) / LASER_FADE_MS, 0, 1);
        return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={color} strokeWidth={2 + 6 * age} strokeLinecap="round" opacity={age * 0.7} />;
      })}
      {laser && (() => {
        const s = toScreen(laser);
        return (
          <g>
            <circle cx={s.x} cy={s.y} r={22} fill={color} opacity={0.18} />
            <circle cx={s.x} cy={s.y} r={11} fill={color} opacity={0.45} />
            <circle cx={s.x} cy={s.y} r={5} fill={color} stroke="#fff" strokeWidth={1.5} />
          </g>
        );
      })()}
    </svg>
  );

  // Minimapa de navegación
  const mini = showMinimap && ready && v.z > 1.02 && (() => {
    const MW = 128, MH = Math.round(MW * ih / iw);
    const hx = Math.min(0.5, sw / (2 * v.z * bw)), hy = Math.min(0.5, sh / (2 * v.z * bh));
    const src = layout === 'before' ? before : layout === 'after' ? after : (after || before);
    const setFromEvent = (e: React.PointerEvent) => {
      const r = e.currentTarget.getBoundingClientRect();
      setView({ z: geom().v.z, fx: (e.clientX - r.left) / r.width, fy: (e.clientY - r.top) / r.height });
    };
    return (
      <div
        onPointerDown={e => { e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId); gesture.current = { type: 'mini' }; setFromEvent(e); }}
        onPointerMove={e => { if (gesture.current?.type === 'mini') setFromEvent(e); }}
        onPointerUp={e => { e.stopPropagation(); if (gesture.current?.type === 'mini') gesture.current = null; }}
        className="absolute bottom-3 right-3 rounded-lg overflow-hidden border border-white/30 shadow-2xl bg-black cursor-pointer z-30"
        style={{ width: MW, height: MH, touchAction: 'none' }}
        title="Mapa de navegación"
      >
        {src && <img src={src} alt="" draggable={false} style={{ width: '100%', height: '100%', objectFit: 'contain', filter, pointerEvents: 'none', opacity: 0.85 }} />}
        <div style={{ position: 'absolute', left: `${(v.fx - hx) * 100}%`, top: `${(v.fy - hy) * 100}%`, width: `${hx * 200}%`, height: `${hy * 200}%`, border: '2px solid #f59e0b', background: 'rgba(245,158,11,0.18)', boxSizing: 'border-box', pointerEvents: 'none' }} />
      </div>
    );
  })();

  const fontPx = Math.max(14, (fontUnits(width) / UNITS) * bw * v.z);

  return (
    <div
      ref={rootRef}
      className="relative flex-1 min-w-0 min-h-0 overflow-hidden bg-[#0b0b0d] rounded-xl border border-white/10 select-none"
      style={{ touchAction: 'none', cursor }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endPointer}
      onPointerCancel={endPointer}
      onPointerLeave={onPointerLeave}
      onContextMenu={e => e.preventDefault()}
      onDoubleClick={e => {
        if (tool !== 'pan') return;
        const g = geom();
        if (g.v.z > 1.05) setView({ z: 1, fx: 0.5, fy: 0.5 }); else zoomAt(local(e), 3);
      }}
    >
      {ready && (
        <Layers
          before={before} after={after} layout={layout} bw={bw} bh={bh} tx={tx} ty={ty} z={v.z}
          filter={filter} anns={drawAnns} H={H} grid={grid} sliderPos={sliderPos} maskId={maskBase}
        />
      )}

      {badge && (
        <span className="absolute top-2 left-2 bg-slate-900/85 text-amber-400 text-[10px] font-bold px-2.5 py-1 rounded-full uppercase tracking-wider shadow-lg backdrop-blur-md z-20 pointer-events-none">{badge}</span>
      )}
      {layout === 'compare' && sliderActive && (
        <>
          <span className="absolute top-2 left-2 bg-slate-900/85 text-amber-400 text-[10px] font-bold px-2.5 py-1 rounded-full uppercase tracking-wider shadow-lg backdrop-blur-md z-20 pointer-events-none">Antes</span>
          <span className="absolute top-2 right-2 bg-amber-500/90 text-white text-[10px] font-bold px-2.5 py-1 rounded-full uppercase tracking-wider shadow-lg backdrop-blur-md z-20 pointer-events-none">Después</span>
        </>
      )}

      {sliderActive && ready && sliderX > -12 && sliderX < sw + 12 && (
        <div
          onPointerDown={startSlider} onPointerMove={moveSlider} onPointerUp={endSlider} onPointerCancel={endSlider}
          className="absolute z-20"
          style={{ left: sliderX - 11, width: 22, top: lineTop, height: Math.max(0, lineBottom - lineTop), cursor: 'ew-resize', touchAction: 'none' }}
        >
          <div className="absolute top-0 bottom-0 left-1/2 -translate-x-1/2 w-0.5 bg-white shadow-[0_0_6px_rgba(0,0,0,0.8)]" />
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-white border-2 border-amber-500 shadow-2xl flex items-center justify-center">
            <SlidersHorizontal className="w-4 h-4 text-amber-500 rotate-90" />
          </div>
        </div>
      )}

      {laserNode}
      {loupeNode}
      {mini}

      {textEdit && ready && (() => {
        const s = toScreen({ x: textEdit.x, y: textEdit.y });
        return (
          <input
            ref={el => { if (el && document.activeElement !== el) el.focus({ preventScroll: true }); }}
            value={textEdit.value}
            onChange={e => setTextEdit({ ...textEdit, value: e.target.value })}
            onKeyDown={e => {
              e.stopPropagation();
              if (e.key === 'Enter') commitText();
              if (e.key === 'Escape') setTextEdit(null);
            }}
            onBlur={commitText}
            onPointerDown={e => e.stopPropagation()}
            placeholder="Escribe y presiona Enter"
            className="absolute z-40 bg-black/40 border border-dashed border-amber-400 rounded px-1 outline-none font-bold placeholder:text-white/40 placeholder:font-normal"
            style={{ left: s.x, top: s.y - fontPx, fontSize: fontPx, color, minWidth: 160, lineHeight: 1.1 }}
          />
        );
      })()}
    </div>
  );
}

// ── Exportación ─────────────────────────────────────────────────────────────

const loadImg = (src: string) => new Promise<HTMLImageElement>((resolve, reject) => {
  const img = new Image();
  img.onload = () => resolve(img);
  img.onerror = () => reject(new Error('No se pudo cargar la imagen'));
  img.src = src;
});

async function renderPane(src: string | undefined, iw: number, ih: number, outW: number, anns: Annotation[], filter: string, label?: string) {
  const outH = Math.round(outW * ih / iw);
  const c = document.createElement('canvas');
  c.width = outW; c.height = outH;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, outW, outH);
  if (src) {
    const img = await loadImg(src);
    const s = Math.min(outW / img.naturalWidth, outH / img.naturalHeight);
    const w = img.naturalWidth * s, h = img.naturalHeight * s;
    ctx.filter = filter;
    ctx.drawImage(img, (outW - w) / 2, (outH - h) / 2, w, h);
    ctx.filter = 'none';
  }
  if (anns.length) {
    const svg = renderToStaticMarkup(<AnnotationsSvg anns={anns} H={UNITS * ih / iw} maskId="exp" standalone px={outW} />);
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    try { ctx.drawImage(await loadImg(url), 0, 0, outW, outH); } finally { URL.revokeObjectURL(url); }
  }
  if (label) {
    const fs = Math.max(14, Math.round(outW * 0.022));
    ctx.font = `700 ${fs}px Arial, sans-serif`;
    const tw = ctx.measureText(label).width;
    ctx.fillStyle = 'rgba(15,23,42,0.85)';
    ctx.beginPath();
    ctx.roundRect(fs * 0.7, fs * 0.7, tw + fs * 1.4, fs * 1.9, fs);
    ctx.fill();
    ctx.fillStyle = '#fbbf24';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, fs * 1.4, fs * 1.65);
  }
  return c;
}

// ── Visor principal ─────────────────────────────────────────────────────────

interface ToolDef { id: Tool; label: string; key: string; Icon: React.ComponentType<{ className?: string }> }
const TOOLS: ToolDef[] = [
  { id: 'pan', label: 'Mover / desplazar', key: 'V', Icon: Hand },
  { id: 'laser', label: 'Puntero láser', key: 'L', Icon: MousePointer2 },
  { id: 'loupe', label: 'Lupa', key: 'Z', Icon: Search },
  { id: 'arrow', label: 'Flecha', key: 'A', Icon: ArrowUpRight },
  { id: 'line', label: 'Línea', key: 'I', Icon: Minus },
  { id: 'ellipse', label: 'Círculo / elipse', key: 'O', Icon: Circle },
  { id: 'rect', label: 'Rectángulo', key: 'R', Icon: Square },
  { id: 'pen', label: 'Lápiz libre', key: 'P', Icon: Pencil },
  { id: 'pin', label: 'Marcador numerado', key: 'M', Icon: MapPin },
  { id: 'text', label: 'Texto', key: 'T', Icon: Type },
  { id: 'spot', label: 'Foco (atenúa el resto)', key: 'F', Icon: Focus },
  { id: 'eraser', label: 'Borrador', key: 'E', Icon: Eraser }
];
const TOOL_BY_KEY = Object.fromEntries(TOOLS.map(t => [t.key.toLowerCase(), t.id])) as Record<string, Tool>;
const DRAWING: Tool[] = ['arrow', 'line', 'ellipse', 'rect', 'pen', 'pin', 'text', 'spot', 'laser'];

interface EvidenceViewerProps {
  slot: number;
  slotLabels: string[];
  populatedSlots: number[];
  before: string[];
  after: string[];
  onSlotChange: (slot: number) => void;
  onClose: () => void;
  store: AnnStoreMap;
  onStoreChange: React.Dispatch<React.SetStateAction<AnnStoreMap>>;
}

const EMPTY_STORE: AnnStore = { list: [], past: [], future: [] };

export function EvidenceViewer({ slot, slotLabels, populatedSlots, before, after, onSlotChange, onClose, store, onStoreChange }: EvidenceViewerProps) {
  const bSrc = before[slot] || '';
  const aSrc = after[slot] || '';
  const bothPresent = !!bSrc && !!aSrc;
  const defaultMode: Mode = bothPresent ? 'compare' : bSrc ? 'before' : 'after';

  const [mode, setMode] = useState<Mode>(defaultMode);
  const [view, setView] = useState<View>({ z: 1, fx: 0.5, fy: 0.5 });
  const [tool, setTool] = useState<Tool>('pan');
  const [color, setColor] = useState(COLORS[0]);
  const [widthIdx, setWidthIdx] = useState(1);
  const [draft, setDraft] = useState<Annotation | null>(null);
  const [sliderPos, setSliderPos] = useState(0.5);
  const [laser, setLaser] = useState<Pt | null>(null);
  const [trail, setTrail] = useState<TrailPt[]>([]);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [dims, setDims] = useState({ iw: 4, ih: 3 });
  const [stageSize, setStageSize] = useState({ w: 0, h: 0 });
  const [bright, setBright] = useState(100);
  const [contrast, setContrast] = useState(100);
  const [saturation, setSaturation] = useState(100);
  const [grid, setGrid] = useState(false);
  const [loupeMag, setLoupeMag] = useState(3);
  const [panel, setPanel] = useState<null | 'adjust' | 'export' | 'help'>(null);
  const [isFull, setIsFull] = useState(false);
  const [toast, setToast] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);

  const st = store[slot] || EMPTY_STORE;
  const width = WIDTHS[widthIdx];
  const filter = `brightness(${bright}%) contrast(${contrast}%) saturate(${saturation}%)`;
  const adjusted = bright !== 100 || contrast !== 100 || saturation !== 100;

  // Cambio de foto: reinicia vista, modo y dibujo en curso.
  useEffect(() => {
    setMode(bSrc && aSrc ? 'compare' : bSrc ? 'before' : 'after');
    setView({ z: 1, fx: 0.5, fy: 0.5 });
    setSliderPos(0.5);
    setDraft(null);
    setLaser(null);
    setTrail([]);
  }, [slot]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const prim = bSrc || aSrc;
    if (!prim) return;
    let cancelled = false;
    loadImg(prim).then(img => { if (!cancelled) setDims({ iw: img.naturalWidth || 4, ih: img.naturalHeight || 3 }); }).catch(() => {});
    return () => { cancelled = true; };
  }, [bSrc, aSrc]);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  useEffect(() => {
    const onFs = () => setIsFull(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFs);
    return () => {
      document.removeEventListener('fullscreenchange', onFs);
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    };
  }, []);

  // Estela del láser: se desvanece sola.
  const hasTrail = trail.length > 0;
  useEffect(() => {
    if (!hasTrail) return;
    let id = 0;
    const tick = () => {
      const t = performance.now();
      setTrail(prev => {
        const next = prev.filter(p => t - p.t < LASER_FADE_MS);
        return next.length === prev.length ? prev.slice() : next;
      });
      id = requestAnimationFrame(tick);
    };
    id = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(id);
  }, [hasTrail]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(''), 2200);
    return () => clearTimeout(t);
  }, [toast]);

  const onLaser = (p: Pt | null) => {
    setLaser(p);
    if (p) setTrail(prev => [...prev.slice(-40), { ...p, t: performance.now() }]);
  };

  // ── historial de anotaciones ──
  const writeStore = (fn: (s: AnnStore) => AnnStore) => onStoreChange(prev => ({ ...prev, [slot]: fn(prev[slot] || EMPTY_STORE) }));
  const commitList = (fn: (list: Annotation[]) => Annotation[]) =>
    writeStore(s => ({ list: renumberPins(fn(s.list)), past: [...s.past.slice(-60), s.list], future: [] }));
  const undo = () => writeStore(s => (s.past.length ? { list: s.past[s.past.length - 1], past: s.past.slice(0, -1), future: [s.list, ...s.future] } : s));
  const redo = () => writeStore(s => (s.future.length ? { list: s.future[0], past: [...s.past, s.list], future: s.future.slice(1) } : s));
  const clearAll = () => { if (st.list.length) commitList(() => []); };
  const pinCount = st.list.filter(a => a.kind === 'pin').length;

  // ── zoom ──
  const geomNow = () => {
    const { bw, bh } = fitBox(Math.max(stageSize.w, 1), Math.max(stageSize.h, 1), dims.iw, dims.ih);
    return { bw, bh };
  };
  const applyView = (v: View) => { const { bw, bh } = geomNow(); setView(clampView(v, stageSize.w, stageSize.h, bw, bh)); };
  const zoomTo = (z: number) => applyView({ ...view, z });
  const zoomBy = (f: number) => zoomTo(view.z * f);
  const resetView = () => setView({ z: 1, fx: 0.5, fy: 0.5 });

  const goSlot = (dir: 1 | -1) => {
    if (populatedSlots.length < 2) return;
    const pos = populatedSlots.indexOf(slot);
    onSlotChange(populatedSlots[(pos + dir + populatedSlots.length) % populatedSlots.length]);
  };

  const changeMode = (m: Mode) => {
    if (m === mode) return;
    setMode(m);
    resetView();
  };

  const toggleFull = () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else rootRef.current?.requestFullscreen?.().catch(() => {});
  };

  // ── exportar ──
  const exportImage = async (area: 'full' | 'view') => {
    setPanel(null);
    try {
      const { iw, ih } = dims;
      const outW = Math.min(iw, 2400);
      const sides: { src?: string; label?: string }[] =
        mode === 'before' ? [{ src: bSrc }]
        : mode === 'after' ? [{ src: aSrc }]
        : [{ src: bSrc, label: 'ANTES' }, { src: aSrc, label: 'DESPUÉS' }];
      const panes = await Promise.all(sides.filter(s => s.src || mode === 'compare' || mode === 'side').map(s => renderPane(s.src, iw, ih, outW, st.list, filter, s.label)));

      let crop = { x: 0, y: 0, w: 1, h: 1 };
      if (area === 'view') {
        const { bw, bh } = geomNow();
        const v = clampView(view, stageSize.w, stageSize.h, bw, bh);
        const hx = Math.min(0.5, stageSize.w / (2 * v.z * bw)), hy = Math.min(0.5, stageSize.h / (2 * v.z * bh));
        crop = { x: v.fx - hx, y: v.fy - hy, w: hx * 2, h: hy * 2 };
      }
      const cw = Math.round(panes[0].width * crop.w), ch = Math.round(panes[0].height * crop.h);
      const out = document.createElement('canvas');
      out.width = cw * panes.length; out.height = ch;
      const ctx = out.getContext('2d')!;
      panes.forEach((c, i) => ctx.drawImage(c, crop.x * c.width, crop.y * c.height, crop.w * c.width, crop.h * c.height, i * cw, 0, cw, ch));
      const blob: Blob | null = await new Promise(res => out.toBlob(res, 'image/png'));
      if (!blob) throw new Error('No se pudo generar la imagen');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      const slug = slotLabels[slot].toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, '-');
      a.download = `evidencia-${slug}-${mode}${area === 'view' ? '-zona' : ''}.png`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      setToast('Imagen descargada');
    } catch (err) {
      console.error('Error al exportar la evidencia:', err);
      setToast('No se pudo exportar la imagen');
    }
  };

  // ── teclado ──
  const kb = useRef({ tool, slot, view, st, mode });
  kb.current = { tool, slot, view, st, mode };
  useEffect(() => {
    const isTyping = (t: EventTarget | null) => t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    const down = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return;
      const k = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
      if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); redo(); return; }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.code === 'Space') { e.preventDefault(); setSpaceHeld(true); return; }
      if (k === 'escape') { if (panel) setPanel(null); else onClose(); return; }
      if (k === '+' || k === '=') { zoomBy(1.4); return; }
      if (k === '-' || k === '_') { zoomBy(1 / 1.4); return; }
      if (k === '0') { resetView(); return; }
      if (k === '1' || k === '2' || k === '3' || k === '4') {
        const m: Mode[] = ['compare', 'before', 'after', 'side'];
        const target = m[Number(k) - 1];
        if (target === 'compare' || target === 'side' ? bothPresent : target === 'before' ? !!bSrc : !!aSrc) changeMode(target);
        return;
      }
      if (k === 'g') { setGrid(g => !g); return; }
      if (k === '?' ) { setPanel(p => (p === 'help' ? null : 'help')); return; }
      if (k === 'arrowleft' || k === 'arrowright' || k === 'arrowup' || k === 'arrowdown') {
        e.preventDefault();
        const cur = kb.current.view;
        if (cur.z > 1.02) {
          const { bw, bh } = geomNow();
          const stepX = 80 / (cur.z * bw), stepY = 80 / (cur.z * bh);
          applyView({ z: cur.z, fx: cur.fx + (k === 'arrowright' ? stepX : k === 'arrowleft' ? -stepX : 0), fy: cur.fy + (k === 'arrowdown' ? stepY : k === 'arrowup' ? -stepY : 0) });
        } else if (k === 'arrowleft') goSlot(-1);
        else if (k === 'arrowright') goSlot(1);
        return;
      }
      if (TOOL_BY_KEY[k]) setTool(TOOL_BY_KEY[k]);
    };
    const up = (e: KeyboardEvent) => { if (e.code === 'Space') setSpaceHeld(false); };
    document.addEventListener('keydown', down);
    document.addEventListener('keyup', up);
    return () => { document.removeEventListener('keydown', down); document.removeEventListener('keyup', up); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  });

  const stageCommon = {
    iw: dims.iw, ih: dims.ih, view, onView: setView, tool, color, width, spaceHeld,
    anns: st.list, draft, onDraft: setDraft,
    onCommit: (a: Annotation) => commitList(l => [...l, a]),
    onErase: (id: string) => commitList(l => l.filter(a => a.id !== id)),
    pinCount, laser, trail, onLaser, sliderPos, onSlider: setSliderPos, filter, grid, loupeMag
  };

  const zoomPct = Math.log(view.z) / Math.log(MAX_Z) * 100;
  const modes: { id: Mode; label: string; Icon: React.ComponentType<{ className?: string }>; enabled: boolean; key: string }[] = [
    { id: 'compare', label: 'Comparar', Icon: SlidersHorizontal, enabled: bothPresent, key: '1' },
    { id: 'before', label: 'Antes', Icon: ChevronLeft, enabled: !!bSrc, key: '2' },
    { id: 'after', label: 'Después', Icon: ChevronRight, enabled: !!aSrc, key: '3' },
    { id: 'side', label: 'Lado a lado', Icon: Columns2, enabled: bothPresent, key: '4' }
  ];

  const iconBtn = 'shrink-0 w-9 h-9 rounded-lg flex items-center justify-center transition-colors disabled:opacity-30 disabled:pointer-events-none';
  const ghost = `${iconBtn} bg-white/10 hover:bg-white/20 text-white`;

  const colorsRow = (
    <div className="flex items-center gap-1.5 shrink-0">
      {COLORS.map(c => (
        <button
          key={c} type="button" onClick={() => setColor(c)} title={`Color ${c}`}
          className={`w-6 h-6 rounded-full border-2 transition-transform ${color === c ? 'scale-110 border-amber-400' : 'border-white/30 hover:scale-105'}`}
          style={{ background: c }}
        />
      ))}
    </div>
  );

  return createPortal(
    // Portal directo a document.body: sin esto el visor quedaría confinado dentro de las tarjetas
    // ".liquid-glass" (transform/will-change) en vez de cubrir toda la pantalla.
    <div ref={rootRef} className="fixed inset-0 z-[9999] bg-[#050506] flex flex-col text-white" role="dialog" aria-label="Visor de evidencias">
      {/* Barra superior */}
      <div className="flex items-center gap-2 px-2 sm:px-4 py-2 border-b border-white/10 overflow-x-auto shrink-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div className="flex items-center gap-1 shrink-0">
          <button type="button" className={ghost} onClick={() => goSlot(-1)} disabled={populatedSlots.length < 2} title="Foto anterior (←)"><ChevronLeft className="w-4 h-4" /></button>
          <div className="px-2 text-center min-w-[110px]">
            <div className="text-[11px] font-bold uppercase tracking-widest leading-tight">{slotLabels[slot]}</div>
            <div className="text-[10px] text-white/50">{populatedSlots.indexOf(slot) + 1} de {populatedSlots.length}</div>
          </div>
          <button type="button" className={ghost} onClick={() => goSlot(1)} disabled={populatedSlots.length < 2} title="Foto siguiente (→)"><ChevronRight className="w-4 h-4" /></button>
        </div>

        <div className="hidden lg:flex items-center gap-1.5 shrink-0">
          {populatedSlots.map(i => (
            <button
              key={i} type="button" onClick={() => onSlotChange(i)} title={slotLabels[i]}
              className={`w-10 h-10 rounded-lg overflow-hidden border-2 ${i === slot ? 'border-amber-500' : 'border-white/15 opacity-60 hover:opacity-100'}`}
            >
              <img src={before[i] || after[i]} alt="" className="w-full h-full object-cover" draggable={false} />
            </button>
          ))}
        </div>

        <div className="flex items-center bg-white/10 rounded-lg p-0.5 shrink-0 mx-auto">
          {modes.map(m => (
            <button
              key={m.id} type="button" disabled={!m.enabled} onClick={() => changeMode(m.id)} title={`${m.label} (${m.key})`}
              className={`px-2.5 py-1.5 rounded-md text-[11px] font-bold whitespace-nowrap transition-colors disabled:opacity-30 disabled:pointer-events-none ${mode === m.id ? 'bg-amber-500 text-white shadow' : 'text-white/70 hover:text-white hover:bg-white/10'}`}
            >
              {m.label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <button type="button" className={ghost} onClick={() => zoomBy(1 / 1.4)} title="Alejar (−)"><ZoomOut className="w-4 h-4" /></button>
          <input
            type="range" min={0} max={100} step={0.5} value={zoomPct} aria-label="Zoom"
            onChange={e => zoomTo(Math.pow(MAX_Z, Number(e.target.value) / 100))}
            className="hidden md:block w-28 accent-amber-500"
          />
          <button type="button" className={ghost} onClick={() => zoomBy(1.4)} title="Acercar (+)"><ZoomIn className="w-4 h-4" /></button>
          <button type="button" onClick={resetView} className="hidden sm:block px-2 h-9 rounded-lg bg-white/10 hover:bg-white/20 text-[11px] font-bold tabular-nums min-w-[52px]" title="Ajustar a la pantalla (0)">
            ×{view.z.toFixed(view.z < 10 ? 1 : 0)}
          </button>
          {[2, 4, 8].map(z => (
            <button key={z} type="button" onClick={() => zoomTo(z)} className="hidden xl:block px-2 h-9 rounded-lg bg-white/5 hover:bg-white/20 text-[11px] font-bold" title={`Zoom ×${z}`}>×{z}</button>
          ))}
          <button type="button" className={ghost} onClick={resetView} title="Ajustar a la pantalla (0)"><Scan className="w-4 h-4" /></button>
        </div>

        <div className="flex items-center gap-1 shrink-0 relative">
          <button type="button" className={`${iconBtn} ${grid ? 'bg-amber-500 text-white' : 'bg-white/10 hover:bg-white/20 text-white'}`} onClick={() => setGrid(g => !g)} title="Cuadrícula guía (G)"><Grid3x3 className="w-4 h-4" /></button>
          <button type="button" className={`${iconBtn} ${panel === 'adjust' || adjusted ? 'bg-amber-500 text-white' : 'bg-white/10 hover:bg-white/20 text-white'}`} onClick={() => setPanel(p => (p === 'adjust' ? null : 'adjust'))} title="Brillo, contraste y saturación"><Sun className="w-4 h-4" /></button>
          <button type="button" className={ghost} onClick={() => setPanel(p => (p === 'export' ? null : 'export'))} title="Descargar imagen anotada"><Download className="w-4 h-4" /></button>
          <button type="button" className={ghost} onClick={toggleFull} title="Pantalla completa">{isFull ? <Minimize className="w-4 h-4" /> : <Maximize className="w-4 h-4" />}</button>
          <button type="button" className={ghost} onClick={() => setPanel(p => (p === 'help' ? null : 'help'))} title="Atajos de teclado (?)"><Keyboard className="w-4 h-4" /></button>
          <button type="button" className={`${iconBtn} bg-white/10 hover:bg-red-500 text-white`} onClick={onClose} title="Cerrar (Esc)"><X className="w-4 h-4" /></button>
        </div>
      </div>

      {/* Paneles flotantes */}
      {panel === 'adjust' && (
        <div className="absolute right-3 top-16 z-50 w-72 rounded-2xl bg-slate-900/95 border border-white/15 shadow-2xl p-4 space-y-3 backdrop-blur">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-bold uppercase tracking-widest">Ajustes de imagen</span>
            <button type="button" className="text-[11px] text-amber-400 hover:text-amber-300 flex items-center gap-1" onClick={() => { setBright(100); setContrast(100); setSaturation(100); }}><RotateCcw className="w-3 h-3" />Restablecer</button>
          </div>
          {([['Brillo', bright, setBright, 40, 220], ['Contraste', contrast, setContrast, 40, 240], ['Saturación', saturation, setSaturation, 0, 250]] as const).map(([label, val, set, min, max]) => (
            <label key={label} className="block text-[11px] text-white/70">
              <span className="flex justify-between mb-1"><span>{label}</span><span className="tabular-nums text-white">{val}%</span></span>
              <input type="range" min={min} max={max} value={val} onChange={e => set(Number(e.target.value))} className="w-full accent-amber-500" />
            </label>
          ))}
          <p className="text-[10px] text-white/40">Solo cambia cómo se ve; la foto original no se modifica (sí se aplica al descargar).</p>
        </div>
      )}
      {panel === 'export' && (
        <div className="absolute right-3 top-16 z-50 w-72 rounded-2xl bg-slate-900/95 border border-white/15 shadow-2xl p-2 backdrop-blur">
          <button type="button" onClick={() => exportImage('full')} className="w-full text-left px-3 py-2.5 rounded-xl hover:bg-white/10">
            <div className="text-xs font-bold">Imagen completa</div>
            <div className="text-[10px] text-white/50">Foto entera con anotaciones{mode === 'compare' || mode === 'side' ? ' (Antes y Después juntos)' : ''}.</div>
          </button>
          <button type="button" onClick={() => exportImage('view')} className="w-full text-left px-3 py-2.5 rounded-xl hover:bg-white/10">
            <div className="text-xs font-bold">Zona visible</div>
            <div className="text-[10px] text-white/50">Solo el recuadro que estás viendo con el zoom actual, a resolución original.</div>
          </button>
        </div>
      )}
      {panel === 'help' && (
        <div className="absolute right-3 top-16 z-50 w-80 max-h-[75vh] overflow-y-auto rounded-2xl bg-slate-900/95 border border-white/15 shadow-2xl p-4 backdrop-blur text-[11px] text-white/80 space-y-3">
          <div className="text-[11px] font-bold uppercase tracking-widest text-white">Atajos y gestos</div>
          <ul className="space-y-1">
            <li><b>Rueda / pellizco:</b> zoom · <b>Doble clic</b> (Mover): acercar / ajustar</li>
            <li><b>Arrastrar:</b> desplazar (Mover) · <b>Espacio + arrastrar</b> o clic central: desplazar con cualquier herramienta</li>
            <li><b>Flechas:</b> desplazar con zoom, o cambiar de foto sin zoom</li>
            <li><b>+ / − / 0:</b> acercar / alejar / ajustar · <b>1-4:</b> modos · <b>G:</b> cuadrícula</li>
            <li><b>Shift</b> al dibujar: líneas a 45°, cuadrado/círculo perfecto</li>
            <li><b>Ctrl+Z / Ctrl+Y:</b> deshacer / rehacer · <b>Esc:</b> cerrar</li>
          </ul>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1">
            {TOOLS.map(t => <div key={t.id} className="flex items-center gap-2"><kbd className="px-1.5 rounded bg-white/15 text-white font-bold">{t.key}</kbd>{t.label}</div>)}
          </div>
        </div>
      )}

      {/* Barra de opciones */}
      <div className="flex items-center gap-3 px-2 sm:px-4 py-2 border-b border-white/10 overflow-x-auto shrink-0 text-[11px] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {colorsRow}
        <div className="flex items-center gap-1 shrink-0" title="Grosor">
          {WIDTHS.map((w, i) => (
            <button key={w} type="button" onClick={() => setWidthIdx(i)} className={`w-8 h-8 rounded-lg flex items-center justify-center ${widthIdx === i ? 'bg-amber-500/90' : 'bg-white/10 hover:bg-white/20'}`}>
              <span className="rounded-full bg-white" style={{ width: 4 + i * 3, height: 4 + i * 3 }} />
            </button>
          ))}
        </div>
        <div className="w-px h-6 bg-white/15 shrink-0" />
        <button type="button" className={ghost} onClick={undo} disabled={!st.past.length} title="Deshacer (Ctrl+Z)"><Undo2 className="w-4 h-4" /></button>
        <button type="button" className={ghost} onClick={redo} disabled={!st.future.length} title="Rehacer (Ctrl+Y)"><Redo2 className="w-4 h-4" /></button>
        <button type="button" className={`${ghost} hover:!bg-red-500/80`} onClick={clearAll} disabled={!st.list.length} title="Borrar todas las anotaciones de esta foto"><Trash2 className="w-4 h-4" /></button>
        <span className="text-white/40 shrink-0 hidden sm:inline">{st.list.length} anotación{st.list.length === 1 ? '' : 'es'}</span>
        {tool === 'loupe' && (
          <div className="flex items-center gap-1 shrink-0 ml-2">
            <span className="text-white/60">Lupa</span>
            <button type="button" className={ghost} onClick={() => setLoupeMag(m => Math.max(2, m - 1))}><ZoomOut className="w-4 h-4" /></button>
            <span className="font-bold tabular-nums w-6 text-center">×{loupeMag}</span>
            <button type="button" className={ghost} onClick={() => setLoupeMag(m => Math.min(10, m + 1))}><ZoomIn className="w-4 h-4" /></button>
          </div>
        )}
        <span className="ml-auto text-white/40 shrink-0 hidden md:inline">{DRAWING.includes(tool) ? 'Shift: ángulos y proporciones exactas' : 'Espacio + arrastrar: desplazar'}</span>
      </div>

      {/* Zona principal: herramientas + escenario */}
      <div className="flex-1 min-h-0 flex flex-col md:flex-row gap-2 p-2">
        <div className="order-last md:order-first shrink-0 flex md:flex-col gap-1 overflow-x-auto md:overflow-y-auto md:overflow-x-visible [scrollbar-width:none] [&::-webkit-scrollbar]:hidden bg-white/5 rounded-xl p-1.5 border border-white/10">
          {TOOLS.map(t => (
            <button
              key={t.id} type="button" onClick={() => setTool(t.id)} title={`${t.label} (${t.key})`} aria-pressed={tool === t.id}
              className={`${iconBtn} ${tool === t.id ? 'bg-amber-500 text-white shadow-lg' : 'text-white/80 hover:bg-white/15'}`}
            >
              <t.Icon className="w-[18px] h-[18px]" />
            </button>
          ))}
        </div>

        <div className="flex-1 min-w-0 min-h-0 flex gap-2">
          {mode === 'side' ? (
            <>
              <Stage {...stageCommon} before={bSrc} after={aSrc} layout="before" badge="Antes" showMinimap={false} onSize={(w, h) => setStageSize({ w, h })} />
              <Stage {...stageCommon} before={bSrc} after={aSrc} layout="after" badge="Después" showMinimap />
            </>
          ) : (
            <Stage
              {...stageCommon} before={bSrc} after={aSrc}
              layout={mode === 'compare' ? 'compare' : mode}
              badge={mode === 'compare' && bothPresent ? undefined : mode === 'before' ? 'Antes' : mode === 'after' ? 'Después' : undefined}
              showMinimap onSize={(w, h) => setStageSize({ w, h })}
            />
          )}
        </div>
      </div>

      {toast && (
        <div className="absolute bottom-20 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-full bg-emerald-500 text-white text-xs font-bold shadow-2xl">{toast}</div>
      )}
    </div>,
    document.body
  );
}
