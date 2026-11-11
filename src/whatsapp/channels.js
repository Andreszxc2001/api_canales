import { logger } from '../logger.js';
import { idDeMensaje, tipoNormalizado } from '../util.js';

/**
 * Acepta el link completo de un canal, el código de invitación o el ID
 * serializado (`XXXXXXXX@newsletter`).
 */
export function normalizarCanalInput(input) {
  const original = String(input ?? '').trim();

  if (!original) {
    return { ok: false, error: 'El canal está vacío.' };
  }

  const link = original.match(/whatsapp\.com\/channel\/([A-Za-z0-9_-]+)/i);
  if (link) {
    return { ok: true, tipo: 'invite', valor: link[1], raw: original };
  }

  if (/@newsletter\b/i.test(original)) {
    return { ok: true, tipo: 'id', valor: original, raw: original };
  }

  if (/^[A-Za-z0-9_-]{8,}$/.test(original)) {
    return { ok: true, tipo: 'invite', valor: original, raw: original };
  }

  return {
    ok: false,
    error: `Canal inválido: "${original}". Usa el link https://whatsapp.com/channel/... o el ID ...@newsletter.`,
  };
}

/**
 * Devuelve los canales suscritos que WhatsApp Web tenga cargados.
 */
export async function listarCanales(client) {
  let canales = [];
  try {
    canales = await client.getChannels();
  } catch (err) {
    logger.warn('Canales', 'getChannels falló', err?.message);
  }

  if (!Array.isArray(canales) || !canales.length) {
    try {
      const chats = await client.getChats();
      canales = (Array.isArray(chats) ? chats : []).filter((c) => {
        const id = c?.id?._serialized || '';
        return id.endsWith('@newsletter') || c?.isChannel;
      });
    } catch (err) {
      logger.warn('Canales', 'getChats falló al listar canales', err?.message);
    }
  }

  return (Array.isArray(canales) ? canales : []).map((c) => ({
    id: c?.id?._serialized || c?.id || null,
    nombre: c?.name || c?.channelMetadata?.name || null,
    descripcion: c?.description || c?.channelMetadata?.description || null,
    suscriptores: c?.channelMetadata?.subscriberCount ?? null,
    ultimaActividad: c?.timestamp ?? c?.lastMessage?.timestamp ?? null,
    ultimoMensaje: c?.lastMessage?.body ?? null,
  }));
}

/**
 * Localiza un canal por link de invitación o por ID.
 */
export async function resolverCanal(client, input) {
  const norm = normalizarCanalInput(input);
  if (!norm.ok) throw new Error(norm.error);

  if (norm.tipo === 'id') {
    const canal = await client.getChatById(norm.valor);
    if (canal) return { canal, normalizado: norm };
    throw new Error(`No se encontró el canal "${norm.valor}".`);
  }

  try {
    const canal = await client.getChannelByInviteCode(norm.valor);
    if (canal) return { canal, normalizado: norm };
  } catch (err) {
    logger.warn('Canales', 'getChannelByInviteCode falló', err?.message);
  }

  const suscritos = await listarCanales(client);
  const coincide = suscritos.find(
    (c) => c.id === norm.valor || c.nombre === norm.raw || (c.id && c.id.startsWith(norm.valor))
  );
  if (coincide?.id) {
    const canal = await client.getChatById(coincide.id);
    if (canal) return { canal, normalizado: norm };
  }

  throw new Error(
    'No se pudo abrir el canal con ese link. Verifica que estés suscrito o usa el ID terminado en @newsletter.'
  );
}

/**
 * Trae las publicaciones del canal con timestamp mayor a `desdeTs`,
 * deduplicadas y ordenadas de la más vieja a la más nueva.
 */
export async function publicacionesNuevas({ client, canalInput, desdeTs, limite }) {
  const { canal, normalizado } = await resolverCanal(client, canalInput);
  const canalId = canal?.id?._serialized || String(normalizado.valor);
  const nombre = canal?.name || canal?.channelMetadata?.name || canalId;

  let todas;
  try {
    todas = await canal.fetchMessages({ limit: limite });
  } catch (err) {
    throw new Error(`No se pudieron leer las publicaciones del canal: ${err?.message || err}`);
  }

  const lista = Array.isArray(todas) ? todas : [];
  const vistos = new Set();
  const nuevas = [];

  for (const m of lista) {
    const id = idDeMensaje(m) ?? `${m.timestamp}-${m.body}`;
    if (vistos.has(id)) continue;
    vistos.add(id);
    const ts = Number(m.timestamp) || 0;
    if (ts > Number(desdeTs)) nuevas.push(m);
  }

  nuevas.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

  return { canal, canalId, nombre, publicaciones: nuevas };
}

/**
 * Descarga la multimedia de un mensaje y la devuelve como buffer.
 */
export async function descargarMultimedia(mensaje) {
  const tieneMedia =
    typeof mensaje.hasMedia === 'function' ? await mensaje.hasMedia() : !!mensaje.hasMedia;

  if (!tieneMedia) return null;

  let media;
  try {
    media = await mensaje.downloadMedia();
  } catch (err) {
    logger.warn('Canales', 'downloadMedia falló', err?.message);
    return null;
  }

  if (!media || media.data === undefined) {
    logger.warn('Canales', 'Multimedia no disponible (probablemente caducó en WhatsApp)');
    return null;
  }

  const mime = String(media.mimetype || '').split(';')[0].trim().toLowerCase() || null;
  return {
    buffer: Buffer.from(media.data, 'base64'),
    mime,
    filename: media.filename || null,
  };
}

export { tipoNormalizado };
