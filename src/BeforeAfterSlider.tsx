import React, { useState, useRef, MouseEvent, TouchEvent } from 'react';
import { SlidersHorizontal, Image as ImageIcon, Sparkles } from 'lucide-react';

interface BeforeAfterSliderProps {
  beforeImage?: string;
  afterImage?: string;
  onBeforeChange?: (url: string) => void;
  onAfterChange?: (url: string) => void;
}

export function BeforeAfterSlider({ beforeImage, afterImage, onBeforeChange, onAfterChange }: BeforeAfterSliderProps) {
  const [sliderPos, setSliderPos] = useState<number>(50);
  const [isDragging, setIsDragging] = useState<boolean>(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const handleMove = (clientX: number) => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const x = clientX - rect.left;
    let percentage = (x / rect.width) * 100;
    if (percentage < 0) percentage = 0;
    if (percentage > 100) percentage = 100;
    setSliderPos(percentage);
  };

  const handleMouseMove = (e: MouseEvent) => {
    if (!isDragging) return;
    handleMove(e.clientX);
  };

  const handleTouchMove = (e: TouchEvent) => {
    if (!isDragging) return;
    handleMove(e.touches[0].clientX);
  };

  // Reduce a un máximo de 1280px de lado y comprime a JPEG antes de guardar: una foto de celular
  // sin procesar puede pesar varios MB, y guardar eso tal cual en cada consulta vuelve la
  // sincronización remota muy pesada (el mismo tipo de problema de rendimiento ya visto en la app).
  const MAX_DIMENSION = 1280;
  const resizeImage = (file: File): Promise<string> => {
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
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>, type: 'before' | 'after') => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const resized = await resizeImage(file);
      if (type === 'before' && onBeforeChange) onBeforeChange(resized);
      if (type === 'after' && onAfterChange) onAfterChange(resized);
    } catch (err) {
      console.error('Error al procesar la imagen:', err);
    }
  };

  const imgBefore = beforeImage;
  const imgAfter = afterImage;

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 bg-slate-500/5 p-4 rounded-2xl border border-slate-200/20">
        <div>
          <h4 className="text-xs font-bold text-slate-800 dark:text-white uppercase tracking-wider flex items-center gap-2">
            <SlidersHorizontal className="w-4 h-4 text-amber-500" />
            Galería Comparativa "Antes y Después"
          </h4>
          <p className="text-[11px] text-slate-500 dark:text-luxe-300">
            Deslice la barra para evaluar objetivamente la evolución clínica del paciente.
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <label className="cursor-pointer bg-white/80 dark:bg-luxe-900 border border-slate-200 dark:border-white/10 hover:border-amber-500 text-slate-700 dark:text-white px-3 py-1.5 rounded-xl text-xs font-bold transition-all flex items-center gap-1.5 shadow-sm">
            <ImageIcon className="w-3.5 h-3.5 text-amber-500" />
            Subir Antes
            <input type="file" accept="image/*" className="hidden" onChange={e => handleFileUpload(e, 'before')} />
          </label>
          <label className="cursor-pointer bg-amber-500 hover:bg-amber-600 text-white px-3 py-1.5 rounded-xl text-xs font-bold transition-all flex items-center gap-1.5 shadow-sm">
            <Sparkles className="w-3.5 h-3.5" />
            Subir Después
            <input type="file" accept="image/*" className="hidden" onChange={e => handleFileUpload(e, 'after')} />
          </label>
        </div>
      </div>

      {imgBefore && imgAfter ? (
        <div
          ref={containerRef}
          onMouseDown={() => setIsDragging(true)}
          onMouseUp={() => setIsDragging(false)}
          onMouseLeave={() => setIsDragging(false)}
          onMouseMove={handleMouseMove}
          onTouchStart={() => setIsDragging(true)}
          onTouchEnd={() => setIsDragging(false)}
          onTouchMove={handleTouchMove}
          className="relative w-full h-[320px] sm:h-[420px] rounded-2xl overflow-hidden select-none cursor-ew-resize border border-slate-200 dark:border-white/10 shadow-2xl bg-black"
        >
          {/* Image After (Base layer) */}
          <img
            src={imgAfter}
            alt="Después / Evolución Actual"
            className="absolute inset-0 w-full h-full object-cover pointer-events-none"
          />

          {/* Badge Después */}
          <span className="absolute top-3 right-3 bg-amber-500/90 text-white text-[10px] font-bold px-3 py-1 rounded-full uppercase tracking-wider shadow-lg backdrop-blur-md">
            DESPUÉS (Evolución Actual)
          </span>

          {/* Image Before (Clipped layer) */}
          <div
            className="absolute inset-0 overflow-hidden pointer-events-none"
            style={{ width: `${sliderPos}%` }}
          >
            <img
              src={imgBefore}
              alt="Antes / Valoración Inicial"
              className="absolute inset-0 w-full h-full object-cover pointer-events-none"
              style={{ width: '100%', height: '100%' }}
            />
            {/* Badge Antes */}
            <span className="absolute top-3 left-3 bg-slate-900/90 text-amber-400 text-[10px] font-bold px-3 py-1 rounded-full uppercase tracking-wider shadow-lg backdrop-blur-md">
              ANTES (Valoración Inicial)
            </span>
          </div>

          {/* Slider Divider Line & Knob */}
          <div
            className="absolute top-0 bottom-0 w-1 bg-white shadow-2xl pointer-events-none z-10"
            style={{ left: `${sliderPos}%` }}
          >
            <div className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-8 h-8 rounded-full bg-white dark:bg-luxe-900 border-2 border-amber-500 shadow-2xl flex items-center justify-center">
              <SlidersHorizontal className="w-4 h-4 text-amber-500 rotate-90" />
            </div>
          </div>
        </div>
      ) : (
        <div className="w-full h-[200px] rounded-2xl border-2 border-dashed border-slate-200 dark:border-white/10 flex flex-col items-center justify-center gap-2 text-slate-400 bg-slate-50/50 dark:bg-white/[0.01]">
          <ImageIcon className="w-8 h-8" />
          <p className="text-xs font-medium">
            {!imgBefore && !imgAfter ? 'Sube ambas fotos para ver la comparación deslizable' : imgBefore ? 'Falta la foto de "Después"' : 'Falta la foto de "Antes"'}
          </p>
        </div>
      )}
    </div>
  );
}
