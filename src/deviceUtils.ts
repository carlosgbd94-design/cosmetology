// Detección de dispositivo por capacidades reales, no por userAgent. OJO: esto NO es tan simple como
// "pointer: coarse" — desde iPadOS 13, Safari en iPad se anuncia como "clase escritorio" y reporta
// pointer:fine / hover:hover exactamente igual que una laptop con trackpad, aunque el dispositivo sea
// 100% táctil y no tenga mouse. Confiar solo en la media query de puntero deja fuera al dispositivo
// que más importa aquí (iPad), así que primero se resuelve ese caso con la señal que sí es confiable:
// un Mac real (trackpad) siempre reporta maxTouchPoints=0; un iPad, sin importar cómo se anuncie el
// puntero, siempre reporta varios puntos de contacto reales.
export function isTouchPrimaryDevice(): boolean {
  if (typeof navigator === 'undefined') return false;
  const maxTouch = navigator.maxTouchPoints || 0;
  if (maxTouch === 0) return false; // sin capacidad táctil alguna: descartar de inmediato

  const looksLikeMac = /Mac/.test(navigator.platform || '') || /Macintosh/.test(navigator.userAgent || '');
  if (looksLikeMac) return maxTouch > 1; // iPad (masquerading as Mac) vs. Mac real con trackpad

  // Resto de dispositivos táctiles (Android, Windows touch, iPhone): aquí sí es confiable.
  if (typeof window !== 'undefined' && window.matchMedia) {
    return window.matchMedia('(pointer: coarse)').matches || window.matchMedia('(hover: none)').matches;
  }
  return maxTouch > 1;
}

const DEVICE_ID_KEY = 'dermatique_device_id';

// Identificador anónimo y estable por dispositivo/navegador, usado únicamente para contar cuántos
// dispositivos distintos han activado una misma licencia (tope de 3, ver license-worker). No es un
// fingerprint de hardware: vive en localStorage, así que borrar datos del navegador genera uno nuevo,
// pero eso es un caso raro, no el uso normal de "un especialista con una tablet".
export function getOrCreateDeviceId(): string {
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : `dev-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    localStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}
