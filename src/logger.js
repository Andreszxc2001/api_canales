const NIVEL_MINIMO = { debug: 10, info: 20, warn: 30, error: 40 };

function nivelActual() {
  const n = String(process.env.LOG_NIVEL || 'info').toLowerCase();
  return NIVEL_MINIMO[n] ?? NIVEL_MINIMO.info;
}

function textoExtra(extra) {
  if (extra === undefined || extra === null) return '';
  if (typeof extra === 'string') return ` ${extra}`;
  try {
    return ` ${JSON.stringify(extra)}`;
  } catch {
    return '';
  }
}

function linea(nivel, fuente, mensaje, extra) {
  return `[${new Date().toISOString()}] [${nivel}] [${fuente}] ${mensaje}${textoExtra(extra)}`;
}

export const logger = {
  debug(fuente, mensaje, extra) {
    if (nivelActual() <= NIVEL_MINIMO.debug) console.log(linea('DEBUG', fuente, mensaje, extra));
  },
  info(fuente, mensaje, extra) {
    console.log(linea('INFO', fuente, mensaje, extra));
  },
  warn(fuente, mensaje, extra) {
    console.warn(linea('WARN', fuente, mensaje, extra));
  },
  error(fuente, mensaje, extra) {
    console.error(linea('ERROR', fuente, mensaje, extra));
  },
};
