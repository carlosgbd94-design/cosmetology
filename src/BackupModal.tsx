import React, { useState } from 'react';
import { db } from './db';
import { Database, Download, Upload, ShieldCheck, X, Check } from 'lucide-react';

interface BackupModalProps {
  isOpen: boolean;
  onClose: () => void;
  onRestoreComplete: () => void;
}

export function BackupModal({ isOpen, onClose, onRestoreComplete }: BackupModalProps) {
  const [statusMsg, setStatusMsg] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(false);

  if (!isOpen) return null;

  const handleExportJSON = async () => {
    setLoading(true);
    try {
      const products = await db.products.toArray();
      const patients = await db.patients.toArray();
      const anamnesis = await db.anamnesis.toArray();
      const consultations = await db.consultations.toArray();
      const consultation_steps = await db.consultation_steps.toArray();
      const prescriptions = await db.prescriptions.toArray();

      const backupData = {
        exportDate: new Date().toISOString(),
        version: '7.0',
        data: {
          products,
          patients,
          anamnesis,
          consultations,
          consultation_steps,
          prescriptions
        }
      };

      const jsonStr = JSON.stringify(backupData, null, 2);
      const blob = new Blob([jsonStr], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Respaldo_Dermatique_${new Date().toISOString().split('T')[0]}.json`;
      a.click();
      URL.revokeObjectURL(url);

      setStatusMsg('✅ Respaldo completo descargado exitosamente.');
    } catch(e) {
      console.error(e);
      setStatusMsg('❌ Error al exportar la base de datos.');
    } finally {
      setLoading(false);
    }
  };

  const handleImportJSON = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setLoading(true);
    const reader = new FileReader();
    reader.onload = async (evt) => {
      try {
        const parsed = JSON.parse(evt.target?.result as string);
        if (parsed && parsed.data) {
          const { products, patients, anamnesis, consultations, consultation_steps, prescriptions } = parsed.data;

          if (Array.isArray(products)) {
            for (const p of products) await db.products.put(p);
          }
          if (Array.isArray(patients)) {
            for (const pat of patients) await db.patients.put(pat);
          }
          if (Array.isArray(anamnesis)) {
            for (const a of anamnesis) await db.anamnesis.put(a);
          }
          if (Array.isArray(consultations)) {
            for (const c of consultations) await db.consultations.put(c);
          }
          if (Array.isArray(consultation_steps)) {
            for (const cs of consultation_steps) await db.consultation_steps.put(cs);
          }
          if (Array.isArray(prescriptions)) {
            for (const pr of prescriptions) await db.prescriptions.put(pr);
          }

          setStatusMsg('✅ Base de datos restaurada correctamente.');
          onRestoreComplete();
        } else {
          setStatusMsg('❌ Formato de archivo de respaldo no válido.');
        }
      } catch(err) {
        console.error(err);
        setStatusMsg('❌ Error al leer el archivo JSON.');
      } finally {
        setLoading(false);
      }
    };
    reader.readAsText(file);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in">
      <div className="bg-white dark:bg-luxe-900 border border-slate-200 dark:border-white/10 w-full max-w-lg rounded-3xl shadow-2xl p-6 space-y-5">
        <div className="flex items-center justify-between border-b border-slate-100 dark:border-white/10 pb-4">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-amber-500/10 text-amber-600 dark:text-amber-400">
              <Database className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-sora text-base font-bold text-slate-800 dark:text-white uppercase tracking-wider">
                Centro de Respaldo y Portabilidad
              </h3>
              <p className="text-xs text-slate-400">Exportación e importación de la base clínica completa</p>
            </div>
          </div>

          <button onClick={onClose} className="p-1 text-slate-400 hover:text-slate-600 dark:hover:text-white rounded-lg">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="space-y-4">
          <div className="p-4 rounded-2xl bg-slate-50 dark:bg-white/5 border border-slate-200/50 dark:border-white/5 space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <span className="font-bold text-xs text-slate-800 dark:text-white block">Descargar Copia de Seguridad</span>
                <span className="text-[10px] text-slate-400">Genera un archivo JSON comprimido con todos sus datos.</span>
              </div>
              <button
                onClick={handleExportJSON}
                disabled={loading}
                className="bg-gradient-to-r from-amber-500 to-amber-600 hover:brightness-110 text-white px-4 py-2 rounded-xl text-xs font-bold transition-all shadow-md flex items-center gap-1.5 shrink-0"
              >
                <Download className="w-3.5 h-3.5" /> Exportar
              </button>
            </div>
          </div>

          <div className="p-4 rounded-2xl bg-slate-50 dark:bg-white/5 border border-slate-200/50 dark:border-white/5 space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <span className="font-bold text-xs text-slate-800 dark:text-white block">Restaurar Base de Datos</span>
                <span className="text-[10px] text-slate-400">Carga un archivo de respaldo previo para sincronizar todo.</span>
              </div>
              <label className="cursor-pointer bg-slate-800 hover:bg-slate-900 text-white px-4 py-2 rounded-xl text-xs font-bold transition-all shadow-md flex items-center gap-1.5 shrink-0">
                <Upload className="w-3.5 h-3.5 text-amber-400" /> Importar
                <input type="file" accept=".json" className="hidden" onChange={handleImportJSON} />
              </label>
            </div>
          </div>

          {statusMsg && (
            <p className="text-xs font-bold text-center text-amber-600 dark:text-amber-400 p-2.5 rounded-xl bg-amber-500/10 border border-amber-500/20">
              {statusMsg}
            </p>
          )}
        </div>

        <div className="flex justify-end pt-2">
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
