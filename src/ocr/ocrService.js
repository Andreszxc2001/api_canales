import { createWorker } from 'tesseract.js';

import { logger } from '../logger.js';

/**
 * OCR con tesseract.js (gratis, corre dentro del proceso).
 * Descarga los datos del idioma la primera vez y los cachea en tmp.
 */
export function crearOcr(cfg) {
  let worker = null;
  let creando = null;

  async function obtenerWorker() {
    if (worker) return worker;
    if (creando) return creando;

    creando = (async () => {
      logger.info('OCR', `Creando worker tesseract (${cfg.ocrIdioma})...`);
      const w = await createWorker(cfg.ocrIdioma, 1, { logger: () => {} });
      worker = w;
      return w;
    })();

    try {
      return await creando;
    } finally {
      creando = null;
    }
  }

  async function reconocer(buffer) {
    try {
      const w = await obtenerWorker();
      const { data } = await w.recognize(buffer);
      return typeof data?.text === 'string' ? data.text : '';
    } catch (err) {
      logger.warn('OCR', 'Fallo el OCR, se reiniciará el worker en el próximo intento', err?.message);
      try {
        await worker?.terminate();
      } catch {
        // ignorar
      }
      worker = null;
      return '';
    }
  }

  async function terminar() {
    try {
      await worker?.terminate();
    } catch {
      // ignorar
    }
    worker = null;
  }

  return { reconocer, terminar };
}
