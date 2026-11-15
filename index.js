import 'dotenv/config';

import { config } from './src/config.js';
import { logger } from './src/logger.js';
import { crearServer } from './src/server.js';
import { WhatsappService } from './src/whatsapp/client.js';
import { crearSessionStore } from './src/whatsapp/sessionStore.js';
import { crearOcr } from './src/ocr/ocrService.js';
import { crearMistral } from './src/ai/mistralService.js';
import { crearDb } from './src/db/supabase.js';
import { iniciarPipeline } from './src/pipeline.js';
import { crearReproceso } from './src/reproceso.js';

const cfg = config();

logger.info('Main', 'Iniciando api_canales', {
  canales: cfg.canales.length,
  intervaloMinutos: cfg.intervaloMinutos,
  puerto: cfg.puerto,
  respaldoSesion: cfg.respaldoSesion,
});

const db = crearDb(cfg);
const ocr = crearOcr(cfg);
const mistral = crearMistral(cfg);

const sessionStore = crearSessionStore({ cfg, db });
if (sessionStore.activo) {
  await sessionStore.restaurar();
}

let pipelineRef = { ejecutarAhora: () => {} };
const whatsapp = new WhatsappService({
  cfg,
  onListo: () => {
    sessionStore
      .respaldar({ forzar: true })
      .catch((err) => logger.warn('Sesion', 'Respaldo inicial falló', err?.message));
    pipelineRef.ejecutarAhora();
  },
  onSesionInvalida: () => {
    sessionStore
      .limpiarRemoto()
      .catch((err) => logger.warn('Sesion', 'No se pudo limpiar el respaldo remoto', err?.message));
  },
});

const pipeline = iniciarPipeline({ cfg, whatsapp, db, ocr, mistral });
pipelineRef = pipeline;

const reproceso = crearReproceso({ cfg, db, ocr, mistral });

sessionStore.iniciar({ estaConectado: () => whatsapp.conectado() });

crearServer({ cfg, whatsapp, pipeline, reproceso });

if (cfg.reprocesarAlIniciar && reproceso.disponible()) {
  setTimeout(() => {
    reproceso
      .ejecutar()
      .catch((err) => logger.warn('Reproceso', 'Fallo el reproceso inicial', err?.message));
  }, 10000);
}

const cerrar = async (senal) => {
  logger.info('Main', `${senal}: respaldando sesión y cerrando...`);
  try {
    await Promise.race([
      sessionStore.respaldar({ forzar: true }),
      new Promise((r) => setTimeout(r, 8000)),
    ]);
  } catch {
    // mejor esfuerzo
  }
  sessionStore.detener();
  await whatsapp.desconectar().catch(() => {});
  process.exit(0);
};

process.on('SIGTERM', () => cerrar('SIGTERM'));
process.on('SIGINT', () => cerrar('SIGINT'));

process.on('unhandledRejection', (razon) => {
  logger.error('Main', 'unhandledRejection', String(razon));
});
