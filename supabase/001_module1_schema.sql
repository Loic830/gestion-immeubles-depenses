-- =====================================================================
--  Module 1 – Gestion des dépenses et numérisation des factures
--  Schéma PostgreSQL pour Supabase
--
--  Utilisation : Supabase > SQL Editor > New query > coller tout > Run.
--  Le script est prévu pour un projet vide (à exécuter une seule fois).
--
--  Contenu :
--    1. Extensions et types
--    2. Tables (8)
--    3. Fonctions et déclencheurs (updated_at, normalisation, ventilation)
--    4. Vue v_depenses_detail
--    5. Sécurité (RLS)
--    6. Stockage des reçus (bucket privé « recus »)
--    7. Données de départ (immeubles, logements, catégories, paiements)
--
--  Conventions :
--    - Montants en cents (bigint), jamais en décimal flottant.
--    - Suppressions « douces » via deleted_at : rien n'est effacé.
--    - Une dépense « brouillon » peut être incomplète (mode photo seulement).
--      Une dépense « complete » doit être entièrement ventilée.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. Extensions et types
-- ---------------------------------------------------------------------
create extension if not exists unaccent with schema extensions;

create type public.nature_depense as enum ('courante', 'capital');

create type public.type_paiement as enum (
  'carte_credit', 'debit', 'virement', 'cheque', 'comptant', 'prelevement'
);

create type public.statut_depense as enum ('brouillon', 'complete');


-- ---------------------------------------------------------------------
-- 2. Tables
-- ---------------------------------------------------------------------

-- Immeubles ------------------------------------------------------------
create table public.immeubles (
  id               uuid primary key default gen_random_uuid(),
  nom              text not null unique,
  adresse          text,
  nb_logements     int  check (nb_logements >= 0),
  date_acquisition date,                       -- utile pour la DPA
  actif            boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  deleted_at       timestamptz
);

-- Logements ------------------------------------------------------------
create table public.logements (
  id          uuid primary key default gen_random_uuid(),
  immeuble_id uuid not null references public.immeubles(id),
  numero      text not null,
  actif       boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  unique (immeuble_id, numero),
  unique (id, immeuble_id)                     -- permet de vérifier qu'un logement appartient bien à l'immeuble d'une ligne
);

-- Catégories (avec sous-catégories) ------------------------------------
create table public.categories (
  id            uuid primary key default gen_random_uuid(),
  nom           text not null,
  parent_id     uuid references public.categories(id),
  code_fiscal   text,                          -- ligne du formulaire T776 (fédéral)
  nature_defaut public.nature_depense not null default 'courante',
  est_systeme   boolean not null default false, -- prédéfinie : renommable, non supprimable
  ordre         int not null default 0,
  actif         boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);
create unique index categories_nom_parent_uniq
  on public.categories (coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(nom));

-- Fournisseurs ---------------------------------------------------------
create table public.fournisseurs (
  id                  uuid primary key default gen_random_uuid(),
  nom                 text not null,
  nom_normalise       text not null,           -- rempli par déclencheur (minuscules, sans accents)
  categorie_defaut_id uuid references public.categories(id),
  no_tps              text,
  no_tvq              text,
  telephone           text,
  courriel            text,
  notes               text,
  actif               boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  deleted_at          timestamptz
);
create unique index fournisseurs_nom_normalise_uniq
  on public.fournisseurs (nom_normalise) where deleted_at is null;

-- Modes de paiement ----------------------------------------------------
create table public.modes_paiement (
  id         uuid primary key default gen_random_uuid(),
  nom        text not null unique,
  type       public.type_paiement not null,
  actif      boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Dépenses (en-tête de la facture) -------------------------------------
create table public.depenses (
  id               uuid primary key default gen_random_uuid(),
  fournisseur_id   uuid references public.fournisseurs(id),
  mode_paiement_id uuid references public.modes_paiement(id),
  date_facture     date not null default current_date,
  date_paiement    date,
  no_facture       text,
  sous_total_cents bigint check (sous_total_cents >= 0),
  tps_cents        bigint not null default 0 check (tps_cents >= 0),
  tvq_cents        bigint not null default 0 check (tvq_cents >= 0),
  total_cents      bigint check (total_cents >= 0),
  statut           public.statut_depense not null default 'brouillon',
  notes            text,
  cree_par         uuid references auth.users(id) default auth.uid(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  deleted_at       timestamptz,
  -- Une dépense complète doit avoir un total.
  constraint depense_complete_a_un_total
    check (statut = 'brouillon' or total_cents is not null)
  -- Note : l'écart sous-total + TPS + TVQ ≠ total est un simple avertissement
  -- dans l'interface, pas une contrainte de base de données.
);
create index depenses_date_idx        on public.depenses (date_facture);
create index depenses_fournisseur_idx on public.depenses (fournisseur_id);
create index depenses_statut_idx      on public.depenses (statut) where deleted_at is null;
-- Doublon probable : même fournisseur + même numéro de facture
create unique index depenses_no_facture_uniq
  on public.depenses (fournisseur_id, no_facture)
  where no_facture is not null and deleted_at is null;

-- Lignes de dépense (la ventilation) -----------------------------------
create table public.depense_lignes (
  id           uuid primary key default gen_random_uuid(),
  depense_id   uuid not null references public.depenses(id) on delete cascade,
  immeuble_id  uuid not null references public.immeubles(id),   -- association obligatoire
  logement_id  uuid,
  categorie_id uuid references public.categories(id),            -- obligatoire quand la dépense est complète
  nature       public.nature_depense not null,                   -- héritée de la catégorie si non fournie
  montant_cents bigint check (montant_cents >= 0),               -- taxes incluses ; obligatoire quand complète
  description  text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  -- Le logement, s'il est indiqué, doit appartenir à l'immeuble de la ligne.
  foreign key (logement_id, immeuble_id) references public.logements (id, immeuble_id)
);
create index depense_lignes_depense_idx   on public.depense_lignes (depense_id);
create index depense_lignes_immeuble_idx  on public.depense_lignes (immeuble_id);
create index depense_lignes_categorie_idx on public.depense_lignes (categorie_id);

-- Pièces jointes (photos et PDF des reçus) -----------------------------
create table public.pieces_jointes (
  id            uuid primary key default gen_random_uuid(),
  depense_id    uuid not null references public.depenses(id) on delete cascade,
  storage_key   text not null unique,          -- chemin dans le bucket, ex. 2026/10/<uuid>.jpg
  miniature_key text,                          -- aperçu 400 px
  mime_type     text not null check (mime_type in ('image/jpeg', 'image/webp', 'application/pdf')),
  taille_octets int  check (taille_octets > 0),
  largeur       int,
  hauteur       int,
  sha256        text,                          -- empreinte pour signaler un reçu déjà téléversé
  nom_original  text,
  ajoute_par    uuid references auth.users(id) default auth.uid(),
  created_at    timestamptz not null default now()
);
create index pieces_jointes_depense_idx on public.pieces_jointes (depense_id);
create index pieces_jointes_sha256_idx  on public.pieces_jointes (sha256);


-- ---------------------------------------------------------------------
-- 3. Fonctions et déclencheurs
-- ---------------------------------------------------------------------

-- 3a. updated_at automatique
create or replace function public.maj_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger trg_immeubles_maj      before update on public.immeubles      for each row execute function public.maj_updated_at();
create trigger trg_logements_maj      before update on public.logements      for each row execute function public.maj_updated_at();
create trigger trg_categories_maj     before update on public.categories     for each row execute function public.maj_updated_at();
create trigger trg_fournisseurs_maj   before update on public.fournisseurs   for each row execute function public.maj_updated_at();
create trigger trg_modes_paiement_maj before update on public.modes_paiement for each row execute function public.maj_updated_at();
create trigger trg_depenses_maj       before update on public.depenses       for each row execute function public.maj_updated_at();
create trigger trg_depense_lignes_maj before update on public.depense_lignes for each row execute function public.maj_updated_at();

-- 3b. Nom de fournisseur normalisé (« HOME DEPOT » = « Home Dépôt »)
create or replace function public.normaliser_fournisseur()
returns trigger language plpgsql as $$
begin
  new.nom := regexp_replace(btrim(new.nom), '\s+', ' ', 'g');
  new.nom_normalise := lower(extensions.unaccent(new.nom));
  return new;
end $$;

create trigger trg_fournisseurs_normaliser
  before insert or update of nom on public.fournisseurs
  for each row execute function public.normaliser_fournisseur();

-- 3c. Nature de la ligne héritée de la catégorie si non fournie
create or replace function public.ligne_nature_par_defaut()
returns trigger language plpgsql as $$
begin
  if new.nature is null then
    select c.nature_defaut into new.nature
    from public.categories c where c.id = new.categorie_id;
    new.nature := coalesce(new.nature, 'courante');
  end if;
  return new;
end $$;

create trigger trg_lignes_nature
  before insert or update on public.depense_lignes
  for each row execute function public.ligne_nature_par_defaut();

-- 3d. Catégories système : non supprimables
create or replace function public.proteger_categories_systeme()
returns trigger language plpgsql as $$
begin
  if old.est_systeme then
    raise exception 'La catégorie « % » est prédéfinie : elle peut être renommée ou désactivée, pas supprimée.', old.nom;
  end if;
  return old;
end $$;

create trigger trg_categories_protection
  before delete on public.categories
  for each row execute function public.proteger_categories_systeme();

-- 3e. Vérification de la ventilation d'une dépense complète
--     Exécutée en fin de transaction (DEFERRABLE) pour permettre
--     d'insérer l'en-tête puis les lignes dans la même transaction.
create or replace function public.verifier_ventilation()
returns trigger language plpgsql as $$
declare
  v_id        uuid;
  v_total     bigint;
  v_statut    public.statut_depense;
  v_supprimee timestamptz;
  v_nb        int;
  v_incomplet int;
  v_somme     bigint;
begin
  if tg_table_name = 'depenses' then
    v_id := new.id;
  elsif tg_op = 'DELETE' then
    v_id := old.depense_id;
  else
    v_id := new.depense_id;
  end if;

  select total_cents, statut, deleted_at
    into v_total, v_statut, v_supprimee
  from public.depenses where id = v_id;

  -- Rien à vérifier : dépense supprimée, inexistante ou encore en brouillon.
  if not found or v_supprimee is not null or v_statut <> 'complete' then
    return null;
  end if;

  select count(*),
         count(*) filter (where categorie_id is null or montant_cents is null),
         coalesce(sum(montant_cents), 0)
    into v_nb, v_incomplet, v_somme
  from public.depense_lignes where depense_id = v_id;

  if v_nb = 0 then
    raise exception 'Une dépense complète doit avoir au moins une ligne avec un immeuble.';
  end if;
  if v_incomplet > 0 then
    raise exception 'Chaque ligne d''une dépense complète doit avoir une catégorie et un montant.';
  end if;
  if v_somme <> v_total then
    raise exception 'La somme des lignes (% ¢) ne correspond pas au total de la facture (% ¢). Écart : % ¢.',
      v_somme, v_total, v_total - v_somme;
  end if;

  return null;
end $$;

create constraint trigger trg_depenses_ventilation
  after insert or update on public.depenses
  deferrable initially deferred
  for each row execute function public.verifier_ventilation();

create constraint trigger trg_lignes_ventilation
  after insert or update or delete on public.depense_lignes
  deferrable initially deferred
  for each row execute function public.verifier_ventilation();


-- ---------------------------------------------------------------------
-- 4. Vue pour la liste, les filtres et les exports
-- ---------------------------------------------------------------------
create or replace view public.v_depenses_detail
with (security_invoker = true) as
select
  l.id                 as ligne_id,
  d.id                 as depense_id,
  d.date_facture,
  d.date_paiement,
  d.statut,
  f.nom                as fournisseur,
  i.id                 as immeuble_id,
  i.nom                as immeuble,
  lg.numero            as logement,
  c.id                 as categorie_id,
  c.nom                as categorie,
  cp.nom               as categorie_parent,
  c.code_fiscal,
  l.nature,
  l.montant_cents,
  d.sous_total_cents,
  d.tps_cents,
  d.tvq_cents,
  d.total_cents,
  mp.nom               as mode_paiement,
  d.no_facture,
  l.description,
  d.notes,
  (select count(*) from public.pieces_jointes p where p.depense_id = d.id) as nb_pieces
from public.depense_lignes l
join public.depenses d        on d.id  = l.depense_id
join public.immeubles i       on i.id  = l.immeuble_id
left join public.logements lg on lg.id = l.logement_id
left join public.categories c on c.id  = l.categorie_id
left join public.categories cp on cp.id = c.parent_id
left join public.fournisseurs f on f.id = d.fournisseur_id
left join public.modes_paiement mp on mp.id = d.mode_paiement_id
where d.deleted_at is null;


-- ---------------------------------------------------------------------
-- 5. Sécurité (RLS)
--    Version 1 : tout utilisateur connecté a accès à toutes les données.
--    IMPORTANT : désactiver les inscriptions publiques dans
--    Supabase > Authentication > Providers/Settings, et créer les comptes
--    à la main. Sinon n'importe qui pourrait s'inscrire et voir les données.
-- ---------------------------------------------------------------------
alter table public.immeubles      enable row level security;
alter table public.logements      enable row level security;
alter table public.categories     enable row level security;
alter table public.fournisseurs   enable row level security;
alter table public.modes_paiement enable row level security;
alter table public.depenses       enable row level security;
alter table public.depense_lignes enable row level security;
alter table public.pieces_jointes enable row level security;

create policy acces_authentifie on public.immeubles      for all to authenticated using (true) with check (true);
create policy acces_authentifie on public.logements      for all to authenticated using (true) with check (true);
create policy acces_authentifie on public.categories     for all to authenticated using (true) with check (true);
create policy acces_authentifie on public.fournisseurs   for all to authenticated using (true) with check (true);
create policy acces_authentifie on public.modes_paiement for all to authenticated using (true) with check (true);
create policy acces_authentifie on public.depenses       for all to authenticated using (true) with check (true);
create policy acces_authentifie on public.depense_lignes for all to authenticated using (true) with check (true);
create policy acces_authentifie on public.pieces_jointes for all to authenticated using (true) with check (true);


-- ---------------------------------------------------------------------
-- 6. Stockage des reçus : bucket privé, 15 Mo max, JPEG/WebP/PDF
--    Lecture et téléversement pour les utilisateurs connectés seulement.
--    Aucune politique de suppression : un reçu ne s'efface pas depuis l'app.
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('recus', 'recus', false, 15728640, array['image/jpeg', 'image/webp', 'application/pdf'])
on conflict (id) do nothing;

create policy recus_lecture on storage.objects
  for select to authenticated using (bucket_id = 'recus');

create policy recus_televersement on storage.objects
  for insert to authenticated with check (bucket_id = 'recus');

create policy recus_mise_a_jour on storage.objects
  for update to authenticated using (bucket_id = 'recus') with check (bucket_id = 'recus');


-- ---------------------------------------------------------------------
-- 7. Données de départ
-- ---------------------------------------------------------------------

-- Immeubles (adresses à compléter)
insert into public.immeubles (nom, nb_logements) values
  ('Gauthier',    9),
  ('Robert-Jean', 8),
  ('Camélias',    4);

-- Logements numérotés 1..n (à ajuster selon la vraie numérotation)
insert into public.logements (immeuble_id, numero)
select i.id, g.n::text
from public.immeubles i
cross join lateral generate_series(1, i.nb_logements) as g(n);

-- Catégories principales (code_fiscal = ligne du formulaire T776)
insert into public.categories (nom, code_fiscal, nature_defaut, est_systeme, ordre) values
  ('Entretien et réparations',                   '8960', 'courante', true,  10),
  ('Taxes foncières et scolaires',               '9180', 'courante', true,  20),
  ('Assurances',                                 '8690', 'courante', true,  30),
  ('Électricité et chauffage',                   '9220', 'courante', true,  40),
  ('Eau',                                        '9220', 'courante', true,  50),
  ('Déneigement et terrain',                     '8960', 'courante', true,  60),
  ('Frais de gestion et d''administration',      '8871', 'courante', true,  70),
  ('Honoraires (comptable, juridique, TAL)',     '8860', 'courante', true,  80),
  ('Intérêts et frais bancaires',                '8710', 'courante', true,  90),
  ('Publicité et location',                      '8521', 'courante', true, 100),
  ('Fournitures',                                '9270', 'courante', true, 110),
  ('Frais de déplacement',                       '9200', 'courante', true, 120),
  ('Améliorations en capital',                   'DPA',  'capital',  true, 130);

-- Sous-catégories d'entretien
insert into public.categories (nom, parent_id, code_fiscal, nature_defaut, est_systeme, ordre)
select s.nom, p.id, '8960', 'courante', true, s.ordre
from public.categories p
cross join (values
  ('Plomberie',            10),
  ('Électricité',          20),
  ('Chauffage',            30),
  ('Peinture',             40),
  ('Appareils ménagers',   50),
  ('Serrurerie',           60)
) as s(nom, ordre)
where p.nom = 'Entretien et réparations';

-- Modes de paiement génériques (à renommer selon tes comptes)
insert into public.modes_paiement (nom, type) values
  ('Carte de crédit',        'carte_credit'),
  ('Débit',                  'debit'),
  ('Virement',               'virement'),
  ('Chèque',                 'cheque'),
  ('Comptant',               'comptant'),
  ('Prélèvement automatique','prelevement');

-- Fin du script.
