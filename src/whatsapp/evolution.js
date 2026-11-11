import { logger } from '../logger.js';

function sinBarraFinal(url) {
  return String(url || '').replace(/\/+$/, '');
}

/**
 * Cliente de Evolution API: usa la sesión de WhatsApp ya vinculada en Evolution
 * para leer los canales (@newsletter) y bajar sus imágenes. No usa Chromium.
 */
export function crearEvolution({ cfg } = {}) {
  const base = sinBarraFinal(cfg?.evolutionUrl);
  const key = String(cfg?.evolutionApiKey || '');
  const instancia = String(cfg?.evolutionInstancia || '');

  function disponible() {
    return Boolean(base && key && instancia);
  }

  async function api(ruta, { metodo = 'GET', body } = {}) {
    if (!disponible()) {
      throw new Error('Evolution API no configurada (EVOLUTION_URL / EVOLUTION_APIKEY / EVOLUTION_INSTANCIA)');
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60000);
    try {
      const resp = await fetch(`${base}${ruta}`, {
        method: metodo,
        headers: { apikey: key, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });

      const texto = await resp.text();
      let data = null;
      try {
        data = texto ? JSON.parse(texto) : null;
      } catch {
        data = texto;
      }

      if (!resp.ok) {
        const detalle = data?.message || data?.error || (typeof data === 'string' ? data : '');
        const mensaje = Array.isArray(detalle) ? detalle.join('; ') : detalle;
        throw new Error(`Evolution HTTP ${resp.status}: ${mensaje || resp.statusText}`);
      }

      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  async function estado() {
    try {
      const r = await api(`/instance/connectionState/${encodeURIComponent(instancia)}`);
      const state = r?.instance?.state || r?.state || null;
      return { proveedor: 'evolution', ok: state === 'open', state, instancia };
    } catch (err) {
      return { proveedor: 'evolution', ok: false, state: null, instancia, error: err?.message || String(err) };
    }
  }

  function esCanal(chat) {
    return String(chat?.remoteJid || '').endsWith('@newsletter');
  }

  function nombreDe(chat) {
    return chat?.pushName || chat?.name || chat?.subject || chat?.remoteJid;
  }

  async function listarCanales() {
    const chats = await api(`/chat/findChats/${encodeURIComponent(instancia)}`, { metodo: 'POST', body: {} });
    const lista = Array.isArray(chats) ? chats : [];
    return lista.filter(esCanal).map((c) => ({ clave: c.remoteJid, nombre: nombreDe(c) }));
  }

  function textoDe(mensaje) {
    const m = mensaje?.message || {};
    return m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption || '';
  }

  function tipoDe(mensaje) {
    if (mensaje?.message?.imageMessage || mensaje?.messageType === 'imageMessage') return 'imagen';
    const tieneTexto = !!textoDe(mensaje);
    if (tieneTexto) return 'texto';
    return 'otro';
  }

  function aPublicacion(mensaje, nombreCanal) {
    return {
      id: mensaje?.key?.id || mensaje?.id,
      timestamp: Number(mensaje?.messageTimestamp) || 0,
      body: textoDe(mensaje),
      tipo: tipoDe(mensaje),
      canalNombre: nombreCanal || null,
      descargarMedia: async () => {
        const r = await api(`/chat/getBase64FromMediaMessage/${encodeURIComponent(instancia)}`, {
          metodo: 'POST',
          body: { message: { key: mensaje.key, message: mensaje.message } },
        });
        if (!r?.base64) return null;
        return {
          buffer: Buffer.from(r.base64, 'base64'),
          mime: r.mimetype || mensaje?.message?.imageMessage?.mimetype || 'image/jpeg',
        };
      },
    };
  }

  async function publicacionesNuevas({ canalInput, desdeTs, limite }) {
    const buscado = String(canalInput || '').trim().toLowerCase();
    let jid = null;
    let nombre = null;

    if (String(canalInput || '').endsWith('@newsletter')) {
      jid = String(canalInput).trim();
      nombre = jid;
    } else {
      const canales = await listarCanales().catch(() => []);
      const canal =
        canales.find((c) => c.clave === canalInput) ||
        canales.find((c) => String(c.nombre).toLowerCase() === buscado) ||
        canales.find((c) => String(c.nombre).toLowerCase().includes(buscado));
      if (canal) {
        jid = canal.clave;
        nombre = canal.nombre;
      }
    }

    if (!jid) {
      throw new Error(
        `No se encontró el canal "${canalInput}" en Evolution (¿la cuenta conectada lo sigue? Usa la URL/JID del canal)`
      );
    }

    const offset = Math.min(Math.max(Number(limite) || 50, 1), 100);
    const data = await api(`/chat/findMessages/${encodeURIComponent(instancia)}`, {
      metodo: 'POST',
      body: {
        where: {
          key: { remoteJid: jid },
          messageTimestamp: {
            gte: new Date(Math.max(0, Number(desdeTs) || 0) * 1000).toISOString(),
            lte: new Date().toISOString(),
          },
        },
        offset,
        page: 1,
      },
    });

    const lista = Array.isArray(data) ? data : data?.messages?.records || [];
    const publicaciones = lista
      .map((m) => aPublicacion(m, nombre))
      .filter((p) => p.id && p.timestamp > 0)
      .sort((a, b) => a.timestamp - b.timestamp);

    logger.debug('Evolution', `Canal ${nombre}: ${publicaciones.length} mensajes nuevos`);

    return { canalId: jid, nombre: nombre || jid, publicaciones };
  }

  return { disponible, estado, listarCanales, publicacionesNuevas };
}
