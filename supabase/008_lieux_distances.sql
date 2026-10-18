-- =====================================================================
-- 008 — Lieux et distances pour composer des trajets (Véhicule)
--
-- À exécuter une fois dans Supabase > SQL Editor (après 007).
--
-- On inscrit une seule fois la distance entre deux lieux (ex. Maison ↔ Gauthier
-- 6,2 km, Gauthier ↔ Rona 3,1 km). Ensuite, un trajet comme
-- Maison → Gauthier → Rona → Gauthier → Maison se calcule tout seul.
-- =====================================================================

create table public.lieux (
  id          uuid primary key default gen_random_uuid(),
  nom         text not null check (btrim(nom) <> ''),
  immeuble_id uuid references public.immeubles(id),  -- lieu qui est un immeuble
  ordre       int not null default 100,
  created_at  timestamptz not null default now(),
  deleted_at  timestamptz
);
create unique index lieux_nom_unique on public.lieux (lower(btrim(nom))) where deleted_at is null;

-- Distance entre deux lieux, dans un seul sens (lieu_a < lieu_b) : vaut pour l'aller et le retour
create table public.distances_lieux (
  lieu_a     uuid not null references public.lieux(id) on delete cascade,
  lieu_b     uuid not null references public.lieux(id) on delete cascade,
  km         numeric(6,1) not null check (km > 0),
  updated_at timestamptz not null default now(),
  primary key (lieu_a, lieu_b),
  check (lieu_a < lieu_b)
);

-- Étapes d'un trajet fréquent (liste d'identifiants de lieux), pour l'affichage
alter table public.trajets_favoris add column if not exists etapes jsonb;

alter table public.lieux           enable row level security;
alter table public.distances_lieux enable row level security;
create policy acces_authentifie on public.lieux           for all to authenticated using (true) with check (true);
create policy acces_authentifie on public.distances_lieux for all to authenticated using (true) with check (true);

-- Lieux de départ : la maison et chaque immeuble
insert into public.lieux (nom, ordre) values ('Maison', 0);
insert into public.lieux (nom, immeuble_id, ordre)
select i.nom, i.id, 10 from public.immeubles i
where i.deleted_at is null
  and not exists (select 1 from public.lieux l where lower(btrim(l.nom)) = lower(btrim(i.nom)) and l.deleted_at is null);
