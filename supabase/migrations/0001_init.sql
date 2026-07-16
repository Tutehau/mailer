-- Email Cérience — schéma multi-utilisateurs
--
-- À exécuter une seule fois dans le Studio Supabase (SQL Editor) de
-- l'instance self-hosted. Chaque compte (auth.users) obtient une ligne
-- profiles isolée par RLS ; contacts/templates/send_history sont scopés
-- par utilisateur de la même façon.
--
-- Le super administrateur est verrouillé à une adresse email précise
-- (contact@tutehau.com) directement dans le trigger ci-dessous : peu
-- importe qui s'inscrit en premier, seule cette adresse peut obtenir le
-- rôle 'super_admin'. Pour changer cette adresse plus tard, modifie et
-- relance uniquement la fonction handle_new_user (CREATE OR REPLACE).

create extension if not exists pgcrypto;

/* ------------------------------------------------------------------ */
/* profiles — étend auth.users avec le rôle et les identifiants Gmail  */
/* de l'utilisateur (mot de passe d'application chiffré côté app,      */
/* jamais en clair ici).                                               */
/* ------------------------------------------------------------------ */

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  role text not null default 'user' check (role in ('user', 'super_admin')),
  gmail_user text,
  gmail_app_password_enc text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "profiles_select_own" on public.profiles
  for select using (auth.uid() = id);

create policy "profiles_update_own" on public.profiles
  for update using (auth.uid() = id) with check (auth.uid() = id);

-- Pas de policy insert/delete : la ligne profiles est créée uniquement
-- par le trigger handle_new_user (SECURITY DEFINER, contourne RLS).

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, role)
  values (
    new.id,
    new.email,
    case when lower(new.email) = lower('contact@tutehau.com') then 'super_admin' else 'user' end
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_touch_updated_at on public.profiles;
create trigger profiles_touch_updated_at
  before update on public.profiles
  for each row execute function public.touch_updated_at();

-- Permet à la page d'inscription de savoir si un super admin existe déjà,
-- sans exposer les autres comptes (utilisable avec la seule clé anon).
create or replace function public.has_super_admin()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (select 1 from public.profiles where role = 'super_admin');
$$;

grant execute on function public.has_super_admin() to anon, authenticated;

/* ------------------------------------------------------------------ */
/* contacts                                                             */
/* ------------------------------------------------------------------ */

create table public.contacts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null,
  email text not null,
  phone text not null default '',
  type text not null check (type in ('particulier', 'professionnel')),
  company text not null default '',
  notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz
);

alter table public.contacts enable row level security;

create policy "contacts_all_own" on public.contacts
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create index contacts_user_id_idx on public.contacts (user_id);

/* ------------------------------------------------------------------ */
/* templates — id lisible (slug) choisi par l'utilisateur, unique par  */
/* utilisateur seulement (pas globalement).                            */
/* ------------------------------------------------------------------ */

create table public.templates (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  id text not null,
  name text not null,
  to_addresses text[] not null default '{}',
  subject text not null,
  html text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, id)
);

alter table public.templates enable row level security;

create policy "templates_all_own" on public.templates
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

/* ------------------------------------------------------------------ */
/* send_history                                                         */
/* ------------------------------------------------------------------ */

create table public.send_history (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  message_id text,
  date timestamptz not null default now(),
  to_addresses text[] not null default '{}',
  cc_addresses text[] not null default '{}',
  subject text not null,
  attachments text[] not null default '{}',
  status text not null default 'sent'
);

alter table public.send_history enable row level security;

create policy "send_history_all_own" on public.send_history
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create index send_history_user_date_idx on public.send_history (user_id, date desc);
