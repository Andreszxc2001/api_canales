-- ============================================================
-- api_canales: esquema de Supabase
-- Ejecutar en el SQL Editor del dashboard de Supabase
-- ============================================================

-- Publicaciones de canales de WhatsApp
create table if not exists public.canales_publicaciones (
  id                uuid primary key default gen_random_uuid(),
  mensaje_id        text unique not null,
  canal_id          text not null,
  canal_nombre      text,
  fecha_publicacion timestamptz not null,
  tipo              text not null default 'imagen',
  imagen_url        text,
  texto_ocr         text,
  texto_ia          text,
  modelo_ia         text,
  estado            text not null default 'procesada',
  error             text,
  metadata          jsonb,
  created_at        timestamptz not null default now()
);

create index if not exists idx_canales_publicaciones_canal_fecha
  on public.canales_publicaciones (canal_id, fecha_publicacion desc);

-- Estado del pipeline (última publicación vista por canal)
create table if not exists public.pipeline_estado (
  canal         text primary key,
  ultima_ts     bigint not null default 0,
  actualizado_en timestamptz not null default now()
);

-- El servicio usa la SERVICE_ROLE_KEY (backend sin usuario final),
-- por lo que no se necesita RLS. Si quieres proteger la lectura
-- desde clientes, actívala a mano:
-- alter table public.canales_publicaciones enable row level security;

-- ============================================================
-- Storage: bucket público para las imágenes de las publicaciones
-- (el nombre debe coincidir con SUPABASE_BUCKET del .env)
-- ============================================================
insert into storage.buckets (id, name, public)
values ('imagenes_posts', 'imagenes_posts', true)
on conflict (id) do nothing;

-- Lectura pública de las imágenes del bucket
drop policy if exists "Lectura publica imagenes_posts" on storage.objects;
create policy "Lectura publica imagenes_posts"
  on storage.objects for select
  using (bucket_id = 'imagenes_posts');
