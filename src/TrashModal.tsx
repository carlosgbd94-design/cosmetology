import React from 'react';
import { Trash2, RotateCcw, X, Archive } from 'lucide-react';
import { Patient, Consultation } from './types';

interface TrashModalProps {
  isOpen: boolean;
  onClose: () => void;
  deletedPatients: Patient[];
  deletedConsultations: (Consultation & { patientName: string })[];
  onRestorePatient: (id: string) => void;
  onPermanentlyDeletePatient: (id: string) => void;
  onRestoreConsultation: (id: string) => void;
  onPermanentlyDeleteConsultation: (id: string) => void;
}

export function TrashModal({
  isOpen,
  onClose,
  deletedPatients,
  deletedConsultations,
  onRestorePatient,
  onPermanentlyDeletePatient,
  onRestoreConsultation,
  onPermanentlyDeleteConsultation
}: TrashModalProps) {
  if (!isOpen) return null;

  const isEmpty = deletedPatients.length === 0 && deletedConsultations.length === 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in">
      <div className="bg-white dark:bg-luxe-900 border border-slate-200 dark:border-white/10 w-full max-w-2xl rounded-3xl shadow-2xl p-6 space-y-5 flex flex-col max-h-[85vh]">
        <div className="flex items-center justify-between border-b border-slate-100 dark:border-white/10 pb-4 shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-amber-500/10 text-amber-600 dark:text-amber-400">
              <Archive className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-sora text-base font-bold text-slate-800 dark:text-white uppercase tracking-wider">
                Papelera
              </h3>
              <p className="text-xs text-slate-400">Pacientes y visitas eliminados, recuperables mientras no se borren para siempre</p>
            </div>
          </div>
          <button onClick={onClose} className="p-1 text-slate-400 hover:text-slate-600 dark:hover:text-white rounded-lg">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto space-y-6">
          {isEmpty && (
            <div className="text-center py-10 text-xs text-slate-400 italic">
              La papelera está vacía.
            </div>
          )}

          {deletedPatients.length > 0 && (
            <div className="space-y-2">
              <h4 className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Pacientes ({deletedPatients.length})</h4>
              <div className="space-y-2">
                {deletedPatients.map(pat => (
                  <div key={pat.id} className="flex items-center justify-between gap-3 p-3 rounded-xl bg-slate-50 dark:bg-white/5 border border-slate-200/50 dark:border-white/5">
                    <div className="min-w-0">
                      <span className="block text-xs font-bold text-slate-800 dark:text-white truncate">
                        {pat.firstNameEncrypted} {pat.lastNameEncrypted}
                      </span>
                      <span className="text-[10px] text-slate-400">
                        Eliminado {pat.deletedAt ? new Date(pat.deletedAt).toLocaleString() : ''}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        onClick={() => onRestorePatient(pat.id)}
                        title="Restaurar"
                        className="px-3 py-1.5 rounded-lg bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/20 text-[10px] font-bold flex items-center gap-1"
                      >
                        <RotateCcw className="w-3 h-3" /> Restaurar
                      </button>
                      <button
                        onClick={() => onPermanentlyDeletePatient(pat.id)}
                        title="Eliminar para siempre"
                        className="px-3 py-1.5 rounded-lg bg-red-500/10 text-red-600 dark:text-red-400 hover:bg-red-500/20 text-[10px] font-bold flex items-center gap-1"
                      >
                        <Trash2 className="w-3 h-3" /> Borrar
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {deletedConsultations.length > 0 && (
            <div className="space-y-2">
              <h4 className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Visitas ({deletedConsultations.length})</h4>
              <div className="space-y-2">
                {deletedConsultations.map(c => (
                  <div key={c.id} className="flex items-center justify-between gap-3 p-3 rounded-xl bg-slate-50 dark:bg-white/5 border border-slate-200/50 dark:border-white/5">
                    <div className="min-w-0">
                      <span className="block text-xs font-bold text-slate-800 dark:text-white truncate">
                        {c.patientName} — {new Date(c.visitDate).toLocaleDateString()}
                      </span>
                      <span className="text-[10px] text-slate-400">
                        Eliminada {c.deletedAt ? new Date(c.deletedAt).toLocaleString() : ''}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        onClick={() => onRestoreConsultation(c.id)}
                        title="Restaurar"
                        className="px-3 py-1.5 rounded-lg bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/20 text-[10px] font-bold flex items-center gap-1"
                      >
                        <RotateCcw className="w-3 h-3" /> Restaurar
                      </button>
                      <button
                        onClick={() => onPermanentlyDeleteConsultation(c.id)}
                        title="Eliminar para siempre"
                        className="px-3 py-1.5 rounded-lg bg-red-500/10 text-red-600 dark:text-red-400 hover:bg-red-500/20 text-[10px] font-bold flex items-center gap-1"
                      >
                        <Trash2 className="w-3 h-3" /> Borrar
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="flex justify-end pt-2 shrink-0 border-t border-slate-100 dark:border-white/10">
          <button
            onClick={onClose}
            className="px-6 py-2.5 rounded-xl text-xs font-bold bg-slate-100 hover:bg-slate-200 dark:bg-white/10 text-slate-700 dark:text-white transition-colors"
          >
            Cerrar
          </button>
        </div>
      </div>
    </div>
  );
}
