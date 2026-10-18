-- =====================================================================
-- 007 — Véhicule : journal de bord (km) et frais au prorata
--
-- À exécuter une fois dans Supabase > SQL Editor (après 006).
--
-- Règle fiscale (ARC T4036 / Revenu Québec) : avec des immeubles sur au
-- moins deux sites, les frais de véhicule raisonnables pour percevoir les
-- loyers, superviser des travaux ou gérer les immeubles sont déductibles,
-- au prorata : km pour les immeubles / km totaux de l'année.
-- Il faut garder un registre (date, destination, motif, km) et les reçus.
-- Les calculs (pourcentage, part par immeuble) se font dans l'app.
-- =====================================================================

create type public.type_frais_vehicule as enum (
  'essence', 'entretien', 'assurance', 'immatriculation', 'interets', 'location', 'autre'
);

create table public.vehicules (
  id         uuid primary key default gen_random_uuid(),
  nom        text not null,                     -- ex. Silverado 2019
  actif      boolean not null default true,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- Relevés du compteur : au minimum début et fin d'année (ou date d'achat / de vente)
create table public.releves_odometre (
  id          uuid primary key default gen_random_uuid(),
  vehicule_id uuid not null references public.vehicules(id),
  date_releve date not null,
  km          integer not null check (km >= 0),
  note        text,
  saisi_par   uuid references auth.users(id) default auth.uid(),
  created_at  timestamptz not null default now(),
  deleted_at  timestamptz
);
create unique index releves_odometre_jour
  on public.releves_odometre (vehicule_id, date_releve) where deleted_at is null;

-- Trajets fréquents : un toucher pour inscrire « Maison → Gauthier, 12 km »
create table public.trajets_favoris (
  id          uuid primary key default gen_random_uuid(),
  nom         text not null,
  km          numeric(7,1) not null check (km > 0),
  immeuble_id uuid references public.immeubles(id),
  motif       text,
  created_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

-- Journal de bord : un déplacement pour les immeubles (aller-retour)
create table public.deplacements (
  id           uuid primary key default gen_random_uuid(),
  vehicule_id  uuid not null references public.vehicules(id),
  date_trajet  date not null default current_date,
  km           numeric(7,1) not null check (km > 0 and km < 5000),
  immeuble_id  uuid references public.immeubles(id),   -- vide = plusieurs immeubles / gestion générale
  motif        text not null check (btrim(motif) <> ''),
  destination  text,
  saisi_par    uuid references auth.users(id) default auth.uid(),
  created_at   timestamptz not null default now(),
  deleted_at   timestamptz
);
create index deplacements_date_idx on public.deplacements (vehicule_id, date_trajet);

-- Frais du véhicule à 100 % (le prorata s'applique au calcul)
create table public.frais_vehicule (
  id            uuid primary key default gen_random_uuid(),
  vehicule_id   uuid not null references public.vehicules(id),
  date_frais    date not null default current_date,
  type          public.type_frais_vehicule not null,
  montant_cents bigint not null check (montant_cents > 0),
  fournisseur   text,
  notes         text,
  storage_key   text,                           -- reçu (bucket recus, dossier vehicule/)
  mime_type     text,
  saisi_par     uuid references auth.users(id) default auth.uid(),
  created_at    timestamptz not null default now(),
  deleted_at    timestamptz
);
create index frais_vehicule_date_idx on public.frais_vehicule (vehicule_id, date_frais);

-- Sécurité : comme le reste de l'app, tout utilisateur connecté voit et modifie tout
alter table public.vehicules        enable row level security;
alter table public.releves_odometre enable row level security;
alter table public.trajets_favoris  enable row level security;
alter table public.deplacements     enable row level security;
alter table public.frais_vehicule   enable row level security;
create policy acces_authentifie on public.vehicules        for all to authenticated using (true) with check (true);
create policy acces_authentifie on public.releves_odometre for all to authenticated using (true) with check (true);
create policy acces_authentifie on public.trajets_favoris  for all to authenticated using (true) with check (true);
create policy acces_authentifie on public.deplacements     for all to authenticated using (true) with check (true);
create policy acces_authentifie on public.frais_vehicule   for all to authenticated using (true) with check (true);
