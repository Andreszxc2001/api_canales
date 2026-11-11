import { createWorker } from 'tesseract.js';

import { logger } from '../logger.js';

/**
 * OCR con tesseract.js (gratis, corre dentro del proceso).
 * Descarga los datos del idioma la primera vez y los cachea en tmp.
 * El worker se apaga solo tras unos minutos sin uso para liberar RAM.
 */
export function crearOcr(cfg) {
  let worker = null;
  let creando = null;
  let enUso = 0;
  let idleTimer = null;
  const idleMs = Math.max(1, Number(cfg.ocrIdleMinutos) || 10) * 60_000;

  function agendarApagado() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (enUso === 0) terminar();
    }, idleMs);
  }

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
    enUso += 1;
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
    } finally {
      enUso -= 1;
      if (enUso === 0) agendarApagado();
    }
  }

  async function terminar() {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    try {
      if (worker) {
        await worker.terminate();
        logger.info('OCR', 'Worker tesseract liberado (inactivo)');
      }
    } catch {
      // ignorar
    }
    worker = null;
  }

  return { reconocer, terminar };
}
