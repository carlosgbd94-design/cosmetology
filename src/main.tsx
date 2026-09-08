import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { ErrorBoundary } from './ErrorBoundary.tsx';
import { initGlobalErrorHandling } from './errorHandler.ts';
import { MobileUploadPage } from './MobileUploadPage.tsx';

// Initialize background error monitoring
initGlobalErrorHandling();

// El puente de fotos celular -> PC (ver PhotoBridgeModal en App.tsx) abre esta misma URL con
// ?mobileUpload=<token> desde el QR. Se detecta aquí, antes de montar <App/>, para que el celular
// nunca pase por la pantalla de login/licencia (no tiene el token de licencia guardado y no debería
// consumir uno de los dispositivos permitidos solo para mandar una foto).
const urlParams = new URLSearchParams(window.location.search);
const mobileUploadToken = urlParams.get('mobileUpload');
const mobileUploadSlot = urlParams.get('slot') || '';
const mobileUploadSide = urlParams.get('side') || '';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      {mobileUploadToken ? (
        <MobileUploadPage token={mobileUploadToken} slotLabel={mobileUploadSlot} sideLabel={mobileUploadSide} />
      ) : (
        <App />
      )}
    </ErrorBoundary>
  </StrictMode>,
);
