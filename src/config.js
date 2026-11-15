import { logger } from './logger.js';

const PROMPT_POR_DEFECTO =
  'Eres un redactor editorial profesional. Recibes el texto extraído por OCR de una ' +
  'imagen publicada en un canal de WhatsApp (normalmente imágenes informativas generadas ' +
  'con IA). Tu tarea es elaborar un texto claro, bien redactado y listo para publicar en ' +
  'una página web: un título breve en la primera línea, luego párrafos cortos y fáciles de leer. ' +
  'Usa solo la información presente en el texto, sin inventar ni agregar datos. Si el texto ' +
  'tiene errores evidentes de OCR, corrígelos con sentido común. Responde solo con el texto final, sin explicaciones.';

function numero(valor, defecto) {
  const n = Number(valor);
  return Number.isFinite(n) ? n : defecto;
}

export function config() {
  const canales = String(process.env.CANALES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const cfg = {
    puerto: Number(process.env.PORT) || Number(process.env.PUERTO) || 3000,
    dataDir: String(process.env.DATA_DIR || './data').replace(/\/+$/, ''),
    canales,
    intervaloMinutos: Math.max(1, numero(process.env.INTERVALO_MINUTOS, 2)),
    limiteMensajes: Math.max(1, numero(process.env.LIMITE_MENSAJES, 50)),
    primerasHoras: Math.max(0, numero(process.env.PRIMERAS_HORAS, 24)),
    ocrIdioma: String(process.env.OCR_IDIOMA || 'spa'),
    ocrIdleMinutos: Math.max(1, numero(process.env.OCR_IDLE_MINUTOS, 10)),

    mistralApiKey: String(process.env.MISTRAL_API_KEY || ''),
    mistralUrl: String(process.env.MISTRAL_URL || 'https://api.mistral.ai/v1/chat/completions'),
    mistralModel: String(process.env.MISTRAL_MODEL || 'mistral-large-latest'),
    mistralTemperatura: numero(process.env.MISTRAL_TEMPERATURA, 0.3),
    mistralMaxTokens: Math.max(1, numero(process.env.MISTRAL_MAX_TOKENS, 4000)),
    mistralTimeoutMs: Math.max(5000, numero(process.env.MISTRAL_TIMEOUT_MS, 120000)),
    mistralPrompt: String(process.env.MISTRAL_PROMPT || PROMPT_POR_DEFECTO),

    supabaseUrl: String(process.env.SUPABASE_URL || ''),
    supabaseKey: String(process.env.SUPABASE_SERVICE_ROLE_KEY || ''),
    supabaseBucket: String(process.env.SUPABASE_BUCKET || 'imagenes_posts'),
    pausaPublicacionesMs: Math.max(0, numero(process.env.PAUSA_PUBLICACIONES_MS, 1500)),
    respaldoSesion: String(process.env.RESPALDO_SESION || 'true').toLowerCase() !== 'false',
    respaldoSesionMinutos: Math.max(1, numero(process.env.RESPALDO_SESION_MINUTOS, 15)),
    reprocesarAlIniciar: String(process.env.REPROCESAR_AL_INICIAR || 'true').toLowerCase() !== 'false',
    reprocesoLote: Math.max(1, numero(process.env.REPROCESO_LOTE, 200)),
    convertirWebp: String(process.env.CONVERTIR_WEBP || 'true').toLowerCase() !== 'false',
    webpCalidad: Math.min(100, Math.max(10, numero(process.env.WEBP_CALIDAD, 80))),
    esperaListoSegundos: Math.min(300, Math.max(10, numero(process.env.ESPERA_LISTO_SEGUNDOS, 45))),
    navegadorTimeoutSegundos: Math.min(600, Math.max(30, numero(process.env.NAVEGADOR_TIMEOUT_SEGUNDOS, 120))),
    whatsappTelefono: String(process.env.WHATSAPP_TELEFONO || '').replace(/\D/g, ''),
  };

  if (!cfg.canales.length) {
    logger.info('Config', 'CANALES vacío: modo AUTOMÁTICO (se monitorean todos los canales suscritos)');
  }
  if (!cfg.mistralApiKey) {
    logger.warn('Config', 'MISTRAL_API_KEY está vacía: Mistral no podrá generar texto');
  }
  if (!cfg.supabaseUrl || !cfg.supabaseKey) {
    logger.warn('Config', 'Supabase no configurado (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)');
  }

  return cfg;
}
