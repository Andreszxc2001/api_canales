# API Canales — Pipeline de Publicaciones de Canales de WhatsApp

## 1. Qué es este proyecto

Servicio **backend sin interfaz (headless)** que hace un pipeline automático **cada 2 minutos**:

```
Cada 2 min (setInterval interno)
        │
        ▼
Consultar canales de WhatsApp (sesión persistente, whatsapp-web.js headless)
        │
        ▼
¿Hay publicación nueva? ── no ──► esperar siguiente ciclo
        │ sí
        ▼
Descargar la imagen
        │
        ▼
OCR (tesseract.js, GRATIS)  ──►  texto crudo extraído
        │  (imágenes generadas con IA, texto limpio → tesseract las lee bien)
        ▼
Mistral (IA)  ──►  elabora un texto listo para página web
        │
        ▼
Supabase  ──►  INSERT en la tabla `publicaciones`
```

**Alcance de esta primera versión (el núcleo):** obtener imágenes de los canales → OCR →
Mistral → Supabase. Todo lo demás (más canales, reintentos, endpoint de lectura, etc.)
se va agregando encima luego. El texto final lo organizas tú a tu manera desde Supabase.

No hay interfaz gráfica de usuario. Todo corre como un servicio (worker) en la nube,
se monitorea por logs y por lo que cae en Supabase. **Nada en local.**

## 2. Qué se copia de `app_avitar` y qué NO

| Se copia (adaptado) | Se descarta |
|---|---|
| `whatsappChannels.js` — listar/resolver/extraer publicaciones de canales (Newsletter): `getChannels()`, `getChannelByInviteCode()`, `fetchMessages()`, `downloadMedia()` | Electron (ventanas, IPC, `preload.js`, `renderer.js`, HTML/CSS) |
| `whatsappService.js` — conexión `Client` + `LocalAuth` con Puppeteer headless | Transcripción de audios con Deepgram (solo interesan imágenes) |
| `whatsappExtractor.js` — solo los helpers de multimedia (descarga de imágenes a disco) | Extracción de chats 1:1, normalizador de teléfonos |
| `mistralService.js` — cliente `POST /v1/chat/completions` (Bearer + timeout + manejo de errores) | `controller_gemini.js`, prompts de clientes, `compactConversation.js` |
| `patches/whatsapp-web.js.patch` — **OBLIGATORIO**: sin este parche `getChannels()` y la descarga de media NO funcionan con la versión actual de WhatsApp Web (IDs `$1`, `mimetype` en descarga, tolerancia a errores en `getChats`) | Guardar salidas en el Escritorio (`Desktop/canales/...`) — ahora todo va a Supabase |

**Lo que NO existe en `app_avitar` y se crea nuevo en este proyecto:**

1. **OCR** — `app_avitar` no tiene ningún OCR (solo aparece `mistral-ocr-*` en un fixture del catálogo de modelos de Mistral, sin usarse). Aquí se agrega el paso OCR.
2. **Supabase** — `app_avitar` no tiene base de datos (todo era JSON en disco). Aquí se agrega la capa de base de datos.

## 3. Viabilidad: ¿funciona SIN interfaz? (respuesta corta: SÍ)

- `whatsapp-web.js` ya corre **headless** (`puppeteer: { headless: true }`). En `app_avitar`,
  Electron era solo el "caparazón" para mostrar el QR y botones; la lógica real no depende de Electron.
- El único momento que requiere interacción humana es **escanear el QR una sola vez** para
  vincular el número de WhatsApp. Soluciones sin interfaz:
  - **Opción A (recomendada)**: endpoint mínimo `GET /qr` que devuelve el QR como imagen/HTML. Se abre una vez en el navegador, se escanea, y listo. También se renderiza el QR en los logs con `qrcode-terminal`.
  - **Opción B**: solo QR en terminal (logs de Render/Railway), sin ningún endpoint HTTP.
- Con **sesión persistente** (volumen de disco) el QR se escanea una sola vez; el servicio
  puede reiniciarse y retomar la sesión guardada.
- Todo lo demás (poll de canales, descarga, OCR, Mistral, Supabase) es 100 % automático,
  programado con un intervalo (ej. cada 10-15 minutos).

## 4. Despliegue GRATIS (nada local, $0 en total)

**Regla de oro: el "cada 2 minutos" NO es un cron job externo.** Un cron que levanta
contenedores efímeros mataría la sesión de WhatsApp en cada corrida. La arquitectura
correcta es un **servicio siempre encendido con `setInterval` interno cada 2 minutos**.

### El problema de los planes free y cómo se resuelve (todo gratis)

| Problema del free tier | Solución (sin pagar) |
|---|---|
| Render free **se duerme** a los 15 min sin tráfico entrante → sesión cae | **Keep-alive**: UptimeRobot o cron-job.org (gratis) haciendo `GET /salud` cada 10 min → el servicio nunca se duerme |
| Render free **NO tiene disco persistente** → al reiniciar se pierde la sesión del QR | **No se soluciona — no importa**: se usa un WhatsApp secundario. Si la sesión se pierde, se re-escanea el QR una vez (abrir `/qr` desde el celular) y sigue. Sin líos |
| Render free: **512 MB RAM** y Chromium es pesado | Flags de Puppeteer (`--no-sandbox`, `--disable-dev-shm-usage`, `--disable-gpu`, etc.). Es justo pero funciona. Si revienta por RAM → **Plan B abajo** |
| Estado del pipeline (última fecha procesada) | Ya vive en Supabase (la DB es gratis), no se necesita disco |
| Mistral | Mistral La Plateforme tiene capa gratuita con API key |
| OCR | tesseract.js gratis, corre dentro del contenedor |
| Supabase | Plan free: DB suficiente |

**Costo total: $0.**

### Plan B si 512 MB no alcanza
**Hugging Face Spaces (Docker, plan free): 2 vCPU + 16 GB RAM** — sobra memoria para
Chromium. También se duerme tras inactividad → mismo truco de keep-alive con ping.
Sin disco persistente → mismo truco de backup de sesión en Supabase Storage.

### Qué NO sirve gratis
- Railway (ya no tiene plan free, solo crédito de prueba de una vez)
- Render Cron Jobs (contenedores efímeros, pierden la sesión)

**Riesgos conocidos (importante):**
- `whatsapp-web.js` es una librería **no oficial** (automatiza WhatsApp Web con Puppeteer).
  Existe riesgo de que WhatsApp **banee el número**. Se recomienda usar un número secundario/dedicado.
- La sesión de WhatsApp puede invalidarse eventualmente (cambios del lado de WhatsApp Web).
  El servicio debe detectar `disconnected` / `auth_failure`, limpiar sesión y volver a pedir QR.
- Sin el parche de `whatsapp-web.js` la extracción de canales falla silenciosamente.

## 5. Estructura del proyecto (IMPLEMENTADO)

```
api_canales/
├── index.js                    # entrypoint: arma todo y arranca
├── package.json                # deps + postinstall (patch-package)
├── Dockerfile                  # Node 22 + Chromium del sistema (para Render)
├── .env.example                # plantilla de variables de entorno
├── supabase.sql                # SQL: canales_publicaciones + pipeline_estado + bucket Storage
├── patches/
│   └── whatsapp-web.js+1.34.7.patch  # parche crítico (formato patch-package)
└── src/
    ├── config.js               # lee variables de entorno y valida
    ├── logger.js               # logs a stdout (Render los captura)
    ├── util.js                 # fechas Colombia, tipos, IDs
    ├── server.js               # Express: GET /qr, GET /estado, GET /salud
    ├── pipeline.js             # orquestador cada 2 min
    ├── whatsapp/
    │   ├── client.js           # Client + LocalAuth headless, QR en /qr, reconexión
    │   ├── sessionStore.js     # respaldo/restauración de la sesión en Supabase Storage
    │   └── channels.js         # listar/resolver canales + publicaciones nuevas + descarga
    ├── ocr/
    │   └── ocrService.js       # tesseract.js (worker reutilizable)
    ├── ai/
    │   └── mistralService.js   # chat/completions (portado de app_avitar)
    └── db/
        └── supabase.js         # upsert publicaciones + estado por canal + Storage de imágenes
```

## 6. Decisión de OCR

**Las imágenes de los canales son generadas con IA: texto limpio, alta legibilidad.**
Para ese caso basta un OCR local gratuito:

| | **tesseract.js (ELEGIDO)** | Mistral OCR API (alternativa) |
|---|---|---|
| Cómo | Corre dentro del contenedor, sin llamadas externas | `POST https://api.mistral.ai/v1/ocr`, modelo `mistral-ocr-latest` |
| Costo | **Gratis** | Pago por página |
| Calidad | Excelente con texto limpio/generado (nuestro caso) | Excelente en todo |
| Idioma español | Paquete `spa` incluido | Nativo |

Por defecto **tesseract.js** (gratis, suficiente para imágenes IA de buena calidad).
Queda configurable por variable de entorno si algún día se quiere Mistral OCR.

## 7. Esquema de Supabase (tabla `canales_publicaciones`)

```sql
create table if not exists public.canales_publicaciones (
  id                uuid primary key default gen_random_uuid(),
  mensaje_id        text unique not null,          -- ID del mensaje de WhatsApp (dedupe)
  canal_id          text not null,                 -- ej. 123456789@newsletter
  canal_nombre      text,
  fecha_publicacion timestamptz not null,          -- timestamp del mensaje en el canal
  tipo              text not null default 'imagen',
  imagen_url        text,                          -- URL pública en Supabase Storage
  texto_ocr         text,                          -- texto crudo extraído de la imagen
  texto_ia          text,                          -- texto generado por Mistral
  modelo_ia         text,                          -- ej. mistral-large-latest
  estado            text not null default 'procesada',  -- procesada|sin_texto|sin_ia|error
  error             text,
  metadata          jsonb,                         -- datos crudos del mensaje para depuración
  created_at        timestamptz not null default now()
);

create index if not exists idx_canales_publicaciones_canal_fecha
  on public.canales_publicaciones (canal_id, fecha_publicacion desc);
```

`mensaje_id` es UNIQUE: el pipeline hace **upsert**, así que re-ejecutar no duplica publicaciones.

**Imágenes en Supabase Storage:** `supabase.sql` crea el bucket público `imagenes_posts`
(la url queda en `imagen_url`). Si el bucket no existe o falla la subida, la imagen se guarda
localmente en `data/imagenes/` como respaldo.

**Estado del pipeline:** la tabla `pipeline_estado` guarda la última marca de tiempo por canal
(la clave es el `canal_id`). Borrar filas de `canales_publicaciones` **no** hace que se reprocesen:
para forzar el reproceso de las últimas 24h ejecuta `delete from pipeline_estado;` y espera el
siguiente ciclo (o reinicia el servicio).

### Sesión de WhatsApp sin disco persistente

Render free no guarda el filesystem entre reinicios. Para no re-escanear el QR cada vez,
`sessionStore.js` respalda la sesión (`data/whatsapp-session`) en el bucket, bajo el prefijo
`sesion-whatsapp/` (los nombres van codificados, el marcador `_respaldo.json` se sube al final
para saber que el respaldo está completo):

- Al arrancar: descarga el respaldo y lo restaura **antes** de conectar WhatsApp.
- Se respalda al conectar, cada `RESPALDO_SESION_MINUTOS` (15 por defecto) y al apagar (SIGTERM/SIGINT).
- Si WhatsApp pide QR o falla la autenticación, el respaldo remoto se borra solo (está caducado)
  y se usa la sesión nueva tras escanear.
- Se excluyen cachés de Chromium y locks (`Cache`, `GPUCache`, `SingletonLock`, etc.) que no
  sirven para autenticar y solo pesan.
- Si el respaldo está corrupto, WhatsApp emitirá `qr`: se escanea de nuevo y el ciclo sigue.
  Para desactivar el respaldo: `RESPALDO_SESION=false` (se pide QR en cada reinicio).

## 8. Variables de entorno

```env
# Mistral (misma cuenta que app_avitar)
MISTRAL_API_KEY=...
MISTRAL_MODEL=mistral-large-latest

# OCR (tesseract.js)
OCR_IDIOMA=spa

# Supabase
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=...    # service role (el servicio es backend, sin usuario final)
SUPABASE_BUCKET=imagenes_posts # bucket de Storage para las imágenes (debe existir)
RESPALDO_SESION=true            # respalda la sesión en Storage (sobrevive reinicios)
RESPALDO_SESION_MINUTOS=15      # frecuencia del respaldo

# Canales a monitorear (IDs @newsletter o códigos de invitación, separados por coma)
# Vacío = MODO AUTOMÁTICO: monitorea todos los canales suscritos
CANALES=

# Reproceso de filas ya guardadas sin texto_ia (al iniciar y vía /reprocesar)
REPROCESAR_AL_INICIAR=true
REPROCESO_LOTE=200

# Operación
INTERVALO_MINUTOS=2              # frecuencia del ciclo de extracción (cada 2 minutos)
LIMITE_MENSAJES=50              # tope de fetchMessages por ciclo (solo publicaciones nuevas)
PAUSA_PUBLICACIONES_MS=1500      # pausa entre publicaciones (plan free de Mistral: ~1 req/s)
TZ=America/Bogota
PUERTO=3000                      # solo para /qr, /estado, /salud
WHATSAPP_TELEFONO=               # opcional: vincular con código de 8 dígitos en vez de QR (solo dígitos, con país)
NAVEGADOR_TIMEOUT_SEGUNDOS=120   # timeout de arranque de Chromium (Render free es lento)
```

## 9. Ciclo de operación (pipeline cada 2 minutos)

1. Al arrancar: conectar WhatsApp. Si no hay sesión → servir QR en `GET /qr` (y en logs).
2. **Cada 2 minutos** (`setInterval` interno), por cada canal (los suscritos si `CANALES` está vacío):
   - `fetchMessages` desde la última marca de tiempo procesada (guardada en `pipeline_estado`).
   - Filtrar publicaciones **nuevas**; si no hay ninguna → fin del ciclo (no se hace nada más).
   - Si hay nuevas: descargar la imagen con `downloadMedia()`.
   - Subir la imagen a Supabase Storage (`SUPABASE_BUCKET`) → `imagen_url`.
   - OCR con tesseract.js → `texto_ocr`.
   - `texto_ocr` + prompt de sistema → Mistral `chat/completions` → `texto_ia` (texto tipo página web).
   - Upsert en `canales_publicaciones` (dedupe por `mensaje_id`).
3. Si la sesión se cae (`disconnected`/`auth_failure`): se vuelve a estado "esperando QR"
   en `GET /qr` — con el WhatsApp secundario se re-escanea y sigue. Nada más.
4. `GET /salud` responde 200 (para el keep-alive de UptimeRobot/cron-job.org).
5. `GET /estado` devuelve: conexión WhatsApp, último ciclo, canales, conteos, último error y reproceso.
6. `GET|POST /reprocesar` reprocesa filas **ya guardadas**: toma las que tienen `texto_ia` vacío,
   usa `texto_ocr` (o baja la imagen de `imagen_url` y le hace OCR) y genera el texto con Mistral.
   Con `?todo=1` regenera también las que ya tienen texto. Se ejecuta solo al iniciar
   (`REPROCESAR_AL_INICIAR=true`) hasta `REPROCESO_LOTE` filas por corrida.

## 10. Cómo desplegarlo en Render (paso a paso)

1. **Supabase**: crea el proyecto, abre el SQL Editor y ejecuta `supabase.sql`.
   Guarda la URL del proyecto y la `service_role` key (Settings → API).
2. **Mistral**: crea la API key en https://console.mistral.ai/ (tier gratis disponible).
3. Sube este proyecto a un repo de GitHub.
4. En Render: **New → Web Service** → conecta el repo.
   - Environment: **Docker** (usa el Dockerfile incluido).
   - Plan: **Free** (0.1 CPU / 512 MB: arranca lento; si el QR tarda, sube
     `ESPERA_LISTO_SEGUNDOS=90`).
5. Agrega las variables de entorno (ver `.env.example`):
   `MISTRAL_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_BUCKET`,
   `CANALES` (vacío = todos los canales), `INTERVALO_MINUTOS=2`, `PAUSA_PUBLICACIONES_MS=1500`.
6. Deploy. Vincula la sesión:
   - **Con código (recomendado)**: define `WHATSAPP_TELEFONO` con el número del
     WhatsApp secundario (solo dígitos, con código de país) y abre `/qr`: muestra un
     código de 8 dígitos. En el celular: WhatsApp → Dispositivos vinculados →
     **Vincular con número de teléfono** → ingresa el código.
   - **Con QR**: abre `https://tu-servicio.onrender.com/qr` **desde el celular** y
     escanea (Ajustes → Dispositivos vinculados → Vincular dispositivo).
7. **Keep-alive**: en https://uptimerobot.com (gratis) crea un monitor HTTP que
   haga `GET https://tu-servicio.onrender.com/salud` cada 10 min (evita que Render lo duerma).
8. Verifica en Supabase: `select * from canales_publicaciones order by created_at desc;`
   y que las imágenes abran desde el bucket `imagenes_posts`.
   Para reprocesar: `delete from pipeline_estado;` (vuelve a revisar las últimas 24h).

Endpoints: `/qr` (vincular sesión), `/estado` (diagnóstico), `/salud` (keep-alive).
Estados de fila: `procesada`, `sin_texto`, `sin_ia` (falta API key), `error` (fallo Mistral).

## 11. Resumen de viabilidad

- **Sin interfaz: VIABLE** — whatsapp-web.js es headless de fábrica; solo se necesita
  escanear el QR una vez. No hace falta Electron ni UI web.
- **Todo en la web y GRATIS: VIABLE** — Render free + keep-alive (UptimeRobot) + Supabase
  free + Mistral free + tesseract.js. Costo total $0.
- **Sesión perdida no es problema**: con el WhatsApp secundario, re-escanear el QR toma 10 segundos.
- **OCR + Supabase: no existen en app_avitar** — se crean nuevos; el OCR es tesseract.js gratis.
- **Riesgo principal**: ban del número de WhatsApp (librería no oficial) → por eso número secundario dedicado.



-- WARNING: This schema is for context only and is not meant to be run.
-- Table order and constraints may not be valid for execution.

CREATE TABLE public.publicaciones (
  id_publicaciones bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  tipo_servicio character varying NOT NULL,
  imagen text,
  titulo character varying NOT NULL,
  precio integer NOT NULL,
  categoria character varying NOT NULL,
  estado character varying NOT NULL,
  descripcion text NOT NULL,
  disponibilidad character varying NOT NULL,
  etiquetas text,
  sku character varying NOT NULL,
  ubicacion character varying NOT NULL,
  encuentro_publico boolean NOT NULL,
  fecha_publicacion timestamp without time zone,
  estado_publicacion character varying DEFAULT 'BORRADOR'::character varying CHECK (estado_publicacion::text = ANY (ARRAY['BORRADOR'::character varying, 'PUBLICADO'::character varying, 'ARCHIVADO'::character varying, 'ELIMINAR'::character varying]::text[])),
  creado_por integer NOT NULL,
  fecha_creacion timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
  fecha_actualizacion timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
  actualizado_por integer,
  fecha_eliminacion timestamp without time zone,
  eliminado_por integer,
  Grupo character varying DEFAULT 'BORRADOR'::character varying,
  url_audio text,
  url_video text,
  estado_video text,
  CONSTRAINT publicaciones_pkey PRIMARY KEY (id_publicaciones)
);
CREATE TABLE public.ciudades (
  id_ciudad integer NOT NULL DEFAULT nextval('ciudades_id_ciudad_seq'::regclass),
  numero integer,
  ciudad character varying,
  departamento character varying,
  publicado boolean DEFAULT false,
  cargues integer DEFAULT 0,
  CONSTRAINT ciudades_pkey PRIMARY KEY (id_ciudad)
);
CREATE TABLE public.servicios (
  id_servicio integer NOT NULL DEFAULT nextval('servicios_id_servicio_seq'::regclass),
  nombre character varying NOT NULL,
  clave character varying NOT NULL,
  descripcion text NOT NULL,
  estado character varying NOT NULL DEFAULT 'Activo'::character varying CHECK (estado::text = ANY (ARRAY['Activo'::character varying, 'Inactivo'::character varying]::text[])),
  fecha_creacion timestamp without time zone NOT NULL DEFAULT now(),
  fecha_actualizacion timestamp without time zone NOT NULL DEFAULT now(),
  fecha_eliminacion timestamp without time zone,
  precio integer,
  tipo_servicio character varying,
  CONSTRAINT servicios_pkey PRIMARY KEY (id_servicio)
);
CREATE TABLE public.clientes (
  id_cliente integer NOT NULL DEFAULT nextval('clientes_id_cliente_seq'::regclass),
  email character varying NOT NULL,
  whatsapp character varying NOT NULL,
  estado character varying NOT NULL DEFAULT 'Activo'::character varying CHECK (estado::text = ANY (ARRAY['Activo'::character varying, 'Inactivo'::character varying]::text[])),
  fecha_creacion timestamp without time zone NOT NULL DEFAULT now(),
  fecha_actualizacion timestamp without time zone NOT NULL DEFAULT now(),
  fecha_eliminacion timestamp without time zone,
  Nombres_apellidos character varying,
  numero_documento character varying,
  CONSTRAINT clientes_pkey PRIMARY KEY (id_cliente)
);
CREATE TABLE public.procesos (
  id_proceso integer NOT NULL DEFAULT nextval('procesos_id_proceso_seq'::regclass),
  id_cliente integer NOT NULL,
  id_servicio integer NOT NULL,
  referencia character varying,
  estado character varying NOT NULL DEFAULT 'Pendiente'::character varying CHECK (estado::text = ANY (ARRAY['Pendiente'::character varying, 'Terminado'::character varying]::text[])),
  fecha_creacion timestamp without time zone NOT NULL DEFAULT now(),
  fecha_actualizacion timestamp without time zone NOT NULL DEFAULT now(),
  fecha_eliminacion timestamp without time zone,
  CONSTRAINT procesos_pkey PRIMARY KEY (id_proceso),
  CONSTRAINT procesos_id_servicio_fk FOREIGN KEY (id_servicio) REFERENCES public.servicios(id_servicio),
  CONSTRAINT procesos_id_cliente_fk FOREIGN KEY (id_cliente) REFERENCES public.clientes(id_cliente)
);
CREATE TABLE public.documento (
  id_documento integer NOT NULL DEFAULT nextval('documento_id_documento_seq'::regclass),
  id_proceso integer NOT NULL,
  campo character varying NOT NULL,
  valor text,
  fecha_creacion timestamp without time zone NOT NULL DEFAULT now(),
  fecha_actualizacion timestamp without time zone NOT NULL DEFAULT now(),
  fecha_eliminacion timestamp without time zone,
  CONSTRAINT documento_pkey PRIMARY KEY (id_documento),
  CONSTRAINT documento_id_proceso_fk FOREIGN KEY (id_proceso) REFERENCES public.procesos(id_proceso)
);
CREATE TABLE public.prompts (
  id_prompt integer NOT NULL DEFAULT nextval('prompts_id_prompt_seq'::regclass),
  id_servicio integer,
  tipo_prompt character varying,
  nombre_prompt character varying,
  prompt text,
  fecha_creacion timestamp without time zone NOT NULL DEFAULT now(),
  fecha_actualizacion timestamp without time zone NOT NULL DEFAULT now(),
  fecha_eliminacion timestamp without time zone,
  CONSTRAINT prompts_pkey PRIMARY KEY (id_prompt),
  CONSTRAINT prompts_id_servicio_fk FOREIGN KEY (id_servicio) REFERENCES public.servicios(id_servicio)
);
CREATE TABLE public.template (
  id_template integer GENERATED ALWAYS AS IDENTITY NOT NULL,
  id_servicio integer NOT NULL,
  nombre_template character varying,
  descripcion text,
  version_template character varying,
  url_template character varying,
  fecha_creacion timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
  id_pagina integer,
  CONSTRAINT template_pkey PRIMARY KEY (id_template),
  CONSTRAINT template_id_pagina_fkey FOREIGN KEY (id_pagina) REFERENCES public.paginas(id_pagina),
  CONSTRAINT template_id_servicio_fk FOREIGN KEY (id_servicio) REFERENCES public.servicios(id_servicio)
);
CREATE TABLE public.datos_adicionales_clientes (
  id_dato_adicional integer NOT NULL DEFAULT nextval('datos_adicionales_clientes_id_dato_adicional_seq'::regclass),
  id_cliente integer NOT NULL,
  campo character varying NOT NULL,
  valor text,
  fecha_creacion timestamp without time zone NOT NULL DEFAULT now(),
  fecha_actualizacion timestamp without time zone NOT NULL DEFAULT now(),
  fecha_eliminacion timestamp without time zone,
  CONSTRAINT datos_adicionales_clientes_pkey PRIMARY KEY (id_dato_adicional),
  CONSTRAINT datos_adicionales_clientes_id_cliente_fk FOREIGN KEY (id_cliente) REFERENCES public.clientes(id_cliente)
);
CREATE TABLE public.ventas (
  id_venta integer NOT NULL DEFAULT nextval('ventas_id_venta_seq'::regclass),
  id_cliente integer NOT NULL,
  total numeric NOT NULL,
  fecha_venta timestamp without time zone NOT NULL DEFAULT now(),
  estado character varying NOT NULL DEFAULT 'Pendiente'::character varying CHECK (estado::text = ANY (ARRAY['Pendiente'::character varying, 'Completada'::character varying, 'Cancelada'::character varying]::text[])),
  origen character varying NOT NULL DEFAULT 'Marketplace'::character varying CHECK (origen::text = ANY (ARRAY['Meta Ads'::character varying, 'Marketplace'::character varying, 'Recomendación'::character varying]::text[])),
  CONSTRAINT ventas_pkey PRIMARY KEY (id_venta),
  CONSTRAINT ventas_id_cliente_fk FOREIGN KEY (id_cliente) REFERENCES public.clientes(id_cliente)
);
CREATE TABLE public.detalle_ventas (
  id_detalle_venta integer NOT NULL DEFAULT nextval('detalle_ventas_id_detalle_venta_seq'::regclass),
  id_venta integer NOT NULL,
  id_servicio integer NOT NULL,
  cantidad integer NOT NULL,
  precio_unitario numeric NOT NULL,
  subtotal numeric NOT NULL,
  CONSTRAINT detalle_ventas_pkey PRIMARY KEY (id_detalle_venta),
  CONSTRAINT detalle_ventas_id_venta_fk FOREIGN KEY (id_venta) REFERENCES public.ventas(id_venta),
  CONSTRAINT detalle_ventas_id_servicio_fk FOREIGN KEY (id_servicio) REFERENCES public.servicios(id_servicio)
);
CREATE TABLE public.archivo (
  id_archivo integer NOT NULL DEFAULT nextval('archivo_id_archivo_seq'::regclass),
  id_detalle_venta integer NOT NULL,
  link text,
  fecha_creacion timestamp without time zone NOT NULL DEFAULT now(),
  fecha_actualizacion timestamp without time zone NOT NULL DEFAULT now(),
  CONSTRAINT archivo_pkey PRIMARY KEY (id_archivo),
  CONSTRAINT archivo_id_detalle_venta_fk FOREIGN KEY (id_detalle_venta) REFERENCES public.detalle_ventas(id_detalle_venta)
);
CREATE TABLE public.pagos (
  id_pago integer NOT NULL DEFAULT nextval('pagos_id_pago_seq'::regclass),
  id_venta integer NOT NULL,
  id_wompi text NOT NULL,
  link_pago text,
  id_transaccion text,
  metodo_pago text,
  fecha_transaccion timestamp without time zone,
  estado character varying NOT NULL DEFAULT 'Pendiente'::character varying CHECK (estado::text = ANY (ARRAY['Pendiente'::character varying, 'Pagado'::character varying]::text[])),
  comprobante_url text,
  CONSTRAINT pagos_pkey PRIMARY KEY (id_pago),
  CONSTRAINT pagos_id_venta_fk FOREIGN KEY (id_venta) REFERENCES public.ventas(id_venta)
);
CREATE TABLE public.paginas (
  id_pagina integer NOT NULL DEFAULT nextval('paginas_id_pagina_seq'::regclass),
  id_page text,
  nombre text,
  nicho text,
  url_page text,
  fecha_creacion timestamp without time zone NOT NULL DEFAULT now(),
  fecha_actualizacion timestamp without time zone NOT NULL DEFAULT now(),
  CONSTRAINT paginas_pkey PRIMARY KEY (id_pagina)
);
CREATE TABLE public.meta_ads (
  id_meta_ad integer NOT NULL DEFAULT nextval('meta_ads_id_meta_ad_seq'::regclass),
  meta_campaign_id character varying NOT NULL,
  meta_campaign_name character varying,
  meta_adset_id character varying NOT NULL,
  meta_adset_name character varying,
  meta_ad_id character varying NOT NULL UNIQUE,
  meta_ad_name character varying,
  tipo_presupuesto character varying CHECK (tipo_presupuesto::text = ANY (ARRAY['CBO'::character varying, 'ABO'::character varying]::text[])),
  categoria character varying CHECK (categoria::text = ANY (ARRAY['Testeo'::character varying, 'Escala'::character varying]::text[])),
  estado character varying,
  meta_spend numeric NOT NULL DEFAULT 0,
  meta_clicks integer NOT NULL DEFAULT 0,
  meta_conversaciones integer NOT NULL DEFAULT 0,
  meta_costo_conversacion numeric NOT NULL DEFAULT 0,
  meta_sync_at timestamp without time zone,
  created_at timestamp without time zone NOT NULL DEFAULT now(),
  updated_at timestamp without time zone NOT NULL DEFAULT now(),
  meta_presupuesto_diario numeric NOT NULL DEFAULT 0,
  CONSTRAINT meta_ads_pkey PRIMARY KEY (id_meta_ad)
);
CREATE TABLE public.meta_ads_ventas (
  id_meta_ad_venta integer NOT NULL DEFAULT nextval('meta_ads_ventas_id_meta_ad_venta_seq'::regclass),
  id_venta integer NOT NULL UNIQUE,
  id_meta_ad integer NOT NULL,
  created_at timestamp without time zone NOT NULL DEFAULT now(),
  CONSTRAINT meta_ads_ventas_pkey PRIMARY KEY (id_meta_ad_venta),
  CONSTRAINT meta_ads_ventas_venta_fk FOREIGN KEY (id_venta) REFERENCES public.ventas(id_venta),
  CONSTRAINT meta_ads_ventas_ad_fk FOREIGN KEY (id_meta_ad) REFERENCES public.meta_ads(id_meta_ad)
);
CREATE TABLE public.meta_ads_campanas (
  id_campana_meta integer NOT NULL DEFAULT nextval('meta_ads_campanas_id_campana_meta_seq'::regclass),
  meta_campaign_id character varying NOT NULL UNIQUE,
  meta_campaign_name character varying,
  dias_activos integer NOT NULL DEFAULT 1,
  updated_at timestamp without time zone NOT NULL DEFAULT now(),
  fecha_inicio date,
  fecha_fin date,
  presupuesto_total numeric NOT NULL DEFAULT 0,
  CONSTRAINT meta_ads_campanas_pkey PRIMARY KEY (id_campana_meta)
);
CREATE TABLE public.gastos (
  id_gasto integer NOT NULL DEFAULT nextval('gastos_id_gasto_seq'::regclass),
  concepto character varying NOT NULL,
  monto numeric NOT NULL CHECK (monto > 0::numeric),
  tipo_egreso character varying NOT NULL DEFAULT 'gasto'::character varying CHECK (tipo_egreso::text = ANY (ARRAY['costo'::character varying, 'gasto'::character varying]::text[])),
  categoria character varying NOT NULL DEFAULT 'operacional'::character varying CHECK (categoria::text = ANY (ARRAY['personal'::character varying, 'publicidad'::character varying, 'internet_hosting'::character varying, 'operacional'::character varying, 'otros'::character varying]::text[])),
  subcategoria character varying,
  plataforma character varying,
  tipo_operacion character varying,
  metodo_pago character varying CHECK (metodo_pago::text = ANY (ARRAY['Efectivo'::character varying, 'Nequi'::character varying, 'Daviplata'::character varying, 'Davivienda'::character varying, 'Bancolombia'::character varying]::text[])) NOT VALI),
  cuenta_bancaria character varying,
  fecha_gasto timestamp without time zone NOT NULL DEFAULT now(),
  fecha_creacion timestamp without time zone NOT NULL DEFAULT now(),
  fecha_actualizacion timestamp without time zone,
  CONSTRAINT gastos_pkey PRIMARY KEY (id_gasto)
);
CREATE TABLE public.flujos (
  id_flujo bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  nombre character varying NOT NULL,
  descripcion text NOT NULL DEFAULT ''::text,
  mensajes jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(mensajes) = 'array'::text),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT flujos_pkey PRIMARY KEY (id_flujo)
);
CREATE TABLE public.flujo_ejecuciones (
  id_ejecucion uuid NOT NULL DEFAULT gen_random_uuid(),
  contacto text NOT NULL,
  id_flujo integer NOT NULL,
  evento_inicio_id text UNIQUE,
  paso_actual integer NOT NULL DEFAULT 0 CHECK (paso_actual >= 0),
  estado text NOT NULL DEFAULT 'activo'::text CHECK (estado = ANY (ARRAY['activo'::text, 'completada'::text, 'error'::text])),
  proximo_envio timestamp with time zone,
  ultimo_envio timestamp with time zone,
  ultimo_error text,
  lease_token uuid,
  lease_until timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  definicion_flujo jsonb,
  CONSTRAINT flujo_ejecuciones_pkey PRIMARY KEY (id_ejecucion),
  CONSTRAINT flujo_ejecuciones_id_flujo_fkey FOREIGN KEY (id_flujo) REFERENCES public.flujos(id_flujo)
);
CREATE TABLE public.flujo_envios (
  id_envio uuid NOT NULL DEFAULT gen_random_uuid(),
  id_ejecucion uuid NOT NULL,
  paso_indice integer NOT NULL CHECK (paso_indice >= 0),
  tipo text NOT NULL,
  estado text NOT NULL DEFAULT 'procesando'::text CHECK (estado = ANY (ARRAY['procesando'::text, 'pendiente'::text, 'enviado'::text, 'fallido'::text, 'indeterminado'::text])),
  intentos integer NOT NULL DEFAULT 1 CHECK (intentos > 0),
  id_mensaje_externo text,
  error_detalle text,
  enviado_en timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  actualizado_en timestamp with time zone NOT NULL DEFAULT now(),
  seccion text NOT NULL DEFAULT 'flujo_principal'::text,
  CONSTRAINT flujo_envios_pkey PRIMARY KEY (id_envio),
  CONSTRAINT flujo_envios_id_ejecucion_fkey FOREIGN KEY (id_ejecucion) REFERENCES public.flujo_ejecuciones(id_ejecucion)
);
CREATE TABLE public.flujo_seguimiento_aportes (
  id_seguimiento uuid NOT NULL DEFAULT gen_random_uuid(),
  id_ejecucion uuid NOT NULL UNIQUE,
  contacto text NOT NULL,
  definicion_flujo jsonb,
  estado text NOT NULL DEFAULT 'esperando_comprobante'::text CHECK (estado = ANY (ARRAY['esperando_comprobante'::text, 'validando_comprobante'::text, 'pagado'::text, 'agradecimiento_en_progreso'::text, 'agradecimiento_pendiente'::text, 'completado'::text, 'conversando'::text, 'remarketing_en_progreso'::text, 'remarketing_enviado'::text, 'revision_manual'::text])),
  estado_previo text,
  vence_en timestamp with time zone NOT NULL,
  proximo_envio timestamp with time zone,
  paso_remarketing integer NOT NULL DEFAULT 0 CHECK (paso_remarketing >= 0),
  paso_agradecimiento integer NOT NULL DEFAULT 0 CHECK (paso_agradecimiento >= 0),
  evento_comprobante_id text UNIQUE,
  intentos_comprobante integer NOT NULL DEFAULT 0 CHECK (intentos_comprobante >= 0),
  fecha_pago timestamp with time zone,
  ultimo_error text,
  lease_token uuid,
  lease_until timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  ronda_remarketing integer NOT NULL DEFAULT 0 CHECK (ronda_remarketing >= 0),
  comprobante_mensaje jsonb,
  comprobante_reintento_en timestamp with time zone,
  ultimo_comprobante jsonb,
  CONSTRAINT flujo_seguimiento_aportes_pkey PRIMARY KEY (id_seguimiento),
  CONSTRAINT flujo_seguimiento_aportes_id_ejecucion_fkey FOREIGN KEY (id_ejecucion) REFERENCES public.flujo_ejecuciones(id_ejecucion)
);
CREATE TABLE public.flujo_comprobantes_procesados (
  evento_id text NOT NULL,
  id_seguimiento uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT flujo_comprobantes_procesados_pkey PRIMARY KEY (evento_id),
  CONSTRAINT flujo_comprobantes_procesados_id_seguimiento_fkey FOREIGN KEY (id_seguimiento) REFERENCES public.flujo_seguimiento_aportes(id_seguimiento)
);
CREATE TABLE public.mensajes_chat (
  id_mensaje text NOT NULL,
  direccion text NOT NULL CHECK (direccion = ANY (ARRAY['entrante'::text, 'saliente'::text])),
  contacto text NOT NULL,
  id_ejecucion uuid,
  id_seguimiento uuid,
  tipo text,
  contenido text,
  caption text,
  mimetype text,
  sender_name text,
  timestamp_mensaje timestamp with time zone,
  id_mensaje_externo text,
  metadata jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT mensajes_chat_pkey PRIMARY KEY (id_mensaje)
);
CREATE TABLE public.flujo_eventos_ia (
  evento_id text NOT NULL,
  id_ejecucion uuid NOT NULL,
  contacto text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT flujo_eventos_ia_pkey PRIMARY KEY (evento_id),
  CONSTRAINT flujo_eventos_ia_id_ejecucion_fkey FOREIGN KEY (id_ejecucion) REFERENCES public.flujo_ejecuciones(id_ejecucion)
);
CREATE TABLE public.meta_ads_presupuestos_rango (
  id_presupuesto_rango integer NOT NULL DEFAULT nextval('meta_ads_presupuestos_rango_id_presupuesto_rango_seq'::regclass),
  meta_campaign_id character varying NOT NULL,
  meta_campaign_name character varying,
  fecha_inicio date NOT NULL,
  fecha_fin date NOT NULL,
  presupuesto_total numeric NOT NULL DEFAULT 0,
  created_at timestamp without time zone NOT NULL DEFAULT now(),
  updated_at timestamp without time zone NOT NULL DEFAULT now(),
  CONSTRAINT meta_ads_presupuestos_rango_pkey PRIMARY KEY (id_presupuesto_rango)
);
CREATE TABLE public.canales_publicaciones (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  mensaje_id text NOT NULL UNIQUE,
  canal_id text NOT NULL,
  canal_nombre text,
  fecha_publicacion timestamp with time zone NOT NULL,
  tipo text NOT NULL DEFAULT 'imagen'::text,
  imagen_url text,
  texto_ocr text,
  texto_ia text,
  modelo_ia text,
  estado text NOT NULL DEFAULT 'procesada'::text,
  error text,
  metadata jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT canales_publicaciones_pkey PRIMARY KEY (id)
);
CREATE TABLE public.pipeline_estado (
  canal text NOT NULL,
  ultima_ts bigint NOT NULL DEFAULT 0,
  actualizado_en timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT pipeline_estado_pkey PRIMARY KEY (canal)
);