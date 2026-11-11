const ZONA_HORARIA_COLOMBIA = 'America/Bogota';
const OFFSET_COLOMBIA = '-05:00';

const PATRON_NO_SEGURO = /[<>:"/\\|?*\x00-\x1F]/g;

export function fechaHoraDesdeTimestamp(timestampSegundos) {
  const dt = new Date(Number(timestampSegundos) * 1000);
  const fmt = new Intl.DateTimeFormat('sv-SE', {
    timeZone: ZONA_HORARIA_COLOMBIA,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const partes = {};
  for (const p of fmt.formatToParts(dt)) partes[p.type] = p.value;

  const fecha = `${partes.year}-${partes.month}-${partes.day}`;
  const hora = `${partes.hour}:${partes.minute}:${partes.second}`;
  return { fecha, hora, datetime: `${fecha}T${hora}${OFFSET_COLOMBIA}` };
}

export function tipoNormalizado(msg) {
  switch (msg?.type) {
    case 'chat':
      return 'texto';
    case 'audio':
    case 'ptt':
      return 'audio';
    case 'image':
      return 'imagen';
    case 'document':
      return 'documento';
    case 'video':
    case 'gif':
      return 'video';
    case 'sticker':
      return 'sticker';
    default:
      return 'otros';
  }
}

export function idDeMensaje(m) {
  return m?.id?._serialized ?? m?.id?.$1 ?? m?.id?.id ?? null;
}

export function nombreSeguro(nombre) {
  if (!nombre) return null;
  const base = String(nombre).replace(PATRON_NO_SEGURO, '_').trim();
  return base || null;
}
