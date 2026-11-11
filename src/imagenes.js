import sharp from 'sharp';

import { logger } from './logger.js';

/**
 * Convierte una imagen a WebP (calidad configurable) para subirla más liviana.
 * Devuelve null si no conviene convertir o si sharp falla.
 */
export async function convertirAWebp(buffer, calidad = 80) {
  try {
    const convertida = await sharp(buffer).rotate().webp({ quality: calidad }).toBuffer();
    if (convertida.length >= buffer.length) return null;
    return convertida;
  } catch (err) {
    logger.warn('Imagen', 'No se pudo convertir a WebP (se usa el original)', err?.message);
    return null;
  }
}

/**
 * Convierte cualquier imagen a PNG (para OCR cuando el archivo es WebP).
 */
export async function aPng(buffer) {
  try {
    return await sharp(buffer).rotate().png().toBuffer();
  } catch (err) {
    logger.warn('Imagen', 'No se pudo decodificar la imagen para OCR', err?.message);
    return null;
  }
}
