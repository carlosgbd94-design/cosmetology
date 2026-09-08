import { useState } from 'react';
import { Camera, CheckCircle2, ImageIcon, Loader2, RefreshCw } from 'lucide-react';
import { resizeImage } from './BeforeAfterSlider';
import { submitPhotoTransfer } from './db';

// Vista mínima y aislada que abre el celular al escanear el QR del puente de fotos (ver
// PhotoBridgeModal en App.tsx). A propósito NO pasa por el login/licencia de la app: quien
// sostiene el celular ya está frente a la PC autenticada, y forzarlo a iniciar sesión ahí
// consumiría uno de los 3 dispositivos permitidos por licencia solo para tomar una foto.
export function MobileUploadPage({ token, slotLabel, sideLabel }: { token: string; slotLabel?: string; sideLabel?: string }) {
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [preview, setPreview] = useState('');

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setStatus('sending');
    try {
      const resized = await resizeImage(file);
      setPreview(resized);
      await submitPhotoTransfer(token, resized);
      setStatus('sent');
    } catch (err) {
      console.error('Error al enviar la foto desde el celular:', err);
      setStatus('error');
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-amber-50 via-white to-white flex flex-col items-center justify-center p-6 text-center">
      <div className="w-full max-w-sm space-y-6">
        <div className="space-y-1">
          <h1 className="font-outfit text-xl font-bold text-slate-800">Enviar foto a la ficha</h1>
          <p className="text-sm text-slate-500">Toma o elige una foto. Aparecerá sola en la computadora en unos segundos.</p>
        </div>

        {slotLabel && (
          <div className="bg-slate-800 text-white rounded-2xl py-3 px-4">
            <p className="text-[10px] uppercase tracking-widest text-slate-300">Esta foto es para</p>
            <p className="font-outfit text-lg font-bold">{slotLabel} · {sideLabel}</p>
          </div>
        )}

        {status === 'sent' ? (
          <div className="bg-emerald-50 border border-emerald-200 rounded-3xl p-8 space-y-3">
            <CheckCircle2 className="w-12 h-12 text-emerald-500 mx-auto" />
            <p className="font-bold text-emerald-700">¡Foto enviada!</p>
            <p className="text-xs text-emerald-600">Ya puedes cerrar esta pestaña y volver a la computadora.</p>
            {preview && <img src={preview} alt="Enviada" className="rounded-2xl w-full object-cover max-h-64 mx-auto" />}
            <button
              type="button"
              onClick={() => { setStatus('idle'); setPreview(''); }}
              className="text-xs font-bold text-emerald-700 underline inline-flex items-center gap-1"
            >
              <RefreshCw className="w-3 h-3" /> Enviar otra foto
            </button>
          </div>
        ) : (
          <label className={`block cursor-pointer rounded-3xl border-2 border-dashed p-10 space-y-3 transition-colors ${status === 'error' ? 'border-red-300 bg-red-50' : 'border-amber-300 bg-amber-50/50 hover:bg-amber-50'}`}>
            {status === 'sending' ? (
              <Loader2 className="w-10 h-10 text-amber-500 mx-auto animate-spin" />
            ) : (
              <Camera className="w-10 h-10 text-amber-500 mx-auto" />
            )}
            <p className="font-bold text-slate-700 text-sm">
              {status === 'sending' ? 'Enviando...' : status === 'error' ? 'Algo falló, intenta de nuevo' : 'Tomar o elegir foto'}
            </p>
            <input
              type="file"
              accept="image/*"
              className="hidden"
              disabled={status === 'sending'}
              onChange={handleFile}
            />
          </label>
        )}

        <p className="text-[11px] text-slate-400 flex items-center justify-center gap-1.5">
          <ImageIcon className="w-3.5 h-3.5" /> La foto se comprime antes de enviarse, no ocupa espacio de tu plan de datos ni de tu galería.
        </p>
      </div>
    </div>
  );
}
