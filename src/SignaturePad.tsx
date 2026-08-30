import React, { useEffect, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import SignaturePadLib from 'signature_pad';
import { Eraser, ShieldCheck, X, Check } from 'lucide-react';

interface Point { x: number; y: number; time?: number; }
interface PointGroup { points: Point[]; }

// Distingue un trazo de firma real de un toque/arrastre accidental sobre el canvas, sin usar ningún
// modelo: exige suficientes puntos, un área cubierta mínima, una longitud de trazo mínima y, cuando
// es un solo trazo continuo (firma cursiva típica), que no sea una línea recta (un arrastre accidental
// sí lo es; una firma real siempre tiene curvas).
function evaluateSignature(strokes: PointGroup[]): boolean {
  if (!strokes || strokes.length === 0) return false;
  const allPoints = strokes.flatMap(s => s.points);
  if (allPoints.length < 6) return false;

  const xs = allPoints.map(p => p.x);
  const ys = allPoints.map(p => p.y);
  const width = Math.max(...xs) - Math.min(...xs);
  const height = Math.max(...ys) - Math.min(...ys);
  if (width < 40 || height < 12) return false;

  let totalLength = 0;
  strokes.forEach(stroke => {
    for (let i = 1; i < stroke.points.length; i++) {
      const a = stroke.points[i - 1];
      const b = stroke.points[i];
      totalLength += Math.hypot(b.x - a.x, b.y - a.y);
    }
  });
  if (totalLength < 80) return false;

  if (strokes.length >= 2) return true;

  const stroke = strokes[0];
  const first = stroke.points[0];
  const last = stroke.points[stroke.points.length - 1];
  const straightDistance = Math.hypot(last.x - first.x, last.y - first.y) || 1;
  const curvinessRatio = totalLength / straightDistance;
  return curvinessRatio > 1.15;
}

interface SignaturePadFieldProps {
  label: string;
  helperText?: string;
  value?: string; // dataURL existente (modo edición)
  onChange: (dataUrl: string | undefined, isValid: boolean) => void;
  canvasHeightClass?: string; // p.ej. "h-[280px]" para el modo pantalla completa
}

export function SignaturePadField({ label, helperText, value, onChange, canvasHeightClass = 'h-[140px]' }: SignaturePadFieldProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const padRef = useRef<SignaturePadLib | null>(null);
  const [isValid, setIsValid] = useState<boolean>(!!value);
  const [isEmpty, setIsEmpty] = useState<boolean>(!value);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const confirmTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const resizeCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    const pad = padRef.current;
    if (!canvas || !pad) return;
    const ratio = Math.max(window.devicePixelRatio || 1, 1);
    const data = pad.toData();
    canvas.width = canvas.offsetWidth * ratio;
    canvas.height = canvas.offsetHeight * ratio;
    const ctx = canvas.getContext('2d');
    if (ctx) ctx.scale(ratio, ratio);
    pad.fromData(data);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const pad = new SignaturePadLib(canvas, {
      backgroundColor: 'rgb(255, 255, 255)',
      penColor: 'rgb(20, 20, 20)',
      minWidth: 0.8,
      maxWidth: 2.5,
    });
    padRef.current = pad;

    resizeCanvas();
    if (value) {
      pad.fromDataURL(value).catch(() => {});
    }

    const handleEnd = () => {
      const data = pad.toData();
      const empty = pad.isEmpty();
      const valid = !empty && evaluateSignature(data as unknown as PointGroup[]);
      setIsEmpty(empty);
      setIsValid(valid);
      onChange(empty ? undefined : pad.toDataURL('image/png'), valid);
    };
    // signature_pad dispatca "endStroke" en un EventTarget privado de la instancia, no en el
    // <canvas> del DOM — hay que escucharlo con pad.addEventListener, no canvas.addEventListener.
    pad.addEventListener('endStroke', handleEnd);

    let resizeObserver: ResizeObserver | null = null;
    if (containerRef.current && typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => resizeCanvas());
      resizeObserver.observe(containerRef.current);
    }

    return () => {
      pad.removeEventListener('endStroke', handleEnd);
      resizeObserver?.disconnect();
      pad.off();
      padRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    return () => {
      if (confirmTimeoutRef.current) clearTimeout(confirmTimeoutRef.current);
    };
  }, []);

  // Un toque accidental sobre "Borrar" no debe poder tirar una firma ya capturada: el primer toque
  // solo arma la confirmación (se desarma sola a los 3s si no se confirma); recién el segundo toque
  // borra de verdad. Si el pad ya está vacío no hay nada que perder, así que se borra directo.
  const handleClearClick = () => {
    if (isEmpty) return;
    if (!confirmingClear) {
      setConfirmingClear(true);
      confirmTimeoutRef.current = setTimeout(() => setConfirmingClear(false), 3000);
      return;
    }
    if (confirmTimeoutRef.current) clearTimeout(confirmTimeoutRef.current);
    setConfirmingClear(false);
    padRef.current?.clear();
    setIsEmpty(true);
    setIsValid(false);
    onChange(undefined, false);
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <label className="text-[10px] font-bold text-slate-400 dark:text-luxe-400 uppercase tracking-widest ml-1">{label}</label>
        <button
          type="button"
          onClick={handleClearClick}
          className={`text-[10px] font-bold flex items-center gap-1 px-2 py-1.5 rounded-lg transition-colors ${
            confirmingClear ? 'text-red-600 bg-red-500/10' : 'text-slate-400 hover:text-amber-500'
          }`}
        >
          <Eraser className="w-3 h-3" /> {confirmingClear ? '¿Confirmar borrado?' : 'Borrar'}
        </button>
      </div>
      <div
        ref={containerRef}
        className={`relative rounded-xl border-2 border-dashed overflow-hidden bg-white ${isValid ? 'border-emerald-400' : 'border-slate-300 dark:border-white/10'}`}
        style={{ touchAction: 'none' }}
      >
        <canvas
          ref={canvasRef}
          className={`w-full ${canvasHeightClass} block`}
          style={{ touchAction: 'none' }}
        />
      </div>
      <div className="flex items-center gap-1.5 text-[10px]">
        <ShieldCheck className={`w-3.5 h-3.5 shrink-0 ${isValid ? 'text-emerald-500' : 'text-slate-400'}`} />
        <span className={isValid ? 'text-emerald-600 dark:text-emerald-400 font-semibold' : 'text-slate-400'}>
          {isValid ? 'Firma detectada' : isEmpty ? 'Pendiente de firma' : 'Trazo insuficiente, firme de nuevo'}
        </span>
        {helperText && <span className="text-slate-400 ml-1">— {helperText}</span>}
      </div>
    </div>
  );
}

interface SignatureKioskModalProps {
  patientName?: string;
  value?: string;
  onChange: (dataUrl: string | undefined, isValid: boolean) => void;
  onDone: () => void;
}

// Pantalla completa que se le entrega al paciente para firmar: oculta por completo el resto de la
// ficha clínica (alergias, notas, historial de otros pacientes) mientras el dispositivo está en sus
// manos. La única salida sin firma válida es la "X" del especialista; el botón principal solo se
// habilita con una firma real detectada, para no aceptar por accidente un trazo a medias.
export function SignatureKioskModal({ patientName, value, onChange, onDone }: SignatureKioskModalProps) {
  const [isValid, setIsValid] = useState<boolean>(!!value);

  useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prevOverflow; };
  }, []);

  // Portal directo a document.body: si este modal se renderizara en su lugar natural del árbol,
  // cualquier ancestro con transform/will-change/contain (como .liquid-glass, usado en las tarjetas
  // de la ficha para acelerar por GPU) crea sin querer un "containing block" para position:fixed, y
  // el modal queda confinado dentro de esa tarjeta en vez de cubrir la pantalla real — se ve un
  // canvas, pero los toques reales del dedo caen fuera de donde el navegador cree que está.
  return createPortal(
    <div className="fixed inset-0 z-[100] bg-white dark:bg-luxe-950 flex flex-col animate-fade-in">
      <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-white/10 shrink-0">
        <div>
          <span className="font-outfit text-sm font-bold text-slate-800 dark:text-white block">Firma de Consentimiento</span>
          {patientName && <span className="text-xs text-slate-400">{patientName}</span>}
        </div>
        <button
          type="button"
          onClick={onDone}
          className="w-10 h-10 rounded-full flex items-center justify-center text-slate-400 hover:text-slate-600 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-white/10"
          title="Regresar al especialista sin terminar"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto flex flex-col items-center justify-center px-6 py-6 gap-6">
        <p className="max-w-md text-center text-sm text-slate-600 dark:text-luxe-300">
          Al firmar abajo, usted confirma que recibió la información sobre el tratamiento a realizar
          y otorga su consentimiento para llevarlo a cabo.
        </p>
        <div className="w-full max-w-md">
          <SignaturePadField
            label="Firme aquí con su dedo o lápiz óptico"
            value={value}
            canvasHeightClass="h-[280px]"
            onChange={(dataUrl, valid) => {
              setIsValid(valid);
              onChange(dataUrl, valid);
            }}
          />
        </div>
      </div>

      <div className="px-6 py-5 border-t border-slate-200 dark:border-white/10 shrink-0">
        <button
          type="button"
          onClick={onDone}
          disabled={!isValid}
          className={`w-full py-4 rounded-2xl text-sm font-bold flex items-center justify-center gap-2 transition-all ${
            isValid
              ? 'bg-gradient-to-r from-emerald-500 to-emerald-600 text-white shadow-lg'
              : 'bg-slate-100 dark:bg-white/5 text-slate-400 cursor-not-allowed'
          }`}
        >
          <Check className="w-5 h-5" /> {isValid ? 'Listo, firma completada' : 'Falta completar la firma'}
        </button>
      </div>
    </div>,
    document.body
  );
}
