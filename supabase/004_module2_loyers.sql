-- =====================================================================
--  Module 2 – Revenus de loyers : schéma (migration 004)
--
--  À exécuter APRÈS les migrations 001 à 003 (SQL Editor > Run).
--  Réutilise immeubles et logements du Module 1.
--
--  Contenu :
--    1. Types
--    2. Tables : locataires, baux, bail_locataires, bail_extras,
--               echeances, paiements, renouvellements, documents
--    3. Fonctions : fenêtre d'avis TAL, génération des échéances,
--                   création d'un bail en un appel (RPC creer_bail)
--    4. Vues : v_soldes (retards), v_baux (bail courant par logement)
--    5. Fonction occupation(debut, fin) : logements vacants par mois
--    6. Sécurité (RLS) : tout utilisateur connecté voit tout
-- =====================================================================

create extension if not exists btree_gist with schema extensions;

-- ---------------------------------------------------------------------
-- 1. Types
-- ---------------------------------------------------------------------
create type public.mode_loyer as enum ('interac', 'cheque', 'prelevement', 'comptant');
create type public.statut_paiement as enum ('en_main', 'recu', 'sans_provision');
create type public.reponse_renouvellement as enum ('en_attente', 'acceptee', 'refusee', 'depart');
create type public.type_document as enum ('bail', 'avis_modification', 'reponse_locataire', 'autre');

-- ---------------------------------------------------------------------
-- 2. Tables
-- ---------------------------------------------------------------------

create table public.locataires (
  id         uuid primary key default gen_random_uuid(),
  prenom     text not null,
  nom        text not null,
  telephone  text,
  courriel   text,
  notes      text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table public.baux (
  id                uuid primary key default gen_random_uuid(),
  logement_id       uuid not null references public.logements(id),
  date_debut        date not null,
  date_fin          date,                       -- vide = bail à durée indéterminée
  date_depart       date,                       -- départ anticipé (fin réelle si différente)
  loyer_cents       bigint not null check (loyer_cents >= 0),
  jour_echeance     int not null default 1 check (jour_echeance between 1 and 28),
  mode_paiement     public.mode_loyer not null default 'interac',
  inclusions        text,                       -- ex. chauffage, eau chaude
  bail_precedent_id uuid references public.baux(id),
  notes             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  deleted_at        timestamptz,
  check (date_fin is null or date_fin >= date_debut),
  check (date_depart is null or date_depart >= date_debut),
  -- Deux baux ne peuvent pas se chevaucher sur le même logement
  constraint baux_sans_chevauchement exclude using gist (
    logement_id with =,
    daterange(date_debut, coalesce(date_depart, date_fin), '[]') with &&
  ) where (deleted_at is null)
);
create index baux_logement_idx on public.baux (logement_id);

create table public.bail_locataires (
  bail_id      uuid not null references public.baux(id) on delete cascade,
  locataire_id uuid not null references public.locataires(id),
  principal    boolean not null default false,
  primary key (bail_id, locataire_id)
);
create unique index bail_locataires_un_principal
  on public.bail_locataires (bail_id) where principal;

create table public.bail_extras (
  id            uuid primary key default gen_random_uuid(),
  bail_id       uuid not null references public.baux(id) on delete cascade,
  libelle       text not null,                  -- ex. Stationnement, Électricité
  montant_cents bigint not null check (montant_cents >= 0),
  created_at    timestamptz not null default now()
);

-- Loyers dus : une ligne par bail et par mois
create table public.echeances (
  id               uuid primary key default gen_random_uuid(),
  bail_id          uuid not null references public.baux(id) on delete cascade,
  mois             date not null check (mois = date_trunc('month', mois)::date),
  loyer_cents      bigint not null check (loyer_cents >= 0),
  extras_cents     bigint not null default 0 check (extras_cents >= 0),
  montant_du_cents bigint generated always as (loyer_cents + extras_cents) stored,
  note             text,                        -- raison d'un ajustement (mois gratuit, rabais…)
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (bail_id, mois)
);
create index echeances_mois_idx on public.echeances (mois);

create table public.paiements (
  id            uuid primary key default gen_random_uuid(),
  echeance_id   uuid not null references public.echeances(id) on delete cascade,
  montant_cents bigint not null check (montant_cents > 0),
  mode          public.mode_loyer not null,
  statut        public.statut_paiement not null default 'recu',
  date_prevue   date,                           -- date du chèque postdaté ou du prélèvement
  date_recue    date,                           -- date d'encaissement réelle
  reference     text,                           -- no de chèque, no de virement
  notes         text,
  saisi_par     uuid references auth.users(id) default auth.uid(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  check (statut <> 'recu' or date_recue is not null)
);
create index paiements_echeance_idx on public.paiements (echeance_id);
create index paiements_date_recue_idx on public.paiements (date_recue);

create table public.renouvellements (
  id                  uuid primary key default gen_random_uuid(),
  bail_id             uuid not null unique references public.baux(id) on delete cascade,
  avis_du             date,                     -- ouverture de la fenêtre légale d'envoi
  avis_au             date,                     -- dernier jour pour envoyer l'avis
  date_avis_envoye    date,
  nouveau_loyer_cents bigint check (nouveau_loyer_cents >= 0),
  reponse             public.reponse_renouvellement not null default 'en_attente',
  date_reponse        date,
  nouveau_bail_id     uuid references public.baux(id),
  notes               text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create table public.documents (
  id                uuid primary key default gen_random_uuid(),
  bail_id           uuid not null references public.baux(id) on delete cascade,
  renouvellement_id uuid references public.renouvellements(id) on delete set null,
  type              public.type_document not null,
  storage_key       text not null unique,       -- même bucket privé « recus », préfixe baux/
  mime_type         text not null check (mime_type in ('image/jpeg', 'image/webp', 'application/pdf')),
  date_document     date,
  nom_original      text,
  ajoute_par        uuid references auth.users(id) default auth.uid(),
  created_at        timestamptz not null default now()
);
create index documents_bail_idx on public.documents (bail_id);

-- updated_at automatique (fonction créée par la migration 001)
create trigger trg_locataires_maj      before update on public.locataires      for each row execute function public.maj_updated_at();
create trigger trg_baux_maj            before update on public.baux            for each row execute function public.maj_updated_at();
create trigger trg_echeances_maj       before update on public.echeances       for each row execute function public.maj_updated_at();
create trigger trg_paiements_maj       before update on public.paiements       for each row execute function public.maj_updated_at();
create trigger trg_renouvellements_maj before update on public.renouvellements for each row execute function public.maj_updated_at();


-- ---------------------------------------------------------------------
-- 3. Fonctions
-- ---------------------------------------------------------------------

-- 3a. Fenêtre légale d'envoi de l'avis de modification (C.c.Q. art. 1942)
--     Bail de 12 mois ou plus : entre 6 et 3 mois avant la fin.
--     Bail de moins de 12 mois : entre 2 et 1 mois avant la fin.
--     Bail à durée indéterminée : pas de date de fin, donc pas de fenêtre fixe.
create or replace function public.fenetre_avis(p_debut date, p_fin date)
returns table (avis_du date, avis_au date)
language sql immutable as $$
  select
    case when p_fin is null then null
         when (p_fin + 1) >= (p_debut + interval '12 months') then ((p_fin + 1) - interval '6 months')::date
         else ((p_fin + 1) - interval '2 months')::date end,
    case when p_fin is null then null
         when (p_fin + 1) >= (p_debut + interval '12 months') then ((p_fin + 1) - interval '3 months')::date - 1
         else ((p_fin + 1) - interval '1 month')::date - 1 end
$$;

-- 3b. Génère les échéances manquantes d'un bail jusqu'à un mois donné.
--     Bail à durée déterminée : jusqu'à la fin du bail.
--     Bail à durée indéterminée : jusqu'à p_jusqua (par défaut, 12 mois devant).
--     Les échéances existantes ne sont jamais modifiées (ajustements préservés).
create or replace function public.generer_echeances(p_bail uuid, p_jusqua date default null)
returns int
language plpgsql security invoker set search_path = public as $$
declare
  b       baux%rowtype;
  v_fin   date;
  v_extra bigint;
  v_nb    int;
begin
  select * into b from baux where id = p_bail and deleted_at is null;
  if not found then raise exception 'Bail introuvable.'; end if;

  v_fin := coalesce(b.date_depart, b.date_fin,
                    coalesce(p_jusqua, (date_trunc('month', current_date) + interval '12 months')::date));
  select coalesce(sum(montant_cents), 0) into v_extra from bail_extras where bail_id = p_bail;

  insert into echeances (bail_id, mois, loyer_cents, extras_cents)
  select p_bail, m::date, b.loyer_cents, v_extra
  from generate_series(date_trunc('month', b.date_debut), date_trunc('month', v_fin), interval '1 month') as m
  on conflict (bail_id, mois) do nothing;

  get diagnostics v_nb = row_count;
  return v_nb;
end $$;

-- 3c. Prolonge les baux à durée indéterminée (à appeler en ouvrant l'app, sans risque)
create or replace function public.prolonger_echeances()
returns int
language plpgsql security invoker set search_path = public as $$
declare
  r     record;
  v_tot int := 0;
begin
  for r in select id from baux where deleted_at is null and date_fin is null and date_depart is null loop
    v_tot := v_tot + generer_echeances(r.id);
  end loop;
  return v_tot;
end $$;

-- 3d. Crée un bail complet en une seule transaction :
--     bail + locataires (existants ou nouveaux) + extras + échéances + suivi de renouvellement.
--
--  p = {
--    "logement_id": "uuid", "date_debut": "2026-07-01", "date_fin": "2027-06-30" | null,
--    "loyer_cents": 95000, "jour_echeance": 1, "mode_paiement": "interac",
--    "inclusions": "chauffage", "notes": null, "bail_precedent_id": null,
--    "locataires": [ { "id": "uuid" } | { "prenom": "...", "nom": "...", "telephone": "...", "courriel": "..." } ],
--                  (le premier de la liste est le locataire principal)
--    "extras": [ { "libelle": "Stationnement", "montant_cents": 3000 } ]
--  }
create or replace function public.creer_bail(p jsonb)
returns uuid
language plpgsql security invoker set search_path = public as $$
declare
  v_bail uuid;
  v_loc  uuid;
  l      jsonb;
  e      jsonb;
  v_i    int := 0;
  f      record;
begin
  if jsonb_array_length(coalesce(p->'locataires', '[]'::jsonb)) = 0 then
    raise exception 'Un bail doit avoir au moins un locataire.';
  end if;

  insert into baux (logement_id, date_debut, date_fin, loyer_cents, jour_echeance,
                    mode_paiement, inclusions, notes, bail_precedent_id)
  values (
    (p->>'logement_id')::uuid,
    (p->>'date_debut')::date,
    nullif(p->>'date_fin', '')::date,
    (p->>'loyer_cents')::bigint,
    coalesce((p->>'jour_echeance')::int, 1),
    coalesce(nullif(p->>'mode_paiement', '')::mode_loyer, 'interac'),
    nullif(btrim(p->>'inclusions'), ''),
    nullif(btrim(p->>'notes'), ''),
    nullif(p->>'bail_precedent_id', '')::uuid
  )
  returning id into v_bail;

  for l in select * from jsonb_array_elements(p->'locataires') loop
    if nullif(l->>'id', '') is not null then
      v_loc := (l->>'id')::uuid;
    else
      insert into locataires (prenom, nom, telephone, courriel)
      values (btrim(l->>'prenom'), btrim(l->>'nom'),
              nullif(btrim(l->>'telephone'), ''), nullif(btrim(l->>'courriel'), ''))
      returning id into v_loc;
    end if;
    insert into bail_locataires (bail_id, locataire_id, principal) values (v_bail, v_loc, v_i = 0);
    v_i := v_i + 1;
  end loop;

  for e in select * from jsonb_array_elements(coalesce(p->'extras', '[]'::jsonb)) loop
    insert into bail_extras (bail_id, libelle, montant_cents)
    values (v_bail, btrim(e->>'libelle'), (e->>'montant_cents')::bigint);
  end loop;

  perform generer_echeances(v_bail);

  select * into f from fenetre_avis((p->>'date_debut')::date, nullif(p->>'date_fin', '')::date);
  insert into renouvellements (bail_id, avis_du, avis_au) values (v_bail, f.avis_du, f.avis_au);

  return v_bail;
end $$;

revoke execute on function public.creer_bail(jsonb) from public, anon;
grant  execute on function public.creer_bail(jsonb) to authenticated;
revoke execute on function public.generer_echeances(uuid, date) from public, anon;
grant  execute on function public.generer_echeances(uuid, date) to authenticated;
revoke execute on function public.prolonger_echeances() from public, anon;
grant  execute on function public.prolonger_echeances() to authenticated;


-- ---------------------------------------------------------------------
-- 4. Vues
-- ---------------------------------------------------------------------

-- Soldes par échéance : dû, reçu, chèques en main, solde, jours de retard
create or replace view public.v_soldes
with (security_invoker = true) as
select
  e.id                 as echeance_id,
  e.mois,
  e.loyer_cents,
  e.extras_cents,
  e.montant_du_cents,
  coalesce(sum(p.montant_cents) filter (where p.statut = 'recu'), 0)    as recu_cents,
  coalesce(sum(p.montant_cents) filter (where p.statut = 'en_main'), 0) as en_main_cents,
  e.montant_du_cents - coalesce(sum(p.montant_cents) filter (where p.statut = 'recu'), 0) as solde_cents,
  (e.mois + (b.jour_echeance - 1))::date as date_echeance,
  case
    when e.montant_du_cents - coalesce(sum(p.montant_cents) filter (where p.statut = 'recu'), 0) > 0
         and current_date > (e.mois + (b.jour_echeance - 1))
    then current_date - (e.mois + (b.jour_echeance - 1))
    else 0
  end                  as jours_retard,
  b.id                 as bail_id,
  b.mode_paiement,
  l.id                 as logement_id,
  l.numero             as logement,
  i.id                 as immeuble_id,
  i.nom                as immeuble,
  (select string_agg(lo.prenom || ' ' || lo.nom, ', ' order by bl.principal desc, lo.nom)
     from bail_locataires bl join locataires lo on lo.id = bl.locataire_id
    where bl.bail_id = b.id) as locataires,
  (select lo.telephone
     from bail_locataires bl join locataires lo on lo.id = bl.locataire_id
    where bl.bail_id = b.id and bl.principal) as telephone
from public.echeances e
join public.baux b       on b.id = e.bail_id and b.deleted_at is null
join public.logements l  on l.id = b.logement_id
join public.immeubles i  on i.id = l.immeuble_id
left join public.paiements p on p.echeance_id = e.id and p.deleted_at is null
group by e.id, b.id, l.id, i.id;

-- Baux avec leur état à aujourd'hui (le statut se calcule, il ne se saisit pas)
create or replace view public.v_baux
with (security_invoker = true) as
select
  b.*,
  case
    when b.date_debut > current_date then 'a_venir'
    when coalesce(b.date_depart, b.date_fin) < current_date then 'termine'
    else 'actif'
  end                  as statut,
  l.numero             as logement,
  i.id                 as immeuble_id,
  i.nom                as immeuble,
  (select coalesce(sum(x.montant_cents), 0) from bail_extras x where x.bail_id = b.id) as extras_cents,
  (select string_agg(lo.prenom || ' ' || lo.nom, ', ' order by bl.principal desc, lo.nom)
     from bail_locataires bl join locataires lo on lo.id = bl.locataire_id
    where bl.bail_id = b.id) as locataires,
  r.avis_du, r.avis_au, r.date_avis_envoye, r.reponse
from public.baux b
join public.logements l on l.id = b.logement_id
join public.immeubles i on i.id = l.immeuble_id
left join public.renouvellements r on r.bail_id = b.id
where b.deleted_at is null;


-- ---------------------------------------------------------------------
-- 5. Occupation : pour chaque logement et chaque mois, occupé ou vacant
-- ---------------------------------------------------------------------
create or replace function public.occupation(p_debut date, p_fin date)
returns table (
  mois date, immeuble_id uuid, immeuble text, logement_id uuid, logement text,
  occupe boolean, loyer_perdu_estime_cents bigint
)
language sql stable security invoker set search_path = public as $$
  select
    m::date, i.id, i.nom, l.id, l.numero,
    exists (
      select 1 from baux b
      where b.logement_id = l.id and b.deleted_at is null
        and b.date_debut <= (m + interval '1 month - 1 day')::date
        and coalesce(b.date_depart, b.date_fin, 'infinity'::date) >= m::date
    ),
    case when exists (
      select 1 from baux b
      where b.logement_id = l.id and b.deleted_at is null
        and b.date_debut <= (m + interval '1 month - 1 day')::date
        and coalesce(b.date_depart, b.date_fin, 'infinity'::date) >= m::date
    ) then 0
    else coalesce((
      select b.loyer_cents from baux b
      where b.logement_id = l.id and b.deleted_at is null and b.date_debut <= m::date
      order by b.date_debut desc limit 1
    ), 0) end
  from generate_series(date_trunc('month', p_debut), date_trunc('month', p_fin), interval '1 month') as m
  cross join logements l
  join immeubles i on i.id = l.immeuble_id
  where l.deleted_at is null and l.actif
$$;


-- ---------------------------------------------------------------------
-- 6. Sécurité : tout utilisateur connecté voit et modifie tout
--    (toi, ta conjointe, ton fils). Les inscriptions publiques sont fermées.
-- ---------------------------------------------------------------------
alter table public.locataires      enable row level security;
alter table public.baux            enable row level security;
alter table public.bail_locataires enable row level security;
alter table public.bail_extras     enable row level security;
alter table public.echeances       enable row level security;
alter table public.paiements       enable row level security;
alter table public.renouvellements enable row level security;
alter table public.documents       enable row level security;

create policy acces_authentifie on public.locataires      for all to authenticated using (true) with check (true);
create policy acces_authentifie on public.baux            for all to authenticated using (true) with check (true);
create policy acces_authentifie on public.bail_locataires for all to authenticated using (true) with check (true);
create policy acces_authentifie on public.bail_extras     for all to authenticated using (true) with check (true);
create policy acces_authentifie on public.echeances       for all to authenticated using (true) with check (true);
create policy acces_authentifie on public.paiements       for all to authenticated using (true) with check (true);
create policy acces_authentifie on public.renouvellements for all to authenticated using (true) with check (true);
create policy acces_authentifie on public.documents       for all to authenticated using (true) with check (true);
