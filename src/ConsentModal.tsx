import React, { useRef, useEffect } from 'react';
import SignaturePad from 'signature_pad';
import { FileText, CheckCircle, RotateCcw, X, ShieldCheck } from 'lucide-react';

interface ConsentModalProps {
  isOpen: boolean;
  patientName: string;
  onClose: () => void;
  onConfirm: (signatureBase64: string) => void;
}

export function ConsentModal({ isOpen, patientName, onClose, onConfirm }: ConsentModalProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const signaturePadRef = useRef<SignaturePad | null>(null);

  useEffect(() => {
    if (isOpen && canvasRef.current) {
      signaturePadRef.current = new SignaturePad(canvasRef.current, {
        penColor: '#121215',
        backgroundColor: 'rgba(255, 255, 255, 0)'
      });
    }
    return () => {
      if (signaturePadRef.current) {
        signaturePadRef.current.off();
      }
    };
  }, [isOpen]);

  if (!isOpen) return null;

  const handleClear = () => {
    if (signaturePadRef.current) {
      signaturePadRef.current.clear();
    }
  };

  const handleSave = () => {
    if (signaturePadRef.current && !signaturePadRef.current.isEmpty()) {
      const dataUrl = signaturePadRef.current.toDataURL('image/png');
      onConfirm(dataUrl);
    } else {
      onConfirm('');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in">
      <div className="bg-white dark:bg-luxe-900 border border-slate-200 dark:border-white/10 w-full max-w-2xl rounded-3xl shadow-2xl p-6 space-y-5 flex flex-col max-h-[90vh]">
        <div className="flex items-center justify-between border-b border-slate-100 dark:border-white/10 pb-4 shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-amber-500/10 text-amber-600 dark:text-amber-400">
              <ShieldCheck className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-sora text-base font-bold text-slate-800 dark:text-white uppercase tracking-wider">
                Consentimiento Informado Clínico
              </h3>
              <p className="text-xs text-slate-400">Paciente: <span className="font-bold text-amber-600 dark:text-amber-400">{patientName}</span></p>
            </div>
          </div>

          <button onClick={onClose} className="p-1 text-slate-400 hover:text-slate-600 dark:hover:text-white rounded-lg">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Document Terms Scroll Area */}
        <div className="flex-1 overflow-y-auto text-xs space-y-3 p-4 rounded-2xl bg-slate-50 dark:bg-white/5 border border-slate-200/60 dark:border-white/5 text-slate-700 dark:text-luxe-200 leading-relaxed scrollbar-thin">
          <h4 className="font-bold text-slate-900 dark:text-white uppercase">Términos y Declaración de Aceptación de Tratamiento</h4>
          <p>
            Por medio de la presente, declaro haber sido informado(a) detalladamente sobre la naturaleza, alcances, beneficios, recomendaciones y posibles reacciones temporales (tales como eritema leve, descamación o sensibilidad) del tratamiento cosmetológico prescrito.
          </p>
          <p>
            Me comprometo a seguir rigurosamente las indicaciones de apoyo en casa prescritas por el especialista (incluyendo el uso diario obligatorio de fotoprotección solar y apego a los principios activos asignados) y a reportar cualquier anomalía.
          </p>
          <p className="font-semibold text-amber-600 dark:text-amber-400">
            Autorizo la realización del protocolo clínico seleccionado e integro mi conformidad en este expediente dermoestético digital.
          </p>
        </div>

        {/* Signature Canvas Area */}
        <div className="space-y-2 shrink-0">
          <div className="flex items-center justify-between">
            <label className="text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-luxe-400">
              Firma Digital Táctil / Mouse del Paciente
            </label>
            <button
              onClick={handleClear}
              className="text-[10px] font-bold text-slate-400 hover:text-amber-500 transition-colors flex items-center gap-1"
            >
              <RotateCcw className="w-3 h-3" /> Limpiar Trazo
            </button>
          </div>

          <div className="border-2 border-dashed border-amber-500/40 rounded-2xl bg-slate-100/70 dark:bg-white/5 p-2 h-32 flex items-center justify-center relative">
            <canvas ref={canvasRef} width={500} height={110} className="w-full h-full cursor-crosshair touch-none" />
            <span className="absolute bottom-2 right-3 text-[9px] text-slate-400 pointer-events-none italic">
              Trace la firma dentro del recuadro
            </span>
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center justify-end gap-3 pt-2 shrink-0">
          <button
            onClick={onClose}
            className="px-5 py-2.5 rounded-xl text-xs font-bold text-slate-500 hover:text-slate-700 dark:text-luxe-300 dark:hover:text-white transition-colors"
          >
            Cancelar
          </button>
          <button
            onClick={handleSave}
            className="bg-gradient-to-r from-amber-500 to-amber-600 hover:brightness-110 text-white px-7 py-2.5 rounded-xl text-xs font-bold transition-all shadow-md flex items-center gap-2"
          >
            <CheckCircle className="w-4 h-4" /> Aceptar y Firmar Consentimiento
          </button>
        </div>
      </div>
    </div>
  );
}
