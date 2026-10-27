-- =====================================================================
--  v0.9.18 – Hypothèque : tableau d'amortissement du prêteur + documents du prêt
--
--  À exécuter une fois dans Supabase > SQL Editor (après 024).
--
--  1. hypotheque_versements : le tableau d'amortissement remis par le prêteur,
--     un versement par ligne (intérêts, capital, solde). Quand il existe, l'app
--     l'utilise tel quel au lieu de son calcul (la banque compte l'intérêt au
--     nombre de jours : chaque mois est un peu différent). Les versements après
--     la dernière ligne sont recalculés à partir du dernier solde.
--  2. documents : accepte les photos ou PDF d'un prêt (type « pret »,
--     colonne hypotheque_id, dossier prets/AAAA/MM/ du bucket « recus »).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Tableau d'amortissement du prêteur
-- ---------------------------------------------------------------------
create table if not exists public.hypotheque_versements (
  id             uuid primary key default gen_random_uuid(),
  hypotheque_id  uuid not null references public.hypotheques(id) on delete cascade,
  no             int  not null check (no between 1 and 600),
  date_versement date not null,
  interets_cents bigint not null check (interets_cents >= 0),
  capital_cents  bigint not null check (capital_cents >= 0),
  solde_cents    bigint not null check (solde_cents >= 0),
  created_at     timestamptz not null default now()
);
create unique index if not exists hypotheque_versements_date_uniq
  on public.hypotheque_versements (hypotheque_id, date_versement);

comment on table public.hypotheque_versements is
  'Tableau d''amortissement du prêteur (v0.9.18) : a priorité sur le calcul de lib/amortissement.ts';

alter table public.hypotheque_versements enable row level security;
drop policy if exists acces_authentifie on public.hypotheque_versements;
create policy acces_authentifie on public.hypotheque_versements
  for all to authenticated using (true) with check (true);

-- ---------------------------------------------------------------------
-- 2. Documents d'un prêt (lettre du prêteur, tableau, acte, renouvellement)
-- ---------------------------------------------------------------------
alter type public.type_document add value if not exists 'pret';

alter table public.documents add column if not exists hypotheque_id uuid references public.hypotheques(id);
create index if not exists documents_hypotheque_idx on public.documents (hypotheque_id) where hypotheque_id is not null;

-- Un document sans bail : police d'assurance, ou document d'un prêt.
-- (comparaison en texte : la nouvelle valeur d'enum ne peut pas servir dans la même transaction)
alter table public.documents drop constraint if exists document_bail_ou_assurance;
alter table public.documents drop constraint if exists document_rattache;
alter table public.documents add constraint document_rattache
  check (bail_id is not null or type::text = 'assurance' or (type::text = 'pret' and hypotheque_id is not null));

-- Fin du script.
