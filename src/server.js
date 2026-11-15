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
  .codigo { font-size: 30px; letter-spacing: 4px; font-weight: 700; color: #25d366;
            background: #111b21; padding: 12px; border-radius: 8px; margin: 16px 0; }
  .sep { border-top: 1px solid #2a3942; margin: 20px 0; }
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

    const codigo = whatsapp.codigoVinculacion;
    const bloqueCodigo = codigo
      ? `<p><b>Opción 1: código de vinculación</b></p>
         <div class="codigo">${codigo}</div>
         <p>WhatsApp &rarr; <b>Ajustes &rarr; Dispositivos vinculados &rarr; Vincular dispositivo &rarr; Vincular con número de teléfono</b> e ingresa ese código.</p>
         <div class="sep"></div>
         <p>Opción 2: escanea el QR de abajo.</p>`
      : '';

    const qr = whatsapp.qrDataUrl;
    if (!qr) {
      res.send(
        paginaHtml(
          'Generando QR...',
          `${bloqueCodigo}<p>El código todavía no está disponible. Esta página se refresca sola cada 5 segundos.</p>`
        )
      );
      return;
    }

    res.send(
      paginaHtml(
        'Vincula tu WhatsApp',
        `${bloqueCodigo}
         <img src="${qr}" alt="QR de WhatsApp">
         <p>QR: WhatsApp &rarr; <b>Ajustes &rarr; Dispositivos vinculados &rarr; Vincular dispositivo</b> y escanea.<br>La página se actualiza sola si el QR o el código expiran.</p>`
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
        codigoVinculacion: whatsapp.codigoVinculacion || null,
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
