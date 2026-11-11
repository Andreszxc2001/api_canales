import express from 'express';

import { logger } from './logger.js';

function paginaHtml(titulo, cuerpo, extraHead = '') {
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="5">
${extraHead}
<title>${titulo}</title>
<style>
  body { font-family: system-ui, sans-serif; background: #111b21; color: #eee;
         display: flex; flex-direction: column; align-items: center; padding: 24px; }
  .card { background: #202c33; border-radius: 12px; padding: 24px; max-width: 420px; text-align: center; }
  img { width: 300px; height: 300px; background: #fff; border-radius: 8px; }
  h1 { font-size: 20px; margin-top: 0; }
  p { color: #aaa; font-size: 14px; line-height: 1.5; }
  code { background: #111b21; padding: 2px 6px; border-radius: 4px; }
</style>
</head>
<body>
  <div class="card">
    <h1>${titulo}</h1>
    ${cuerpo}
  </div>
</body>
</html>`;
}

export function crearServer({ cfg, whatsapp, pipeline, reproceso }) {
  const app = express();

  app.get('/salud', (_req, res) => {
    res.status(200).json({ ok: true, ts: Date.now() });
  });

  app.get('/qr', (_req, res) => {
    if (whatsapp.conectado()) {
      res.send(paginaHtml('WhatsApp conectado', '<p>La sesión ya está activa. Ya puedes cerrar esta página.</p>'));
      return;
    }

    const qr = whatsapp.qrDataUrl;
    if (!qr) {
      res.send(
        paginaHtml(
          'Generando QR...',
          '<p>El código todavía no está disponible. Esta página se refresca sola cada 5 segundos.</p>'
        )
      );
      return;
    }

    res.send(
      paginaHtml(
        'Escanea el QR',
        `<img src="${qr}" alt="QR de WhatsApp"><p>Abre WhatsApp en tu celular &rarr; <b>Ajustes &rarr; Dispositivos vinculados &rarr; Vincular dispositivo</b> y escanea este código.<br>La página se actualiza sola si el QR expira.</p>`
      )
    );
  });

  app.get('/estado', (_req, res) => {
    res.json({
      ok: true,
      whatsapp: {
        estado: whatsapp.estado,
        perfil: whatsapp.obtenerPerfil(),
        conectadoDesde: whatsapp.conectadoEn,
        ultimoError: whatsapp.ultimoError,
      },
      pipeline: pipeline.estado(),
      reproceso: reproceso ? reproceso.estado() : null,
      intervaloMinutos: cfg.intervaloMinutos,
      modo: cfg.canales.length ? 'filtro' : 'automatico',
      canales: cfg.canales,
    });
  });

  const lanzarReproceso = (req, res) => {
    if (!reproceso || !reproceso.disponible()) {
      res.status(503).json({ ok: false, motivo: 'supabase o mistral no configurados' });
      return;
    }

    const todo = ['1', 'true', 'si', 'sí'].includes(String(req.query.todo || '').toLowerCase());
    reproceso
      .ejecutar({ todo })
      .catch((err) => logger.error('Reproceso', 'Falló el reproceso', err?.message));

    res.status(202).json({ ok: true, iniciado: true, todo });
  };

  app.post('/reprocesar', lanzarReproceso);
  app.get('/reprocesar', lanzarReproceso);

  const server = app.listen(cfg.puerto, '0.0.0.0', () => {
    logger.info('Server', `HTTP escuchando en el puerto ${cfg.puerto} (/qr, /estado, /salud)`);
  });

  return server;
}
