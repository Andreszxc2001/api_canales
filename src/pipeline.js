import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';
import { publicacionesNuevas, descargarMultimedia, normalizarCanalInput, listarCanales } from './whatsapp/channels.js';
import { fechaHoraDesdeTimestamp, tipoNormalizado, idDeMensaje, nombreSeguro } from './util.js';
import { convertirAWebp } from './imagenes.js';

const EXTENSIONES = {
  'image/png': 'png',
  'image/webp': 'webp',
};

async function guardarImagen(canalId, mensajeId, media, dataDir) {
  try {
    const ext = EXTENSIONES[media.mime] || 'jpg';
    const dir = path.join(dataDir, 'imagenes', nombreSeguro(canalId) || 'canal');
    await fs.promises.mkdir(dir, { recursive: true });
    const nombre = `${nombreSeguro(mensajeId) || 'msg'}.${ext}`;
    await fs.promises.writeFile(path.join(dir, nombre), media.buffer);
    return path.posix.join('imagenes', nombreSeguro(canalId) || 'canal', nombre);
  } catch (err) {
    logger.warn('Pipeline', 'No se pudo guardar la imagen localmente', err?.message);
    return null;
  }
}

function claveDeCanal(canalInput) {
  const norm = normalizarCanalInput(canalInput);
  if (!norm.ok) return String(canalInput).trim();
  return norm.tipo === 'id' ? norm.valor : norm.raw;
}

function dormir(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Normaliza un mensaje de whatsapp-web.js a la misma forma que usa Evolution.
 */
function adaptarWweb(msg) {
  return {
    id: idDeMensaje(msg) || `${msg.timestamp}-${msg.body}`,
    timestamp: Number(msg.timestamp) || 0,
    body: typeof msg.body === 'string' ? msg.body : '',
    tipo: tipoNormalizado(msg),
    descargarMedia: () => descargarMultimedia(msg),
  };
}

/**
 * Procesa una publicación: descarga imagen -> Storage -> OCR -> Mistral -> fila para la DB.
 */
async function procesarPublicacion(pub, { canalId, nombre }, { cfg, db, ocr, mistral }) {
  const mensajeId = pub.id || `${canalId}-${pub.timestamp}`;
  const ts = Number(pub.timestamp) || Math.floor(Date.now() / 1000);
  const { fecha, hora, datetime } = fechaHoraDesdeTimestamp(ts);
  const body = typeof pub.body === 'string' ? pub.body.trim() : '';
  const tipo = pub.tipo;

  const row = {
    mensaje_id: mensajeId,
    canal_id: canalId,
    canal_nombre: nombre,
    fecha_publicacion: new Date(ts * 1000).toISOString(),
    tipo,
    imagen_url: null,
    texto_ocr: null,
    texto_ia: null,
    modelo_ia: null,
    estado: 'procesada',
    error: null,
    metadata: { fecha, hora, datetime, texto_original: body || null },
  };

  if (tipo === 'imagen') {
    const media = await pub.descargarMedia();
    if (media?.buffer?.length) {
      // Se sube en WebP para ahorrar espacio; el OCR usa la imagen original.
      let paraGuardar = media;
      if (cfg.convertirWebp && media.mime !== 'image/webp') {
        const webp = await convertirAWebp(media.buffer, cfg.webpCalidad);
        if (webp) paraGuardar = { buffer: webp, mime: 'image/webp' };
      }

      const urlStorage = await db.subirImagen({
        canalId,
        mensajeId,
        buffer: paraGuardar.buffer,
        mime: paraGuardar.mime,
      });

      if (urlStorage) {
        row.imagen_url = urlStorage;
      } else {
        const rutaLocal = await guardarImagen(canalId, mensajeId, paraGuardar, cfg.dataDir);
        if (rutaLocal) row.imagen_url = rutaLocal;
      }

      const texto = await ocr.reconocer(media.buffer);
      row.texto_ocr = texto.trim() || null;
    }
  }

  const entrada = row.texto_ocr || body || null;

  if (!entrada) {
    row.estado = 'sin_texto';
    return row;
  }

  if (!mistral.disponible()) {
    row.estado = 'sin_ia';
    return row;
  }

  try {
    const r = await mistral.generar(entrada);
    row.texto_ia = r.texto;
    row.modelo_ia = r.modelo;
  } catch (err) {
    row.estado = 'error';
    row.error = err?.message || String(err);
  }

  return row;
}

/**
 * Orquestador: cada INTERVALO_MINUTOS consulta los canales y procesa lo nuevo.
 */
export function iniciarPipeline({ cfg, whatsapp, evolution, db, ocr, mistral }) {
  let corriendo = false;
  let ultimoCiclo = null;
  const canalesVistos = new Set();
  const usarEvolution = Boolean(evolution?.disponible());

  /**
   * Canales a monitorear:
   * - Si CANALES está configurado, se usan esos (modo filtro).
   * - Si está vacío, se descubren automáticamente TODOS los canales suscritos
   *   (si te unes a un canal nuevo, lo agarra en el siguiente ciclo).
   */
  async function obtenerCanales() {
    if (cfg.canales.length) return cfg.canales;

    if (usarEvolution) {
      const descubiertos = await evolution.listarCanales();
      for (const c of descubiertos) {
        if (canalesVistos.has(c.clave)) continue;
        logger.info('Pipeline', `Canal detectado (Evolution): "${c.nombre || c.clave}"`);
        canalesVistos.add(c.clave);
      }
      return descubiertos.map((c) => c.clave);
    }

    const descubiertos = await listarCanales(whatsapp.client);
    const ids = descubiertos.map((c) => c.id).filter(Boolean);

    for (const id of ids) {
      if (canalesVistos.has(id)) continue;
      const info = descubiertos.find((c) => c.id === id);
      logger.info('Pipeline', `Canal detectado: "${info?.nombre || id}"`);
      canalesVistos.add(id);
    }

    return ids;
  }

  async function conectado() {
    if (usarEvolution) {
      const estado = await evolution.estado();
      if (!estado.ok) {
        logger.info('Pipeline', 'Evolution API sin conexión o instancia cerrada', estado);
      }
      return estado.ok;
    }

    if (!whatsapp.conectado()) {
      await whatsapp.conectar();
      if (!whatsapp.conectado()) {
        logger.info('Pipeline', 'WhatsApp sin conexión todavía (QR pendiente en /qr)');
        return false;
      }
    }

    return true;
  }

  async function ejecutarCiclo() {
    if (corriendo) {
      logger.debug('Pipeline', 'Ciclo anterior aún en curso, se omite');
      return;
    }

    if (!(await conectado())) {
      ultimoCiclo = { fecha: new Date().toISOString(), ok: false, motivo: 'whatsapp_sin_conexion' };
      return;
    }

    corriendo = true;
    const inicio = Date.now();
    let nuevas = 0;
    let procesadas = 0;
    let errores = 0;

    try {
      const canalesActuales = await obtenerCanales();
      if (!canalesActuales.length) {
        logger.info('Pipeline', 'No se encontraron canales suscritos (únete a canales desde el WhatsApp y se detectarán solos)');
      }

      for (const canalInput of canalesActuales) {
        const clave = claveDeCanal(canalInput);

        let desdeTs = await db.leerEstado(clave);
        if (desdeTs == null) {
          desdeTs = Math.floor(Date.now() / 1000) - cfg.primerasHoras * 3600;
          logger.info('Pipeline', `Primera ejecución para "${canalInput}": se revisan las últimas ${cfg.primerasHoras}h`);
        }

        try {
          const resultado = usarEvolution
            ? await evolution.publicacionesNuevas({
                canalInput,
                desdeTs,
                limite: cfg.limiteMensajes,
              })
            : await publicacionesNuevas({
                client: whatsapp.client,
                canalInput,
                desdeTs,
                limite: cfg.limiteMensajes,
              });

          const { canalId, nombre } = resultado;
          const publicaciones = usarEvolution
            ? resultado.publicaciones
            : resultado.publicaciones.map(adaptarWweb);

          for (const pub of publicaciones) {
            if (!['imagen', 'texto'].includes(pub.tipo)) continue;
            if (!(Number(pub.timestamp) > Number(desdeTs))) continue;

            nuevas += 1;

            try {
              const row = await procesarPublicacion(pub, { canalId, nombre }, { cfg, db, ocr, mistral });
              await db.upsertPublicacion(row);
              procesadas += 1;
              if (row.estado === 'error') errores += 1;
              logger.info(
                'Pipeline',
                `Publicación ${row.mensaje_id} (${nombre}) -> estado=${row.estado}${
                  row.error ? ` | motivo: ${row.error}` : ''
                }${row.texto_ia ? ` | IA: ${row.texto_ia.slice(0, 80)}...` : ''}`
              );
            } catch (err) {
              errores += 1;
              logger.error('Pipeline', 'Fallo procesando una publicación', err?.message);
            }

            const ts = Number(pub.timestamp) || 0;
            if (ts > desdeTs) desdeTs = ts;

            if (cfg.pausaPublicacionesMs > 0) await dormir(cfg.pausaPublicacionesMs);
          }

          await db.guardarEstado(clave, desdeTs);
          logger.info(
            'Pipeline',
            `Canal "${nombre}" (${canalId}): ${publicaciones.length} nuevas publicaciones, ${procesadas} procesadas`
          );
        } catch (err) {
          errores += 1;
          logger.error('Pipeline', `Error con el canal "${canalInput}"`, err?.message);
        }
      }
    } finally {
      corriendo = false;
      ultimoCiclo = {
        fecha: new Date().toISOString(),
        duracionMs: Date.now() - inicio,
        nuevas,
        procesadas,
        errores,
        ok: errores === 0,
      };
    }
  }

  function ejecutarAhora() {
    return ejecutarCiclo().catch((err) => {
      logger.error('Pipeline', 'Ciclo falló', err?.message);
    });
  }

  const ms = cfg.intervaloMinutos * 60_000;
  setInterval(() => {
    ejecutarCiclo().catch((err) => {
      logger.error('Pipeline', 'Ciclo falló', err?.message);
    });
  }, ms);

  // Primer ciclo poco después de arrancar (para ver actividad temprano en logs).
  setTimeout(() => {
    ejecutarCiclo().catch((err) => {
      logger.error('Pipeline', 'Primer ciclo falló', err?.message);
    });
  }, 20000);

  logger.info(
    'Pipeline',
    `Iniciado: ciclo cada ${cfg.intervaloMinutos} min, proveedor ${
      usarEvolution ? `Evolution API (${cfg.evolutionInstancia})` : 'WhatsApp Web (Chromium)'
    }, ${
      cfg.canales.length ? `modo filtro (${cfg.canales.length} canal(es) fijos)` : 'modo AUTOMÁTICO (todos los canales suscritos)'
    }`
  );

  return { ejecutarAhora, estado: () => ultimoCiclo };
}
