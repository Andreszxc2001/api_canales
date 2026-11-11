import path from 'path';

import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import QRCode from 'qrcode';

import { logger } from '../logger.js';

export const ESTADOS = {
  DESCONECTADO: 'desconectado',
  CONECTANDO: 'conectando',
  ESPERANDO_QR: 'esperando_qr',
  AUTENTICANDO: 'autenticando',
  CONECTADO: 'conectado',
  DESCONECTANDO: 'desconectando',
  ERROR: 'error',
  REINTENTANDO: 'reintentando',
};

const MAX_REINTENTOS_LISTO = 2;
const MS_RECONEXION = 15000;

export class WhatsappService {
  constructor({ cfg, onListo, onSesionInvalida } = {}) {
    this.cfg = cfg;
    this.estado = ESTADOS.DESCONECTADO;
    this.client = null;
    this.qrDataUrl = null;
    this.ultimoError = null;
    this.conectadoEn = null;
    this._onListo = onListo || null;
    this._onSesionInvalida = onSesionInvalida || null;
    this._genInvalidada = null;
    this._esperaListoMs = Math.max(10, Number(cfg?.esperaListoSegundos) || 45) * 1000;
    this._iniciando = false;
    this._generacion = 0;
    this._intentosListo = 0;
    this._verificador = null;
    this._reconectarTimer = null;
  }

  _cambiarEstado(estado) {
    this.estado = estado;
  }

  _limpiarVerificador() {
    if (this._verificador) {
      clearTimeout(this._verificador);
      this._verificador = null;
    }
  }

  _agendarVerificacion(cliente) {
    this._limpiarVerificador();
    this._verificador = setTimeout(() => {
      this._verificador = null;
      this._verificarSiListo(cliente);
    }, this._esperaListoMs);
  }

  /**
   * Cuando `authenticated` llega pero `ready` no, comprobamos si el store ya
   * está sincronizado. Si no, reiniciamos el cliente (hasta MAX_REINTENTOS).
   */
  async _verificarSiListo(cliente) {
    if (!cliente || this.client !== cliente) return;
    if (
      this.estado === ESTADOS.CONECTADO ||
      this.estado === ESTADOS.DESCONECTADO ||
      this.estado === ESTADOS.DESCONECTANDO
    ) {
      return;
    }

    logger.info('Whatsapp', 'Verificando si el cliente quedó listo (ready no recibido)');

    try {
      const chats = await cliente.getChats();
      if (Array.isArray(chats)) {
        logger.info('Whatsapp', 'Store sincronizado, marcando como conectado', { chats: chats.length });
        this._marcarConectado(cliente);
        return;
      }
    } catch {
      // No hay store todavía; se reintenta.
    }

    if (this._intentosListo < MAX_REINTENTOS_LISTO) {
      this._intentosListo += 1;
      logger.warn('Whatsapp', `Reintentando conexión para alcanzar ready (intento ${this._intentosListo})`);

      if (cliente && typeof cliente.destroy === 'function') {
        try {
          await cliente.destroy();
        } catch {
          // ignorar
        }
      }

      this._cambiarEstado(ESTADOS.REINTENTANDO);
      await new Promise((r) => setTimeout(r, 2000));

      try {
        await this._conectar();
      } catch (err) {
        this.ultimoError = String(err?.message || err);
        this._cambiarEstado(ESTADOS.ERROR);
      }
    } else {
      logger.error('Whatsapp', 'No se pudo sincronizar la sesión tras varios reintentos');
      this.client = null;
      this.qrDataUrl = null;
      this.ultimoError =
        'No se pudo sincronizar la sesión de WhatsApp. La sesión guardada probablemente está dañada o caducó.';
      this._cambiarEstado(ESTADOS.ERROR);
      try {
        this._onSesionInvalida && this._onSesionInvalida();
      } catch (err) {
        logger.warn('Whatsapp', 'Error en callback onSesionInvalida', err?.message);
      }
    }
  }

  _marcarConectado(cliente) {
    this._limpiarVerificador();
    this.qrDataUrl = null;
    this.ultimoError = null;
    this.conectadoEn = new Date().toISOString();
    this._intentosListo = 0;
    this._cambiarEstado(ESTADOS.CONECTADO);
    logger.info('Whatsapp', 'Conectado', this.obtenerPerfil() || {});
    try {
      this._onListo && this._onListo();
    } catch (err) {
      logger.warn('Whatsapp', 'Error en callback onListo', err?.message);
    }
  }

  obtenerPerfil() {
    try {
      const info = this.client?.info;
      if (!info) return null;
      const me = info.me || {};
      return { numero: me.user || me.number || null, nombre: info.pushname || null };
    } catch {
      return null;
    }
  }

  conectado() {
    return this.estado === ESTADOS.CONECTADO && !!this.client;
  }

  async conectar() {
    if (this.conectado()) {
      return { ok: true, estado: this.estado };
    }
    if (this._iniciando) {
      return { ok: true, estado: this.estado, mensaje: 'Conexión en curso...' };
    }

    try {
      return await this._conectar();
    } finally {
      this._iniciando = false;
    }
  }

  _conectar() {
    this._iniciando = true;

    const puppeteer = {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--disable-extensions',
        '--no-first-run',
        '--mute-audio',
      ],
    };
    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
      puppeteer.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    }

    const cliente = new Client({
      authStrategy: new LocalAuth({
        dataPath: path.join(this.cfg.dataDir, 'whatsapp-session'),
      }),
      puppeteer,
    });

    this.client = cliente;
    this._generacion += 1;
    const generacion = this._generacion;

    this._cambiarEstado(ESTADOS.CONECTANDO);

    this._registrarEventos(cliente, generacion);

    return cliente.initialize().then(
      () => ({ ok: true, estado: this.estado }),
      (err) => {
        logger.error('Whatsapp', 'Error al inicializar el cliente', err?.message);
        this._limpiarVerificador();
        if (this.client === cliente) this.client = null;
        this.ultimoError = String(err?.message || err);
        this._cambiarEstado(ESTADOS.ERROR);
        return { ok: false, error: this.ultimoError };
      }
    );
  }

  _registrarEventos(cliente, generacion) {
    const ignorarSiObsoleto = (fn) => (...args) => {
      if (this.client !== cliente || generacion !== this._generacion) return;
      fn(...args);
    };

    const invalidarSesionUnaVez = () => {
      if (this._genInvalidada === generacion) return;
      this._genInvalidada = generacion;
      try {
        this._onSesionInvalida && this._onSesionInvalida();
      } catch (err) {
        logger.warn('Whatsapp', 'Error en callback onSesionInvalida', err?.message);
      }
    };

    cliente.on(
      'qr',
      ignorarSiObsoleto(async (qr) => {
        this._limpiarVerificador();
        this._cambiarEstado(ESTADOS.ESPERANDO_QR);
        this._intentosListo = 0;
        invalidarSesionUnaVez();
        try {
          this.qrDataUrl = await QRCode.toDataURL(qr, { width: 320, margin: 1 });
          const terminal = await QRCode.toString(qr, { type: 'terminal', small: true });
          console.log(`\n${terminal}\n>>> Escanea este QR desde WhatsApp (Dispositivos vinculados)\n>>> o abre la ruta /qr del servicio en el navegador de tu celular.\n`);
        } catch (err) {
          logger.warn('Whatsapp', 'No se pudo generar el QR', err?.message);
        }
      })
    );

    cliente.on(
      'loading_screen',
      ignorarSiObsoleto((porcentaje, mensaje) => {
        if (this.estado !== ESTADOS.CONECTADO) {
          this._cambiarEstado(ESTADOS.CONECTANDO);
          logger.debug('Whatsapp', `Cargando ${porcentaje}%`, mensaje);
        }
      })
    );

    cliente.on(
      'authenticated',
      ignorarSiObsoleto(() => {
        this._cambiarEstado(ESTADOS.AUTENTICANDO);
        this._agendarVerificacion(cliente);
      })
    );

    cliente.on(
      'ready',
      ignorarSiObsoleto(() => {
        this._marcarConectado(cliente);
      })
    );

    cliente.on(
      'auth_failure',
      ignorarSiObsoleto((mensaje) => {
        logger.error('Whatsapp', 'Fallo de autenticación', String(mensaje));
        invalidarSesionUnaVez();
        this._manejarCaida(`auth_failure: ${mensaje}`);
      })
    );

    cliente.on(
      'disconnected',
      ignorarSiObsoleto((razon) => {
        logger.warn('Whatsapp', 'Desconectado', String(razon));
        this._manejarCaida(`disconnected: ${razon}`);
      })
    );
  }

  _manejarCaida(motivo) {
    this._limpiarVerificador();
    this.qrDataUrl = null;
    this.ultimoError = String(motivo);
    if (this.estado !== ESTADOS.DESCONECTANDO) {
      this.client = null;
      this._cambiarEstado(ESTADOS.DESCONECTADO);
    }
    this._agendarReconexion();
  }

  _agendarReconexion() {
    if (this._reconectarTimer) return;
    this._reconectarTimer = setTimeout(() => {
      this._reconectarTimer = null;
      if (this.conectado()) return;
      logger.info('Whatsapp', `Reconectando (${MS_RECONEXION / 1000}s después de la caída)...`);
      this.conectar().catch((err) => {
        logger.error('Whatsapp', 'Reconexión falló', err?.message);
      });
    }, MS_RECONEXION);
  }

  async desconectar() {
    this._cambiarEstado(ESTADOS.DESCONECTANDO);
    this._limpiarVerificador();
    if (this._reconectarTimer) {
      clearTimeout(this._reconectarTimer);
      this._reconectarTimer = null;
    }

    const client = this.client;
    this.client = null;
    this._generacion += 1;
    this._intentosListo = 0;

    if (client && typeof client.destroy === 'function') {
      try {
        await client.destroy();
      } catch (err) {
        logger.warn('Whatsapp', 'Error al destruir el cliente', err?.message);
      }
    }

    this._cambiarEstado(ESTADOS.DESCONECTADO);
    return { ok: true, estado: this.estado };
  }
}
