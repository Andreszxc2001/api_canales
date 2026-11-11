import fs from 'fs';
import path from 'path';

import { logger } from '../logger.js';

const PREFIJO = 'sesion-whatsapp';
const MARCADOR = '_respaldo.json';
const CONCURRENCIA = 4;

// Archivos que no hace falta respaldar: cachés regenerables y locks de Chromium.
const EXCLUIR = [
  /(^|\/)(Cache|Code Cache|GPUCache|DawnGraphiteCache|DawnWebGPUCache|GraphiteDawnCache|ShaderCache|GrShaderCache|Crashpad)(\/|$)/,
  /(^|\/)Service Worker(\/|$)/,
  /(^|\/)(SingletonLock|SingletonCookie|SingletonSocket|DevToolsActivePort|lockfile)$/,
];

function ignorar(rel) {
  const norm = rel.split(path.sep).join('/');
  return EXCLUIR.some((re) => re.test(norm));
}

function codificar(rel) {
  return Buffer.from(rel, 'utf8').toString('base64url');
}

function decodificar(nombre) {
  return Buffer.from(nombre, 'base64url').toString('utf8');
}

async function listarArchivos(base, actual = base, salida = []) {
  const entradas = await fs.promises.readdir(actual, { withFileTypes: true });
  for (const entrada of entradas) {
    const abs = path.join(actual, entrada.name);
    const rel = path.relative(base, abs);
    if (entrada.isDirectory()) {
      if (ignorar(`${rel}/`)) continue;
      await listarArchivos(base, abs, salida);
    } else if (entrada.isFile() && !ignorar(rel)) {
      salida.push({ abs, rel });
    }
  }
  return salida;
}

async function enLotes(items, tamano, fn) {
  for (let i = 0; i < items.length; i += tamano) {
    await Promise.all(items.slice(i, i + tamano).map(fn));
  }
}

/**
 * Respalda y restaura la sesión de WhatsApp (LocalAuth) en Supabase Storage.
 * Permite sobrevivir a reinicios/redeploys de Render sin re-escanear el QR.
 */
export function crearSessionStore({ cfg, db }) {
  const dirSesion = path.join(cfg.dataDir, 'whatsapp-session');
  const intervaloMs = cfg.respaldoSesionMinutos * 60_000;

  let ultimoRespaldo = 0;
  let respaldando = null;
  let limpiando = null;
  let temporizador = null;

  const activo = cfg.respaldoSesion && db.disponible;

  async function restaurar() {
    if (!activo) return false;

    const listado = await db.storageListar(PREFIJO);
    if (!listado.ok) {
      logger.warn('Sesion', 'No se pudo leer el respaldo de la sesión', listado.error);
      return false;
    }

    const nombres = listado.objetos.map((o) => o.name);
    if (!nombres.includes(MARCADOR)) {
      logger.info('Sesion', 'No hay respaldo de sesión en Supabase (se pedirá QR)');
      return false;
    }

    let restaurados = 0;
    let fallidos = 0;

    for (const nombre of nombres) {
      if (nombre === MARCADOR) continue;
      const ruta = `${PREFIJO}/${nombre}`;
      const descarga = await db.storageDescargar(ruta);
      if (!descarga.ok) {
        fallidos += 1;
        continue;
      }

      const rel = decodificar(nombre);
      const destino = path.join(dirSesion, rel);
      try {
        await fs.promises.mkdir(path.dirname(destino), { recursive: true });
        await fs.promises.writeFile(destino, descarga.buffer);
        restaurados += 1;
      } catch (err) {
        fallidos += 1;
        logger.warn('Sesion', `No se pudo escribir ${rel}`, err?.message);
      }
    }

    logger.info('Sesion', `Sesión restaurada desde Supabase (${restaurados} archivos)`, { fallidos });
    return restaurados > 0;
  }

  async function respaldar({ forzar = false } = {}) {
    if (!activo) return { ok: false, motivo: 'inactivo' };
    if (respaldando) return respaldando;
    if (!forzar && Date.now() - ultimoRespaldo < intervaloMs) {
      return { ok: false, motivo: 'reciente' };
    }

    respaldando = (async () => {
      let archivos;
      try {
        archivos = await listarArchivos(dirSesion);
      } catch {
        logger.info('Sesion', 'Todavía no hay archivos de sesión para respaldar');
        return { ok: false, motivo: 'sin_archivos' };
      }

      if (!archivos.length) return { ok: false, motivo: 'sin_archivos' };

      let subidos = 0;
      let errores = 0;

      await enLotes(archivos, CONCURRENCIA, async (archivo) => {
        try {
          const buffer = await fs.promises.readFile(archivo.abs);
          const r = await db.storageSubir(`${PREFIJO}/${codificar(archivo.rel)}`, buffer);
          if (r.ok) subidos += 1;
          else errores += 1;
        } catch {
          errores += 1;
        }
      });

      // El marcador se sube de último: su presencia indica que el respaldo está completo.
      const marcador = Buffer.from(
        JSON.stringify({ actualizadoEn: new Date().toISOString(), archivos: subidos, errores }),
        'utf8'
      );
      await db.storageSubir(
        `${PREFIJO}/${MARCADOR}`,
        marcador,
        'application/json'
      );

      ultimoRespaldo = Date.now();

      if (subidos > 0) {
        logger.info('Sesion', `Sesión respaldada en Supabase (${subidos} archivos)`, { errores });
      } else {
        logger.warn('Sesion', 'No se pudo respaldar la sesión', { errores });
      }

      return { ok: subidos > 0, subidos, errores };
    })().finally(() => {
      respaldando = null;
    });

    return respaldando;
  }

  async function limpiarRemoto() {
    if (!activo) return;
    if (limpiando) return limpiando;

    limpiando = (async () => {
      const listado = await db.storageListar(PREFIJO);
      if (!listado.ok) return;
      const rutas = listado.objetos.map((o) => `${PREFIJO}/${o.name}`);
      if (!rutas.length) return;

      const r = await db.storageBorrar(rutas);
      if (r.ok) {
        ultimoRespaldo = 0;
        logger.info('Sesion', `Respaldo remoto de sesión eliminado (${rutas.length} archivos)`);
      }
    })().finally(() => {
      limpiando = null;
    });

    return limpiando;
  }

  function iniciar({ estaConectado }) {
    if (!activo) {
      if (cfg.respaldoSesion && !db.disponible) {
        logger.info('Sesion', 'Respaldo de sesión desactivado (Supabase no configurado)');
      }
      return;
    }

    logger.info('Sesion', `Respaldo de sesión cada ${cfg.respaldoSesionMinutos} min`);
    temporizador = setInterval(() => {
      if (estaConectado && !estaConectado()) return;
      respaldar().catch((err) => logger.warn('Sesion', 'Fallo el respaldo de sesión', err?.message));
    }, intervaloMs);
  }

  function detener() {
    if (temporizador) {
      clearInterval(temporizador);
      temporizador = null;
    }
  }

  return { activo, restaurar, respaldar, limpiarRemoto, iniciar, detener };
}
