# dermatique-license-worker

Código fuente del Worker de Cloudflare que valida y emite licencias
(`https://dermatique-license-worker.carlosgbd94.workers.dev`). No se despliega
desde este repositorio — Claude Code no tiene acceso a la cuenta de Cloudflare
del usuario — así que cualquier cambio a `license-worker.js` debe desplegarse
manualmente:

```bash
# Con wrangler, desde este directorio (requiere wrangler.toml con el nombre
# del Worker y las variables de entorno TURSO_URL, TURSO_TOKEN,
# MASTER_LICENSE_KEY, PAYPAL_CLIENT_ID, PAYPAL_SECRET ya configuradas como
# secretos en Cloudflare, o pégalo directamente en el editor del dashboard).
wrangler deploy license-worker.js
```

O simplemente copia y pega el contenido de `license-worker.js` en el editor
del Worker desde el dashboard de Cloudflare y publica.

## Cambios respecto a la versión anterior

Se añadió un tope de **3 dispositivos distintos por licencia** (tabla nueva
`license_devices` en Turso, creada automáticamente en el primer uso). Antes,
una licencia validaba sin límite en cualquier cantidad de dispositivos.

- `/validate` y `/issue` ahora aceptan un campo `deviceId` opcional (UUID
  generado y guardado en `localStorage` por el cliente).
- Al activarse en un dispositivo nuevo, se registra en `license_devices`
  hasta llegar a 3; el cuarto dispositivo distinto recibe
  `{ valid: false, reason: "device_limit" }`.
- El mismo dispositivo puede volver a validar sin consumir un cupo nuevo.
- La clave maestra (`MASTER_LICENSE_KEY`) no está sujeta a este límite.
- Clientes viejos que no manden `deviceId` no se bloquean, pero tampoco
  cuentan para el límite (no hay forma de identificarlos).
- `/validate` y `/issue` ahora también regresan `devices: { used, max }` (cuando se
  mandó `deviceId`) para que el cliente pueda mostrar "2 de 3 dispositivos usados".
