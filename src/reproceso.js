import { logger } from './logger.js';
import { aPng } from './imagenes.js';

function dormir(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function bajarImagen(url) {
  if (!/^https?:\/\//i.test(String(url || ''))) return null;

  const controlador = new AbortController();
  const temporizador = setTimeout(() => controlador.abort(), 20000);

  try {
    const respuesta = await fetch(url, { signal: controlador.signal });
    if (!respuesta.ok) return null;
    const mime = respuesta.headers.get('content-type') || 'image/jpeg';
    if (!mime.startsWith('image/')) return null;
    return { buffer: Buffer.from(await respuesta.arrayBuffer()), mime };
  } catch {
    return null;
  } finally {
    clearTimeout(temporizador);
  }
}

/**
 * Reprocesa filas ya guardadas en la base: les genera el texto con IA
 * usando el OCR/URL de imagen que ya están en Supabase (no toca WhatsApp).
 */
export function crearReproceso({ cfg, db, ocr, mistral }) {
  let corriendo = false;
  let ultimo = null;

  async function procesarFila(fila) {
    const campos = {};

    let entrada = String(fila.texto_ocr || '').trim();
    if (!entrada) entrada = String(fila.metadata?.texto_original || '').trim();

    if (!entrada && fila.imagen_url) {
      const media = await bajarImagen(fila.imagen_url);
      if (media) {
        let buffer = media.buffer;
        if (media.mime === 'image/webp') {
          const png = await aPng(media.buffer);
          if (png) buffer = png;
        }
        const texto = await ocr.reconocer(buffer);
        if (texto.trim()) {
          entrada = texto.trim();
          campos.texto_ocr = entrada;
        }
      }
      if (!entrada) return { campos: { ...campos, estado: 'sin_texto', error: null }, tipo: 'sin_texto' };
    }

    if (!entrada) return { campos: { ...campos, estado: 'sin_texto', error: null }, tipo: 'sin_texto' };

    try {
      const r = await mistral.generar(entrada);
      return {
        campos: { ...campos, texto_ia: r.texto, modelo_ia: r.modelo, estado: 'procesada', error: null },
        tipo: 'generada',
      };
    } catch (err) {
      return {
        campos: { ...campos, estado: 'error', error: err?.message || String(err) },
        tipo: 'error',
      };
    }
  }

  async function ejecutar({ todo = false } = {}) {
    if (!db.disponible) return { ok: false, motivo: 'supabase_no_configurado' };
    if (!mistral.disponible()) return { ok: false, motivo: 'mistral_no_configurado' };
    if (corriendo) return { ok: false, motivo: 'en_curso', ultimo };

    corriendo = true;
    const inicio = Date.now();
    const resumen = { total: 0, generadas: 0, sinTexto: 0, errores: 0, todo, inicio: new Date().toISOString() };

    try {
      logger.info('Reproceso', todo ? 'Reprocesando filas (regenerar textos)...' : 'Buscando filas sin texto_ia...');

      const lote = await db.listarParaReprocesar({ limite: cfg.reprocesoLote, todo });

      if (!lote.ok) {
        resumen.error = lote.error;
      } else if (!lote.filas.length) {
        logger.info('Reproceso', 'No hay filas pendientes');
      } else {
        for (const fila of lote.filas) {
          const { campos, tipo } = await procesarFila(fila);
          const r = await db.actualizarPublicacion(fila.id, campos);
          if (!r.ok) resumen.errores += 1;

          resumen.total += 1;
          if (tipo === 'generada') resumen.generadas += 1;
          else if (tipo === 'error') resumen.errores += 1;
          else resumen.sinTexto += 1;

          if (resumen.total % 10 === 0) {
            logger.info('Reproceso', `Procesadas ${resumen.total} (${resumen.generadas} con IA, ${resumen.sinTexto} sin texto, ${resumen.errores} errores)`);
          }

          await dormir(cfg.pausaPublicacionesMs);
        }

        if (lote.filas.length >= cfg.reprocesoLote) {
          logger.info('Reproceso', 'Puede haber más filas pendientes: ejecuta /reprocesar otra vez');
        }
      }
    } finally {
      corriendo = false;
      resumen.duracionMs = Date.now() - inicio;
      resumen.ok = !resumen.error;
      ultimo = resumen;
      logger.info('Reproceso', `Terminado: ${resumen.total} filas, ${resumen.generadas} con IA, ${resumen.sinTexto} sin texto, ${resumen.errores} errores`, {
        duracionMs: resumen.duracionMs,
      });
    }

    return resumen;
  }

  return { ejecutar, estado: () => ({ corriendo, ultimo }), disponible: () => db.disponible && mistral.disponible() };
}
