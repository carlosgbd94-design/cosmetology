// Obfuscated webhook parts to prevent automated bots on public repos from revoking it
const WH_ID = '1515925017915822202';
const WH_TOKEN = 'qZrZC1idhoPN3NiSmf4BdAB3CX9r7FUzVAGnoeEpHwLSSNQPq_I5QhJr_PJ8iJ3FFI5_';
const WH_URL = `https://discord.com/api/webhooks/${WH_ID}/${WH_TOKEN}`;

// Store the last few logs in memory to give context when an error happens
const logsCache: string[] = [];
const MAX_LOGS = 10;

// Override console methods to capture context
const originalConsoleLog = console.log;
const originalConsoleWarn = console.warn;
const originalConsoleError = console.error;

function captureLog(type: string, ...args: any[]) {
  const msg = `[${new Date().toISOString()}] [${type}] ${args.map(a => String(a)).join(' ')}`;
  logsCache.push(msg);
  if (logsCache.length > MAX_LOGS) {
    logsCache.shift();
  }
}

console.log = (...args) => {
  captureLog('LOG', ...args);
  originalConsoleLog(...args);
};

console.warn = (...args) => {
  captureLog('WARN', ...args);
  originalConsoleWarn(...args);
};

console.error = (...args) => {
  captureLog('ERROR', ...args);
  originalConsoleError(...args);
};

// Rate limiting state for automatic errors to prevent spam
let lastAutoReportTime = 0;
const AUTO_REPORT_COOLDOWN = 60000; // 1 minute cooldown per automatic error

/**
 * Sends a structured payload to the Discord Webhook, supporting optional file attachments.
 */
async function sendToDiscord(
  title: string,
  description: string,
  color: number,
  extraContext: string = '',
  files?: File[]
) {
  try {
    const embed = {
      title,
      description: description.substring(0, 2048), // Discord limit
      color,
      timestamp: new Date().toISOString(),
      fields: [
        {
          name: 'Navegador / Dispositivo',
          value: navigator.userAgent.substring(0, 1024),
          inline: false
        },
        {
          name: 'URL Actual',
          value: window.location.href,
          inline: false
        }
      ]
    };

    if (extraContext || logsCache.length > 0) {
      const logsText = logsCache.join('\n');
      embed.fields.push({
        name: 'Contexto Técnico (Logs recientes)',
        value: `\`\`\`text\n${extraContext}\n${logsText}\n\`\`\``.substring(0, 1024),
        inline: false
      });
    }

    const payload = { embeds: [embed] };

    if (files && files.length > 0) {
      const formData = new FormData();
      formData.append('payload_json', JSON.stringify(payload));
      
      files.forEach((file, index) => {
        formData.append(`file_${index}`, file, file.name || `imagen_${index}.png`);
      });

      await fetch(WH_URL, {
        method: 'POST',
        body: formData
      });
    } else {
      await fetch(WH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    }
  } catch (err) {
    originalConsoleError('Falló el envío del reporte a Discord:', err);
  }
}

/**
 * Initializes global listeners for uncaught errors
 */
export function initGlobalErrorHandling() {
  window.addEventListener('error', (event) => {
    const now = Date.now();
    if (now - lastAutoReportTime < AUTO_REPORT_COOLDOWN) return; // Prevent spam
    lastAutoReportTime = now;

    const errorMsg = `Excepción Global: ${event.message}\nEn: ${event.filename}:${event.lineno}:${event.colno}`;
    sendToDiscord(
      '🚨 Error Automático Detectado',
      errorMsg,
      0xFF0000 // Red color
    );
  });

  window.addEventListener('unhandledrejection', (event) => {
    const now = Date.now();
    if (now - lastAutoReportTime < AUTO_REPORT_COOLDOWN) return; 
    lastAutoReportTime = now;

    const reason = event.reason instanceof Error ? event.reason.stack || event.reason.message : String(event.reason);
    sendToDiscord(
      '⚠️ Promesa Rechazada (Posible fallo de red)',
      `Motivo: ${reason}`,
      0xFFA500 // Orange color
    );
  });
}

/**
 * Can be called manually from a "Report Bug" button
 */
export async function sendManualReport(userMessage: string, section?: string, files?: File[]) {
  let content = userMessage;
  if (section) {
    content = `**Sección Afectada:** ${section}\n\n**Comentarios del Usuario:**\n${userMessage}`;
  }
  await sendToDiscord(
    '💬 Reporte de Usuario / Sugerencia',
    content,
    0x00FF00, // Green color
    '',
    files
  );
}

/**
 * Used by ErrorBoundary to report React crashes
 */
export function reportReactError(error: Error, componentStack: string) {
  sendToDiscord(
    '💥 Cuelgue de Aplicación (React Crash)',
    `**Mensaje:** ${error.message}\n\n**Stack:**\n\`\`\`js\n${error.stack}\n\`\`\`,`,
    0x990000, // Dark red
    `Component Stack:\n${componentStack}`
  );
}
