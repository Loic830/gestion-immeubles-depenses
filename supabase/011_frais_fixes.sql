-- =====================================================================
--  v0.8.6 – Frais fixes : prêts hypothécaires, assurances, taxes
--
--  À exécuter une fois dans Supabase > SQL Editor (après 010).
--  Un message « already exists » signifie que le fichier a déjà été exécuté.
--
--  Contenu :
--    1. hypotheques         : un prêt (un terme) par ligne, plusieurs par immeuble
--    2. hypotheque_releves  : intérêts selon le relevé annuel du prêteur
--    3. assurances          : une police (un terme d'un an) par ligne, PDF dans documents
--    4. taxes_versements    : chaque versement de taxes foncières ou scolaires
--    5. documents           : accepte la police d'assurance (bail_id devient facultatif)
--    6. RPC payer_frais_fixe / annuler_paiement_frais_fixe : paiement + dépense
--       correspondante dans Dépenses, en une seule transaction
--    7. Sécurité (RLS)
--
--  La ventilation capital / intérêts n'est PAS stockée : l'application la
--  recalcule à partir du prêt (lib/amortissement.ts). Un taux corrigé met
--  donc tout à jour. Prêt à taux fixe canadien : intérêt composé deux fois
--  par année, taux par versement mensuel = (1 + taux/2)^(1/6) − 1.
--
--  Statuts calculés, jamais saisis : un versement est « payé » quand
--  date_paiement est inscrite.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. Prêts hypothécaires
--    Un renouvellement de terme = une nouvelle ligne (l'ancienne reste
--    pour l'historique des intérêts des années passées).
-- ---------------------------------------------------------------------
create table public.hypotheques (
  id                      uuid primary key default gen_random_uuid(),
  immeuble_id             uuid not null references public.immeubles(id),
  nom_pret                text not null default 'Prêt hypothécaire',
  preteur                 text,                         -- ex. Desjardins
  no_pret                 text,
  solde_debut_terme_cents bigint not null check (solde_debut_terme_cents > 0),
  taux                    numeric(6,4) not null check (taux >= 0 and taux < 30),  -- en %, ex. 4.7900
  debut_terme             date not null,
  fin_terme               date not null,
  premier_versement       date not null,                -- date du 1er versement mensuel du terme
  amortissement_mois      int check (amortissement_mois between 1 and 600),       -- restant au début du terme
  versement_cents         bigint not null check (versement_cents > 0),            -- tel qu'indiqué par le prêteur
  notes                   text,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  deleted_at              timestamptz,
  constraint hypotheque_terme_coherent check (fin_terme > debut_terme),
  constraint hypotheque_premier_versement check (premier_versement > debut_terme and premier_versement <= fin_terme)
);
create index hypotheques_immeuble_idx on public.hypotheques (immeuble_id) where deleted_at is null;

comment on column public.hypotheques.taux is 'Taux annuel fixe en pourcentage (4.79 = 4,79 %), composé semestriellement';
comment on column public.hypotheques.amortissement_mois is 'Amortissement restant au début du terme, en mois (sert à vérifier le versement)';

-- ---------------------------------------------------------------------
-- 2. Relevé annuel du prêteur (a priorité sur le calcul)
-- ---------------------------------------------------------------------
create table public.hypotheque_releves (
  id                    uuid primary key default gen_random_uuid(),
  hypotheque_id         uuid not null references public.hypotheques(id),
  annee                 int not null check (annee between 1990 and 2100),
  interets_releve_cents bigint not null check (interets_releve_cents >= 0),
  solde_fin_cents       bigint check (solde_fin_cents >= 0),    -- solde au 31 décembre, facultatif
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  deleted_at            timestamptz
);
create unique index hypotheque_releves_annee_uniq
  on public.hypotheque_releves (hypotheque_id, annee) where deleted_at is null;

-- ---------------------------------------------------------------------
-- 3. Assurances : une ligne par terme de police (renouveler = nouvelle ligne)
-- ---------------------------------------------------------------------
create table public.assurances (
  id                   uuid primary key default gen_random_uuid(),
  immeuble_id          uuid not null references public.immeubles(id),
  assureur             text not null check (btrim(assureur) <> ''),
  no_police            text,
  prime_annuelle_cents bigint not null check (prime_annuelle_cents >= 0),
  date_debut           date not null,
  date_renouvellement  date not null,
  mode_paiement        text not null default 'annuel' check (mode_paiement in ('annuel', 'mensuel')),
  document_id          uuid,                       -- police en PDF (table documents), voir section 5
  date_paiement        date,                       -- prime payée ; vide = à payer
  depense_id           uuid references public.depenses(id),
  notes                text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  deleted_at           timestamptz,
  constraint assurance_terme_coherent check (date_renouvellement > date_debut)
);
create index assurances_immeuble_idx on public.assurances (immeuble_id) where deleted_at is null;

-- ---------------------------------------------------------------------
-- 4. Taxes : chaque versement (foncières) ou le compte (scolaires)
-- ---------------------------------------------------------------------
create table public.taxes_versements (
  id            uuid primary key default gen_random_uuid(),
  immeuble_id   uuid not null references public.immeubles(id),
  type          text not null check (type in ('fonciere', 'scolaire')),
  annee         int not null check (annee between 1990 and 2100),
  echeance      date not null,
  montant_cents bigint not null check (montant_cents > 0),
  date_paiement date,                              -- vide = à payer
  depense_id    uuid references public.depenses(id),
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);
create index taxes_versements_immeuble_idx on public.taxes_versements (immeuble_id, annee) where deleted_at is null;

create trigger trg_hypotheques_maj        before update on public.hypotheques        for each row execute function public.maj_updated_at();
create trigger trg_hypotheque_releves_maj before update on public.hypotheque_releves for each row execute function public.maj_updated_at();
create trigger trg_assurances_maj         before update on public.assurances         for each row execute function public.maj_updated_at();
create trigger trg_taxes_versements_maj   before update on public.taxes_versements   for each row execute function public.maj_updated_at();

-- ---------------------------------------------------------------------
-- 5. Documents : la police d'assurance va dans la même table que les baux
--    (bucket privé « recus », dossier assurances/AAAA/MM/).
-- ---------------------------------------------------------------------
alter type public.type_document add value if not exists 'assurance';

alter table public.documents alter column bail_id drop not null;
-- Un document sans bail doit être une police d'assurance.
-- (comparaison en texte : la nouvelle valeur d'enum ne peut pas servir dans la même transaction)
alter table public.documents add constraint document_bail_ou_assurance
  check (bail_id is not null or type::text = 'assurance');

alter table public.assurances add constraint assurances_document_fk
  foreign key (document_id) references public.documents(id);


-- ---------------------------------------------------------------------
-- 6. Paiement d'un versement de taxes ou d'une prime d'assurance
--
--    payer_frais_fixe(p jsonb) :
--    {
--      "source": "taxe" | "assurance",
--      "id": "uuid",                       -- taxes_versements.id ou assurances.id
--      "date_paiement": "2026-10-18",
--      "creer_depense": true,              -- false = marquer payé seulement
--      "fournisseur_nom": "Ville d'Alma",  -- pour la dépense
--      "mode_paiement_id": "uuid" | null
--    }
--    Crée la dépense (complète, catégorie « Taxes foncières et scolaires »
--    T776 9180 ou « Assurances » 8690, immeuble du versement) avec
--    enregistrer_depense, puis inscrit date_paiement et depense_id.
--    Retour : l'id de la dépense créée (null si creer_depense = false).
-- ---------------------------------------------------------------------
create or replace function public.payer_frais_fixe(p jsonb)
returns uuid
language plpgsql
security invoker
set search_path = public, extensions
as $$
declare
  v_source    text := p->>'source';
  v_id        uuid := (p->>'id')::uuid;
  v_date      date := coalesce(nullif(p->>'date_paiement', '')::date, current_date);
  v_creer     boolean := coalesce((p->>'creer_depense')::boolean, true);
  v_immeuble  uuid;
  v_montant   bigint;
  v_deja      uuid;
  v_code      text;
  v_categorie uuid;
  v_desc      text;
  v_depense   uuid;
begin
  if v_source = 'taxe' then
    select immeuble_id, montant_cents, depense_id,
           case type when 'fonciere' then 'Taxes foncières' else 'Taxes scolaires' end
             || ' ' || annee || ' (échéance ' || to_char(echeance, 'YYYY-MM-DD') || ')'
      into v_immeuble, v_montant, v_deja, v_desc
    from taxes_versements where id = v_id and deleted_at is null;
    v_code := '9180';
  elsif v_source = 'assurance' then
    select immeuble_id, prime_annuelle_cents, depense_id,
           'Assurance ' || assureur || coalesce(' police ' || no_police, '')
             || ' (' || to_char(date_debut, 'YYYY-MM-DD') || ' au ' || to_char(date_renouvellement, 'YYYY-MM-DD') || ')'
      into v_immeuble, v_montant, v_deja, v_desc
    from assurances where id = v_id and deleted_at is null;
    v_code := '8690';
  else
    raise exception 'Source inconnue : %', v_source;
  end if;

  if v_immeuble is null then
    raise exception 'Versement introuvable (déjà retiré ?).';
  end if;

  -- Une dépense déjà liée et toujours active : on ne la crée pas deux fois.
  if v_deja is not null and exists (select 1 from depenses where id = v_deja and deleted_at is null) then
    raise exception 'Ce versement a déjà sa dépense dans l''onglet Dépenses.';
  end if;

  if v_creer and v_montant > 0 then
    select id into v_categorie
    from categories
    where code_fiscal = v_code and parent_id is null and deleted_at is null and actif
    order by est_systeme desc, ordre
    limit 1;
    if v_categorie is null then
      raise exception 'Catégorie de dépense introuvable (ligne T776 %).', v_code;
    end if;

    v_depense := enregistrer_depense(jsonb_build_object(
      'fournisseur_nom', p->>'fournisseur_nom',
      'mode_paiement_id', p->>'mode_paiement_id',
      'date_facture', v_date,
      'total_cents', v_montant,
      'statut', 'complete',
      'notes', 'Inscrite depuis Frais fixes',
      'lignes', jsonb_build_array(jsonb_build_object(
        'immeuble_id', v_immeuble,
        'categorie_id', v_categorie,
        'montant_cents', v_montant,
        'description', v_desc
      ))
    ));
  end if;

  if v_source = 'taxe' then
    update taxes_versements set date_paiement = v_date, depense_id = v_depense where id = v_id;
  else
    update assurances set date_paiement = v_date, depense_id = v_depense where id = v_id;
  end if;

  return v_depense;
end $$;

-- Annuler un paiement (erreur de saisie) : la dépense liée est retirée
-- (suppression douce), le versement redevient « à payer ».
create or replace function public.annuler_paiement_frais_fixe(p_source text, p_id uuid)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_depense uuid;
begin
  if p_source = 'taxe' then
    select depense_id into v_depense from taxes_versements where id = p_id;
    update taxes_versements set date_paiement = null, depense_id = null where id = p_id;
  elsif p_source = 'assurance' then
    select depense_id into v_depense from assurances where id = p_id;
    update assurances set date_paiement = null, depense_id = null where id = p_id;
  else
    raise exception 'Source inconnue : %', p_source;
  end if;

  if v_depense is not null then
    update depenses set deleted_at = now() where id = v_depense and deleted_at is null;
  end if;
end $$;

revoke execute on function public.payer_frais_fixe(jsonb) from public, anon;
grant  execute on function public.payer_frais_fixe(jsonb) to authenticated;
revoke execute on function public.annuler_paiement_frais_fixe(text, uuid) from public, anon;
grant  execute on function public.annuler_paiement_frais_fixe(text, uuid) to authenticated;


-- ---------------------------------------------------------------------
-- 7. Sécurité (RLS) : tout utilisateur connecté voit tout
-- ---------------------------------------------------------------------
alter table public.hypotheques        enable row level security;
alter table public.hypotheque_releves enable row level security;
alter table public.assurances         enable row level security;
alter table public.taxes_versements   enable row level security;
create policy acces_authentifie on public.hypotheques        for all to authenticated using (true) with check (true);
create policy acces_authentifie on public.hypotheque_releves for all to authenticated using (true) with check (true);
create policy acces_authentifie on public.assurances         for all to authenticated using (true) with check (true);
create policy acces_authentifie on public.taxes_versements   for all to authenticated using (true) with check (true);

-- Fin du script.
