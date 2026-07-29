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

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>, type: 'before' | 'after') => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () => {
        const base64 = reader.result as string;
        if (type === 'before' && onBeforeChange) onBeforeChange(base64);
        if (type === 'after' && onAfterChange) onAfterChange(base64);
      };
      reader.readAsDataURL(file);
    }
  };

  const defaultBefore = 'https://images.unsplash.com/photo-1512290900676-26c2a4d0b5ae?q=80&w=800&auto=format&fit=crop';
  const defaultAfter = 'https://images.unsplash.com/photo-1522337360788-8b13dee7a37e?q=80&w=800&auto=format&fit=crop';

  const imgBefore = beforeImage || defaultBefore;
  const imgAfter = afterImage || defaultAfter;

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
    </div>
  );
}
