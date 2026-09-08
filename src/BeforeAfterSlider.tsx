import React, { useState, useRef, useEffect } from 'react';
import QRCode from 'qrcode';
import { SlidersHorizontal, Image as ImageIcon, Sparkles, X, ZoomIn, ZoomOut, ChevronLeft, ChevronRight, Maximize2, Trash2, Smartphone, Loader2, CheckCircle2 } from 'lucide-react';
import { fetchPhotoTransfer, deletePhotoTransfer, cleanupOldPhotoTransfers } from './db';

// Hasta 4 pares de fotos comparables: frente, ambos laterales y un área específica a discreción
// del especialista (p. ej. una zona con acné o una cicatriz puntual).
export const MAX_COMPARISON_SLOTS = 4;
const SLOT_LABELS = ['Frente', 'Lateral Izquierdo', 'Lateral Derecho', 'Área Específica'];

// Antes/Después se guardaban como un solo data URL en una columna TEXT. Para no requerir una
// migración de esquema, el arreglo de hasta 4 fotos se serializa como JSON en esa misma columna,
// con posiciones fijas (padding '') para que la foto de un slot no salte a otro al recargar.
// Un registro antiguo (un solo data URL, sin JSON) se interpreta como la foto del slot "Frente".
export function parseImageList(raw?: string): string[] {
  const empty = ['', '', '', ''];
  if (!raw) return empty;
  const trimmed = raw.trim();
  if (!trimmed) return empty;
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        const out = [...empty];
        parsed.slice(0, MAX_COMPARISON_SLOTS).forEach((v, i) => { if (typeof v === 'string') out[i] = v; });
        return out;
      }
    } catch (e) {
      // no era JSON válido: cae al formato heredado de abajo
    }
  }
  return [trimmed, '', '', ''];
}

export function serializeImageList(images: string[]): string {
  const out = [0, 1, 2, 3].map(i => images[i] || '');
  if (out.every(v => !v)) return '';
  return JSON.stringify(out);
}

interface BeforeAfterSliderProps {
  beforeImages: string[];
  afterImages: string[];
  onBeforeImagesChange: (images: string[]) => void;
  onAfterImagesChange: (images: string[]) => void;
}

// Reduce a un máximo de 1280px de lado y comprime a JPEG antes de guardar: una foto de celular
// sin procesar puede pesar varios MB, y guardar eso tal cual en cada consulta vuelve la
// sincronización remota muy pesada (el mismo tipo de problema de rendimiento ya visto en la app).
const MAX_DIMENSION = 1280;
export function resizeImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onloadend = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('No se pudo leer la imagen'));
      img.onload = () => {
        let { width, height } = img;
        if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
          const scale = MAX_DIMENSION / Math.max(width, height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) { resolve(reader.result as string); return; }
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', 0.82));
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  });
}

// Slider comparativo deslizable, reutilizado tanto en la miniatura de cada slot como en el visor
// a pantalla completa (solo cambia la altura y si el zoom está activo).
function CompareSlider({ before, after, heightClass, zoomed }: { before?: string; after?: string; heightClass: string; zoomed?: boolean }) {
  const [sliderPos, setSliderPos] = useState(50);
  const [isDragging, setIsDragging] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const zoomClass = zoomed ? 'scale-[2]' : 'scale-100';

  const handleMove = (clientX: number) => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const x = clientX - rect.left;
    let percentage = (x / rect.width) * 100;
    if (percentage < 0) percentage = 0;
    if (percentage > 100) percentage = 100;
    setSliderPos(percentage);
  };

  if (!before && !after) {
    return (
      <div className={`w-full ${heightClass} rounded-xl border-2 border-dashed border-slate-200 dark:border-white/10 flex flex-col items-center justify-center gap-1 text-slate-400 bg-slate-50/50 dark:bg-white/[0.01]`}>
        <ImageIcon className="w-6 h-6" />
        <p className="text-[10px] font-medium">Sin fotos</p>
      </div>
    );
  }

  if (!before || !after) {
    const missing = before ? 'Después' : 'Antes';
    return (
      <div className={`relative w-full ${heightClass} rounded-xl overflow-hidden border border-slate-200 dark:border-white/10 bg-black`}>
        <img
          src={before || after}
          alt={before ? 'Antes' : 'Después'}
          className={`absolute inset-0 w-full h-full object-cover transition-transform duration-300 ${zoomClass}`}
        />
        <span className="absolute bottom-2 left-2 bg-slate-900/80 text-amber-400 text-[9px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wider shadow">
          Falta "{missing}"
        </span>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      onMouseDown={() => setIsDragging(true)}
      onMouseUp={() => setIsDragging(false)}
      onMouseLeave={() => setIsDragging(false)}
      onMouseMove={e => { if (isDragging) handleMove(e.clientX); }}
      onTouchStart={() => setIsDragging(true)}
      onTouchEnd={() => setIsDragging(false)}
      onTouchMove={e => { if (isDragging) handleMove(e.touches[0].clientX); }}
      className={`relative w-full ${heightClass} rounded-xl overflow-hidden select-none cursor-ew-resize border border-slate-200 dark:border-white/10 shadow-xl bg-black`}
    >
      <img src={after} alt="Después" className={`absolute inset-0 w-full h-full object-cover pointer-events-none transition-transform duration-300 ${zoomClass}`} />
      <span className="absolute top-2 right-2 bg-amber-500/90 text-white text-[9px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wider shadow-lg backdrop-blur-md">
        Después
      </span>

      <div className="absolute inset-0 overflow-hidden pointer-events-none" style={{ width: `${sliderPos}%` }}>
        <img
          src={before}
          alt="Antes"
          className={`absolute inset-0 w-full h-full object-cover pointer-events-none transition-transform duration-300 ${zoomClass}`}
        />
        <span className="absolute top-2 left-2 bg-slate-900/90 text-amber-400 text-[9px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wider shadow-lg backdrop-blur-md">
          Antes
        </span>
      </div>

      <div className="absolute top-0 bottom-0 w-0.5 bg-white shadow-2xl pointer-events-none z-10" style={{ left: `${sliderPos}%` }}>
        <div className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-7 h-7 rounded-full bg-white dark:bg-luxe-900 border-2 border-amber-500 shadow-2xl flex items-center justify-center">
          <SlidersHorizontal className="w-3.5 h-3.5 text-amber-500 rotate-90" />
        </div>
      </div>
    </div>
  );
}

export function BeforeAfterSlider({ beforeImages, afterImages, onBeforeImagesChange, onAfterImagesChange }: BeforeAfterSliderProps) {
  const [lightboxSlot, setLightboxSlot] = useState<number | null>(null);
  const [zoomed, setZoomed] = useState(false);
  const [bridgeOpen, setBridgeOpen] = useState(false);

  const before = [0, 1, 2, 3].map(i => beforeImages[i] || '');
  const after = [0, 1, 2, 3].map(i => afterImages[i] || '');
  const populatedSlots = [0, 1, 2, 3].filter(i => before[i] || after[i]);

  const setSlotImage = (side: 'before' | 'after', idx: number, value: string) => {
    const arr = side === 'before' ? [...before] : [...after];
    arr[idx] = value;
    if (side === 'before') onBeforeImagesChange(arr); else onAfterImagesChange(arr);
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>, side: 'before' | 'after', idx: number) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const resized = await resizeImage(file);
      setSlotImage(side, idx, resized);
    } catch (err) {
      console.error('Error al procesar la imagen:', err);
    }
  };

  const removeSlotImage = (side: 'before' | 'after', idx: number) => setSlotImage(side, idx, '');

  const openLightbox = (idx: number) => { setZoomed(false); setLightboxSlot(idx); };
  const closeLightbox = () => { setLightboxSlot(null); setZoomed(false); };

  const stepLightbox = (dir: 1 | -1) => {
    if (lightboxSlot === null || populatedSlots.length === 0) return;
    const pos = populatedSlots.indexOf(lightboxSlot);
    const nextPos = (pos + dir + populatedSlots.length) % populatedSlots.length;
    setZoomed(false);
    setLightboxSlot(populatedSlots[nextPos]);
  };

  useEffect(() => {
    if (lightboxSlot === null) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeLightbox();
      if (e.key === 'ArrowLeft') stepLightbox(-1);
      if (e.key === 'ArrowRight') stepLightbox(1);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lightboxSlot, populatedSlots.join('|')]);

  return (
    <div className="space-y-4">
      <div className="bg-slate-500/5 p-4 rounded-2xl border border-slate-200/20 flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
        <div>
          <h4 className="text-xs font-bold text-slate-800 dark:text-white uppercase tracking-wider flex items-center gap-2">
            <SlidersHorizontal className="w-4 h-4 text-amber-500" />
            Galería Comparativa "Antes y Después"
          </h4>
          <p className="text-[11px] text-slate-500 dark:text-luxe-300">
            Sube hasta {MAX_COMPARISON_SLOTS} fotos por lado (frente, laterales y un área específica) y desliza cada tarjeta para evaluar objetivamente la evolución clínica. Toca <Maximize2 className="w-3 h-3 inline -mt-0.5" /> para ampliar y comparar en detalle.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setBridgeOpen(true)}
          className="shrink-0 flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl text-[11px] font-bold bg-amber-500 hover:bg-amber-600 text-white shadow-sm transition-all"
          title="Enviar una foto desde el celular sin cables"
        >
          <Smartphone className="w-3.5 h-3.5" /> Subir desde el Celular
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {SLOT_LABELS.map((label, idx) => {
          const hasAny = !!(before[idx] || after[idx]);
          return (
            <div key={idx} className="bg-white/60 dark:bg-white/[0.02] border border-slate-200/60 dark:border-white/10 rounded-2xl p-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-bold text-slate-500 dark:text-luxe-300 uppercase tracking-widest">{label}</span>
                {hasAny && (
                  <button
                    type="button"
                    onClick={() => openLightbox(idx)}
                    className="w-6 h-6 rounded-full bg-slate-900/80 hover:bg-amber-500 text-white flex items-center justify-center transition-colors"
                    title="Ampliar y comparar"
                  >
                    <Maximize2 className="w-3 h-3" />
                  </button>
                )}
              </div>

              <CompareSlider before={before[idx]} after={after[idx]} heightClass="h-[160px] sm:h-[200px]" />

              <div className="flex items-center gap-2">
                {(['before', 'after'] as const).map(side => {
                  const value = side === 'before' ? before[idx] : after[idx];
                  const isAfter = side === 'after';
                  return value ? (
                    <button
                      key={side}
                      type="button"
                      onClick={() => removeSlotImage(side, idx)}
                      className={`flex-1 flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg text-[10px] font-bold transition-all ${isAfter ? 'bg-amber-500/10 text-amber-600 hover:bg-amber-500/20' : 'bg-slate-500/10 text-slate-600 dark:text-luxe-200 hover:bg-slate-500/20'}`}
                    >
                      <Trash2 className="w-3 h-3" />
                      Quitar {isAfter ? 'Después' : 'Antes'}
                    </button>
                  ) : (
                    <label
                      key={side}
                      className={`flex-1 cursor-pointer flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg text-[10px] font-bold transition-all shadow-sm ${isAfter ? 'bg-amber-500 hover:bg-amber-600 text-white' : 'bg-white/80 dark:bg-luxe-900 border border-slate-200 dark:border-white/10 hover:border-amber-500 text-slate-700 dark:text-white'}`}
                    >
                      {isAfter ? <Sparkles className="w-3 h-3" /> : <ImageIcon className="w-3 h-3 text-amber-500" />}
                      {isAfter ? 'Después' : 'Antes'}
                      <input type="file" accept="image/*" className="hidden" onChange={e => handleFileUpload(e, side, idx)} />
                    </label>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {lightboxSlot !== null && (
        <div className="fixed inset-0 z-[9999] bg-black/95 flex flex-col" onClick={closeLightbox}>
          <div className="flex items-center justify-between px-4 sm:px-6 py-4 shrink-0" onClick={e => e.stopPropagation()}>
            <span className="text-white text-xs font-bold uppercase tracking-widest">{SLOT_LABELS[lightboxSlot]}</span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setZoomed(z => !z)}
                className="w-9 h-9 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center transition-colors"
                title={zoomed ? 'Alejar' : 'Acercar'}
              >
                {zoomed ? <ZoomOut className="w-4 h-4" /> : <ZoomIn className="w-4 h-4" />}
              </button>
              <button
                type="button"
                onClick={closeLightbox}
                className="w-9 h-9 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center transition-colors"
                title="Cerrar"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          <div className="flex-1 flex items-center justify-center gap-2 px-2 sm:px-6 pb-6 min-h-0" onClick={e => e.stopPropagation()}>
            {populatedSlots.length > 1 && (
              <button
                type="button"
                onClick={() => stepLightbox(-1)}
                className="shrink-0 w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center transition-colors"
              >
                <ChevronLeft className="w-5 h-5" />
              </button>
            )}

            <div className="w-full h-full max-w-4xl">
              <CompareSlider before={before[lightboxSlot]} after={after[lightboxSlot]} heightClass="h-full" zoomed={zoomed} />
            </div>

            {populatedSlots.length > 1 && (
              <button
                type="button"
                onClick={() => stepLightbox(1)}
                className="shrink-0 w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center transition-colors"
              >
                <ChevronRight className="w-5 h-5" />
              </button>
            )}
          </div>

          {populatedSlots.length > 1 && (
            <div className="flex items-center justify-center gap-2 pb-4 shrink-0" onClick={e => e.stopPropagation()}>
              {populatedSlots.map(i => (
                <button
                  key={i}
                  type="button"
                  onClick={() => { setZoomed(false); setLightboxSlot(i); }}
                  className={`w-2 h-2 rounded-full transition-colors ${i === lightboxSlot ? 'bg-amber-500' : 'bg-white/30'}`}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {bridgeOpen && (
        <PhotoBridgeModal
          before={before}
          after={after}
          onReceive={(side, idx, dataUrl) => setSlotImage(side, idx, dataUrl)}
          onClose={() => setBridgeOpen(false)}
        />
      )}
    </div>
  );
}

// Puente de fotos celular -> PC: evita depender de cable/AirDrop/WhatsApp para meter una foto
// tomada con el celular a esta ficha. El especialista elige un slot vacío, se genera un token
// aleatorio de un solo uso y un QR que abre la misma app en el celular (ver MobileUploadPage /
// main.tsx) apuntando a ese token; esta ventana hace polling a Turso (el único almacenamiento que
// comparten ambos dispositivos) hasta que la foto llega, y entonces la aplica sola al slot elegido.
type BridgeDestination = { side: 'before' | 'after'; idx: number };

function PhotoBridgeModal({
  before,
  after,
  onReceive,
  onClose
}: {
  before: string[];
  after: string[];
  onReceive: (side: 'before' | 'after', idx: number, dataUrl: string) => void;
  onClose: () => void;
}) {
  const [destination, setDestination] = useState<BridgeDestination | null>(null);
  const [token, setToken] = useState('');
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [received, setReceived] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    cleanupOldPhotoTransfers();
  }, []);

  useEffect(() => {
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  const startBridge = async (dest: BridgeDestination) => {
    const newToken = crypto.randomUUID();
    setDestination(dest);
    setToken(newToken);
    setReceived(false);

    // El celular nunca ve el modal de la PC donde se eligió la casilla, así que esa etiqueta viaja
    // en la propia URL del QR: quien sostiene el teléfono necesita ver "para cuál foto es esto"
    // antes de disparar la cámara, para no mandar por error la foto de otro ángulo.
    const slotLabel = encodeURIComponent(SLOT_LABELS[dest.idx]);
    const sideLabel = dest.side === 'before' ? 'Antes' : 'Después';
    const mobileUrl = `${window.location.origin}${import.meta.env.BASE_URL}?mobileUpload=${newToken}&slot=${slotLabel}&side=${sideLabel}`;
    try {
      const qr = await QRCode.toDataURL(mobileUrl, { width: 240, margin: 1 });
      setQrDataUrl(qr);
    } catch (err) {
      console.error('No se pudo generar el código QR:', err);
    }

    pollRef.current = setInterval(async () => {
      try {
        const imageData = await fetchPhotoTransfer(newToken);
        if (imageData) {
          if (pollRef.current) clearInterval(pollRef.current);
          onReceive(dest.side, dest.idx, imageData);
          deletePhotoTransfer(newToken);
          setReceived(true);
          setTimeout(onClose, 1400);
        }
      } catch (err) {
        console.error('Error al consultar el puente de fotos:', err);
      }
    }, 2500);
  };

  const handleCancel = () => {
    if (pollRef.current) clearInterval(pollRef.current);
    if (token) deletePhotoTransfer(token);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[9999] bg-black/70 flex items-center justify-center p-4" onClick={handleCancel}>
      <div
        className="liquid-glass bg-white dark:bg-luxe-900 rounded-3xl p-6 max-w-sm w-full space-y-5 border border-slate-200/50 dark:border-white/5"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h3 className="font-outfit text-sm font-bold text-slate-800 dark:text-white flex items-center gap-2">
            <Smartphone className="w-4 h-4 text-amber-500" /> Subir desde el Celular
          </h3>
          <button type="button" onClick={handleCancel} className="text-slate-400 hover:text-slate-600 dark:hover:text-white">
            <X className="w-4 h-4" />
          </button>
        </div>

        {!destination ? (
          <div className="space-y-2">
            <p className="text-[11px] text-slate-500 dark:text-luxe-300">¿En qué casilla quieres esta foto?</p>
            <div className="grid grid-cols-2 gap-2 max-h-72 overflow-y-auto pr-1">
              {SLOT_LABELS.map((label, idx) => (
                (['before', 'after'] as const).map(side => {
                  const occupied = !!(side === 'before' ? before[idx] : after[idx]);
                  return (
                    <button
                      key={`${idx}-${side}`}
                      type="button"
                      onClick={() => startBridge({ side, idx })}
                      className="text-left px-3 py-2 rounded-xl border border-slate-200 dark:border-white/10 hover:border-amber-500 hover:bg-amber-500/5 transition-all"
                    >
                      <span className="block text-[10px] font-bold text-slate-700 dark:text-luxe-100">{label}</span>
                      <span className="block text-[9px] text-slate-400 uppercase tracking-wider">
                        {side === 'before' ? 'Antes' : 'Después'} {occupied ? '· reemplazar' : ''}
                      </span>
                    </button>
                  );
                })
              ))}
            </div>
          </div>
        ) : received ? (
          <div className="py-6 flex flex-col items-center gap-2 text-center">
            <CheckCircle2 className="w-10 h-10 text-emerald-500" />
            <p className="text-xs font-bold text-slate-700 dark:text-luxe-100">¡Foto recibida!</p>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-3 text-center">
            <p className="text-[11px] text-slate-500 dark:text-luxe-300">
              Escanea este código con la cámara de tu celular (misma foto para <strong>{SLOT_LABELS[destination.idx]} · {destination.side === 'before' ? 'Antes' : 'Después'}</strong>).
            </p>
            {qrDataUrl ? (
              <img src={qrDataUrl} alt="Código QR" className="rounded-xl border border-slate-200 dark:border-white/10" width={200} height={200} />
            ) : (
              <div className="w-[200px] h-[200px] flex items-center justify-center">
                <Loader2 className="w-6 h-6 text-slate-400 animate-spin" />
              </div>
            )}
            <p className="text-[10px] text-slate-400 flex items-center gap-1.5">
              <Loader2 className="w-3 h-3 animate-spin" /> Esperando la foto...
            </p>
            <button
              type="button"
              onClick={() => setDestination(null)}
              className="text-[10px] font-bold text-slate-500 dark:text-luxe-300 underline"
            >
              Elegir otra casilla
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
