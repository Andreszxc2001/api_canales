import { createClient } from '@supabase/supabase-js';

import { logger } from '../logger.js';
import { nombreSeguro } from '../util.js';

/**
 * Cliente Supabase: upsert de publicaciones, estado del pipeline y Storage de imagenes.
 */
export function crearDb(cfg) {
  if (!cfg.supabaseUrl || !cfg.supabaseKey) {
    logger.warn('DB', 'Supabase no configurado: las publicaciones solo quedarán en los logs');
    return {
      disponible: false,
      async upsertPublicacion(row) {
        logger.info('DB', `Publicación (sin DB) ${row.mensaje_id} estado=${row.estado}`);
        return { ok: false, simulada: true };
      },
      async subirImagen() {
        return null;
      },
      async storageSubir() {
        return { ok: false, error: 'supabase_no_configurado' };
      },
      async storageDescargar() {
        return { ok: false, error: 'supabase_no_configurado' };
      },
      async storageListar() {
        return { ok: false, error: 'supabase_no_configurado', objetos: [] };
      },
      async storageBorrar() {
        return { ok: false, error: 'supabase_no_configurado' };
      },
      async listarParaReprocesar() {
        return { ok: false, error: 'supabase_no_configurado', filas: [] };
      },
      async actualizarPublicacion() {
        return { ok: false, error: 'supabase_no_configurado' };
      },
      async leerEstado() {
        return null;
      },
      async guardarEstado() {},
    };
  }

  const supabase = createClient(cfg.supabaseUrl, cfg.supabaseKey, {
    auth: { persistSession: false },
  });

  const estadosEnMemoria = new Map();
  let avisoLectura = false;
  let avisoEscritura = false;
  let avisoStorage = false;

  async function upsertPublicacion(row) {
    const { error } = await supabase.from('canales_publicaciones').upsert(row, { onConflict: 'mensaje_id' });
    if (error) {
      logger.error('DB', 'upsert en canales_publicaciones falló', error.message);
      return { ok: false, error: error.message };
    }
    return { ok: true };
  }

  /**
   * Sube la imagen al bucket de Supabase Storage y devuelve la URL pública.
   */
  async function subirImagen({ canalId, mensajeId, buffer, mime }) {
    const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
    const carpeta = nombreSeguro(canalId) || 'canal';
    const archivo = `${nombreSeguro(mensajeId) || 'msg'}.${ext}`;
    const ruta = `${carpeta}/${archivo}`;

    const { error } = await supabase.storage.from(cfg.supabaseBucket).upload(ruta, buffer, {
      contentType: mime || 'image/jpeg',
      upsert: true,
    });

    if (error) {
      if (!avisoStorage) {
        avisoStorage = true;
        logger.warn('Storage', `No se pudo subir la imagen al bucket "${cfg.supabaseBucket}"`, error.message);
      }
      return null;
    }

    const { data } = supabase.storage.from(cfg.supabaseBucket).getPublicUrl(ruta);
    return data?.publicUrl || null;
  }

  async function storageSubir(ruta, buffer, contentType = 'application/octet-stream') {
    const { error } = await supabase.storage.from(cfg.supabaseBucket).upload(ruta, buffer, {
      contentType,
      upsert: true,
    });
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  }

  async function storageDescargar(ruta) {
    const { data, error } = await supabase.storage.from(cfg.supabaseBucket).download(ruta);
    if (error || !data) return { ok: false, error: error?.message || 'sin datos' };
    const buffer = Buffer.from(await data.arrayBuffer());
    return { ok: true, buffer };
  }

  async function storageListar(prefijo) {
    const objetos = [];
    const limite = 100;
    let offset = 0;

    for (;;) {
      const { data, error } = await supabase.storage
        .from(cfg.supabaseBucket)
        .list(prefijo, { limit: limite, offset, sortBy: { column: 'name', order: 'asc' } });

      if (error) return { ok: false, error: error.message, objetos };
      const items = Array.isArray(data) ? data : [];
      for (const item of items) if (item?.id) objetos.push(item);
      if (items.length < limite) break;
      offset += limite;
    }

    return { ok: true, objetos };
  }

  async function storageBorrar(rutas) {
    if (!rutas.length) return { ok: true };
    const { error } = await supabase.storage.from(cfg.supabaseBucket).remove(rutas);
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  }

  /**
   * Filas para reprocesar con IA: por defecto las que no tienen texto_ia
   * (se excluyen las 'sin_texto', que no tienen de dónde generar).
   */
  async function listarParaReprocesar({ limite = 50, todo = false } = {}) {
    let consulta = supabase
      .from('canales_publicaciones')
      .select('id,mensaje_id,canal_id,canal_nombre,tipo,imagen_url,texto_ocr,texto_ia,estado,metadata,fecha_publicacion')
      .order('created_at', { ascending: true })
      .limit(limite);

    if (!todo) consulta = consulta.is('texto_ia', null).neq('estado', 'sin_texto');

    const { data, error } = await consulta;
    if (error) {
      logger.error('DB', 'No se pudieron leer filas para reprocesar', error.message);
      return { ok: false, error: error.message, filas: [] };
    }
    return { ok: true, filas: data || [] };
  }

  async function actualizarPublicacion(id, campos) {
    const { error } = await supabase.from('canales_publicaciones').update(campos).eq('id', id);
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  }

  async function leerEstado(canalClave) {
    try {
      const { data, error } = await supabase
        .from('pipeline_estado')
        .select('ultima_ts')
        .eq('canal', canalClave)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return data?.ultima_ts ?? null;
    } catch (err) {
      if (!avisoLectura) {
        avisoLectura = true;
        logger.warn('DB', 'No se pudo leer pipeline_estado (¿ejecutaste el SQL?)', err?.message);
      }
      return estadosEnMemoria.get(canalClave) ?? null;
    }
  }

  async function guardarEstado(canalClave, ts) {
    estadosEnMemoria.set(canalClave, ts);
    try {
      const { error } = await supabase
        .from('pipeline_estado')
        .upsert({ canal: canalClave, ultima_ts: ts }, { onConflict: 'canal' });
      if (error) throw new Error(error.message);
    } catch (err) {
      if (!avisoEscritura) {
        avisoEscritura = true;
        logger.warn('DB', 'No se pudo guardar pipeline_estado', err?.message);
      }
    }
  }

  return {
    disponible: true,
    upsertPublicacion,
    subirImagen,
    storageSubir,
    storageDescargar,
    storageListar,
    storageBorrar,
    listarParaReprocesar,
    actualizarPublicacion,
    leerEstado,
    guardarEstado,
  };
}
