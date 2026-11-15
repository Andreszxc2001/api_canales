import { logger } from '../logger.js';

function resumirError(cuerpo) {
  const texto = String(cuerpo || '').replace(/\s+/g, ' ').trim();
  if (!texto) return 'sin cuerpo';
  return texto.length > 500 ? `${texto.slice(0, 500)}...` : texto;
}

function dormir(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const MAX_REINTENTOS = 4;

function crearCola(cfg) {
  const intervaloMs = Math.max(0, Number(cfg.pausaMistralMs) || 0);
  let cola = Promise.resolve();
  let ultima = 0;

  return function enCola(tarea) {
    const turno = cola.then(async () => {
      const espera = intervaloMs - (Date.now() - ultima);
      if (espera > 0) await dormir(espera);
      try {
        return await tarea();
      } finally {
        ultima = Date.now();
      }
    });
    cola = turno.then(
      () => undefined,
      () => undefined,
    );
    return turno;
  };
}

/**
 * Cliente de Mistral chat/completions (portado de app_avitar).
 */
export function crearMistral(cfg) {
  const enCola = crearCola(cfg);

  function disponible() {
    return Boolean(cfg.mistralApiKey && cfg.mistralUrl);
  }

  async function generarDirecto(textoEntrada) {
    if (!cfg.mistralApiKey) {
      throw new Error('Falta MISTRAL_API_KEY en las variables de entorno.');
    }
    if (!textoEntrada || !String(textoEntrada).trim()) {
      throw new Error('No hay texto para enviar a Mistral.');
    }

    const cuerpo = {
      model: cfg.mistralModel,
      messages: [
        { role: 'system', content: cfg.mistralPrompt },
        { role: 'user', content: String(textoEntrada) },
      ],
      temperature: cfg.mistralTemperatura,
      max_tokens: cfg.mistralMaxTokens,
    };

    let controlador = new AbortController();
    let temporizador = setTimeout(() => controlador.abort(), cfg.mistralTimeoutMs);

    let respuesta;
    try {
      respuesta = await fetch(cfg.mistralUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cfg.mistralApiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(cuerpo),
        signal: controlador.signal,
      });
    } catch (err) {
      clearTimeout(temporizador);
      if (err?.name === 'AbortError') {
        throw new Error(
          `Mistral tardó más de ${Math.round(cfg.mistralTimeoutMs / 1000)}s y se canceló la petición.`
        );
      }
      if (
        err instanceof TypeError &&
        /fetch failed|network|ENOTFOUND|ECONNREFUSED/i.test(err?.message || '')
      ) {
        throw new Error('No se pudo conectar con Mistral. Revisa la conexión a internet.');
      }
      throw err;
    }

    // Reintento con espera cuando Mistral limita las peticiones (HTTP 429/5xx).
    if (!respuesta.ok && (respuesta.status === 429 || respuesta.status >= 500)) {
      const retryAfter = Number(respuesta.headers.get('retry-after'));
      const reintento = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : null;
      let textoIntento = '';
      try {
        textoIntento = await respuesta.text();
      } catch {
        // ignorar
      }

      for (let intento = 1; intento <= MAX_REINTENTOS; intento += 1) {
        const espera = reintento ? reintento * intento : 2000 * intento * intento; // 2s, 8s, 18s, 32s
        logger.warn(
          'Mistral',
          `HTTP ${respuesta.status} (límite de peticiones). Reintento ${intento}/${MAX_REINTENTOS} en ${Math.round(espera / 1000)}s`,
          resumirError(textoIntento)
        );
        await dormir(espera);

        try {
          controlador = new AbortController();
          clearTimeout(temporizador);
          temporizador = setTimeout(() => controlador.abort(), cfg.mistralTimeoutMs);
          respuesta = await fetch(cfg.mistralUrl, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${cfg.mistralApiKey}`,
              'Content-Type': 'application/json',
              Accept: 'application/json',
            },
            body: JSON.stringify(cuerpo),
            signal: controlador.signal,
          });
        } catch (err) {
          if (err?.name === 'AbortError') break;
          throw err;
        }

        if (respuesta.ok) break;
      }
    }

    try {
      let texto;
      try {
        texto = await respuesta.text();
      } catch {
        texto = '';
      }

      if (!respuesta.ok) {
        throw new Error(`Mistral respondió HTTP ${respuesta.status}: ${resumirError(texto)}`);
      }

      let json;
      try {
        json = JSON.parse(texto);
      } catch {
        throw new Error(`Mistral devolvió una respuesta que no es JSON válido: ${resumirError(texto)}`);
      }

      const contenido = json?.choices?.[0]?.message?.content;
      if (typeof contenido !== 'string' || !contenido.trim()) {
        throw new Error(`Mistral no devolvió contenido utilizable: ${resumirError(texto)}`);
      }

      return {
        texto: contenido.trim(),
        modelo: json?.model || cfg.mistralModel,
        tokensEntrada: json?.usage?.prompt_tokens ?? null,
        tokensSalida: json?.usage?.completion_tokens ?? null,
      };
    } catch (err) {
      if (err?.name === 'AbortError') {
        throw new Error(
          `Mistral tardó más de ${Math.round(cfg.mistralTimeoutMs / 1000)}s y se canceló la petición.`
        );
      }
      if (
        err instanceof TypeError &&
        /fetch failed|network|ENOTFOUND|ECONNREFUSED/i.test(err?.message || '')
      ) {
        throw new Error('No se pudo conectar con Mistral. Revisa la conexión a internet.');
      }
      throw err;
    } finally {
      clearTimeout(temporizador);
    }
  }

  async function generar(textoEntrada) {
    return enCola(() => generarDirecto(textoEntrada));
  }

  async function probar() {
    const r = await generar('Responde con una sola palabra: listo');
    return { ok: true, ...r };
  }

  if (!disponible()) {
    logger.warn('Mistral', 'No configurado: los textos de IA quedarán vacíos');
  }

  return { disponible, generar, probar };
}
