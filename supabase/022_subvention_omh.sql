-- =====================================================================
--  v0.9.12 – Loyer avec subvention de l'OMH (supplément au loyer)
--
--  À exécuter une fois dans Supabase > SQL Editor (après 021).
--  Le script peut être exécuté plusieurs fois sans effet de bord.
--
--  Un logement du Programme de supplément au loyer (PSL) : le loyer
--  reconnu (ex. 638 $) est payé en deux parts chaque mois, la part du
--  locataire (450 $) et la part de l'OMH (supplément au loyer, 188 $).
--
--  1. baux.part_omh_cents      : part de l'OMH du bail (vide = pas de subvention)
--     echeances.omh_cents      : part de l'OMH de chaque mois (copiée du bail
--                                à la création du mois, par un déclencheur)
--     paiements.payeur         : 'locataire' (par défaut) ou 'omh'
--     mode_loyer 'depot_direct': mode des paiements de l'OMH
--  2. v_soldes : mêmes colonnes, plus omh_cents, recu_omh_cents,
--     solde_locataire_cents, solde_omh_cents. Un mois est en retard si
--     l'une des deux parts n'est pas payée.
--  3. v_baux : même vue qu'en 018, plus part_omh_cents à la fin.
--  4. marquer_mois_payes : un paiement par part (locataire et OMH).
--  5. creer_bail accepte « part_omh_cents ».
--  6. renouveler_bail et ceder_bail : un paramètre de plus, p_part_omh_cents
--     (remplacent les versions de 019 et 020).
--  7. modifier_bail_omh(p) : modifier_bail (012) + la part de l'OMH.
--     changer_loyer_omh(…) : nouveau loyer et/ou nouvelle part de l'OMH
--     à partir d'un mois.
--  8. repartir_depot : « payeur » (un dépôt du locataire ou de l'OMH).
--  9. alertes_du_jour : le retard du locataire et celui de l'OMH sont
--     deux alertes séparées (on ne demande pas au locataire la part de l'OMH).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Colonnes
-- ---------------------------------------------------------------------
-- (pas utilisée ailleurs dans ce script : une valeur d'enum ajoutée
--  n'est utilisable qu'après la fin de la transaction ; les fonctions
--  plus bas ne la lisent qu'au moment de s'exécuter)
alter type public.mode_loyer add value if not exists 'depot_direct';

alter table public.baux add column if not exists part_omh_cents bigint;
alter table public.baux drop constraint if exists baux_part_omh_check;
alter table public.baux add constraint baux_part_omh_check
  check (part_omh_cents is null or part_omh_cents > 0);

alter table public.echeances add column if not exists omh_cents bigint not null default 0;
alter table public.echeances drop constraint if exists echeances_omh_check;
alter table public.echeances add constraint echeances_omh_check check (omh_cents >= 0);

alter table public.paiements add column if not exists payeur text not null default 'locataire';
alter table public.paiements drop constraint if exists paiements_payeur_check;
alter table public.paiements add constraint paiements_payeur_check
  check (payeur in ('locataire', 'omh') and (payeur = 'locataire' or mode::text <> 'credit'));

-- Chaque nouveau mois reçoit la part de l'OMH du bail (generer_echeances,
-- modifier_bail, annuler_fin_bail… n'ont pas à changer)
create or replace function public.echeance_part_omh()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.omh_cents = 0 then
    select coalesce(b.part_omh_cents, 0) into new.omh_cents from baux b where b.id = new.bail_id;
    new.omh_cents := coalesce(new.omh_cents, 0);
  end if;
  return new;
end $$;

drop trigger if exists trg_echeances_omh on public.echeances;
create trigger trg_echeances_omh before insert on public.echeances
  for each row execute function public.echeance_part_omh();


-- ---------------------------------------------------------------------
-- 2. v_soldes : colonnes de 004 dans le même ordre, parts à la fin
-- ---------------------------------------------------------------------
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
    when greatest(e.montant_du_cents - e.omh_cents
                  - coalesce(sum(p.montant_cents) filter (where p.statut = 'recu' and p.payeur = 'locataire'), 0), 0)
       + greatest(e.omh_cents
                  - coalesce(sum(p.montant_cents) filter (where p.statut = 'recu' and p.payeur = 'omh'), 0), 0) > 0
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
    where bl.bail_id = b.id and bl.principal) as telephone,
  -- v0.9.12 : part de l'OMH et solde de chaque part
  e.omh_cents,
  coalesce(sum(p.montant_cents) filter (where p.statut = 'recu' and p.payeur = 'omh'), 0) as recu_omh_cents,
  e.montant_du_cents - e.omh_cents
    - coalesce(sum(p.montant_cents) filter (where p.statut = 'recu' and p.payeur = 'locataire'), 0) as solde_locataire_cents,
  e.omh_cents
    - coalesce(sum(p.montant_cents) filter (where p.statut = 'recu' and p.payeur = 'omh'), 0) as solde_omh_cents
from public.echeances e
join public.baux b       on b.id = e.bail_id and b.deleted_at is null
join public.logements l  on l.id = b.logement_id
join public.immeubles i  on i.id = l.immeuble_id
left join public.paiements p on p.echeance_id = e.id and p.deleted_at is null
group by e.id, b.id, l.id, i.id;


-- ---------------------------------------------------------------------
-- 3. v_baux : même vue qu'en 018, part_omh_cents à la fin
-- ---------------------------------------------------------------------
create or replace view public.v_baux
with (security_invoker = true) as
select
  b.id, b.logement_id, b.date_debut, b.date_fin, b.date_depart, b.loyer_cents,
  b.jour_echeance, b.mode_paiement, b.inclusions, b.bail_precedent_id, b.notes,
  b.created_at, b.updated_at, b.deleted_at,
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
  r.avis_du, r.avis_au, r.date_avis_envoye, r.reponse,
  b.origine,
  b.part_omh_cents
from public.baux b
join public.logements l on l.id = b.logement_id
join public.immeubles i on i.id = l.immeuble_id
left join public.renouvellements r on r.bail_id = b.id
where b.deleted_at is null;


-- ---------------------------------------------------------------------
-- 4. Marquer des mois payés (015) : un paiement par part
--    La part de l'OMH est inscrite en dépôt direct, payeur « omh ».
-- ---------------------------------------------------------------------
create or replace function public.marquer_mois_payes(p_bail uuid, p_mois jsonb)
returns int
language plpgsql security invoker set search_path = public as $$
declare
  b    baux%rowtype;
  r    record;
  v_nb int := 0;
begin
  select * into b from baux where id = p_bail and deleted_at is null;
  if not found then raise exception 'Bail introuvable.'; end if;

  for r in
    select s.echeance_id, s.solde_locataire_cents, s.solde_omh_cents, s.date_echeance
    from v_soldes s
    where s.bail_id = p_bail
      and s.mois in (select date_trunc('month', (x #>> '{}')::date)::date
                     from jsonb_array_elements(p_mois) x)
      and s.date_echeance <= current_date
      and (s.solde_locataire_cents > 0 or s.solde_omh_cents > 0)
  loop
    if r.solde_locataire_cents > 0 then
      insert into paiements (echeance_id, montant_cents, mode, statut, date_recue, notes, payeur)
      values (r.echeance_id, r.solde_locataire_cents, b.mode_paiement, 'recu', r.date_echeance,
              'Marqué payé à la création du bail', 'locataire');
    end if;
    if r.solde_omh_cents > 0 then
      insert into paiements (echeance_id, montant_cents, mode, statut, date_recue, notes, payeur)
      values (r.echeance_id, r.solde_omh_cents, 'depot_direct'::text::mode_loyer, 'recu', r.date_echeance,
              'Marqué payé à la création du bail', 'omh');
    end if;
    v_nb := v_nb + 1;
  end loop;
  return v_nb;
end $$;

revoke execute on function public.marquer_mois_payes(uuid, jsonb) from public, anon;
grant  execute on function public.marquer_mois_payes(uuid, jsonb) to authenticated;


-- ---------------------------------------------------------------------
-- 5. creer_bail : même fonction qu'en 015, plus la part de l'OMH
--    p = { …champs de 015…, "part_omh_cents": 18800 | null }
-- ---------------------------------------------------------------------
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
  if coalesce(nullif(p->>'part_omh_cents', '')::bigint, 0) < 0 then
    raise exception 'La part de l''OMH doit être un montant positif.';
  end if;
  if coalesce(nullif(p->>'part_omh_cents', '')::bigint, 0) > (p->>'loyer_cents')::bigint then
    raise exception 'La part de l''OMH dépasse le loyer.';
  end if;

  insert into baux (logement_id, date_debut, date_fin, loyer_cents, jour_echeance,
                    mode_paiement, inclusions, notes, bail_precedent_id, part_omh_cents)
  values (
    (p->>'logement_id')::uuid,
    (p->>'date_debut')::date,
    nullif(p->>'date_fin', '')::date,
    (p->>'loyer_cents')::bigint,
    coalesce((p->>'jour_echeance')::int, 1),
    coalesce(nullif(p->>'mode_paiement', '')::mode_loyer, 'interac'),
    nullif(btrim(p->>'inclusions'), ''),
    nullif(btrim(p->>'notes'), ''),
    nullif(p->>'bail_precedent_id', '')::uuid,
    nullif(nullif(p->>'part_omh_cents', '')::bigint, 0)   -- v0.9.12 : avant les mois (déclencheur)
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
  -- v0.9.1 : « Tous les mois passés sont payés » (mois exclus déjà retirés par l'app)
  perform marquer_mois_payes(v_bail, coalesce(p->'mois_payes', '[]'::jsonb));

  select * into f from fenetre_avis((p->>'date_debut')::date, nullif(p->>'date_fin', '')::date);
  insert into renouvellements (bail_id, avis_du, avis_au) values (v_bail, f.avis_du, f.avis_au);

  return v_bail;
end $$;

revoke execute on function public.creer_bail(jsonb) from public, anon;
grant  execute on function public.creer_bail(jsonb) to authenticated;


-- ---------------------------------------------------------------------
-- 6a. Renouveler un bail (019) : plus la part de l'OMH du nouveau bail
-- ---------------------------------------------------------------------
drop function if exists public.renouveler_bail(uuid, date, date, bigint);
drop function if exists public.renouveler_bail(uuid, date, date, bigint, jsonb);

create or replace function public.renouveler_bail(
  p_bail uuid, p_date_debut date, p_date_fin date, p_loyer_cents bigint,
  p_mois_payes jsonb default '[]'::jsonb,
  p_part_omh_cents bigint default null      -- v0.9.12 : part de l'OMH du nouveau bail (vide = sans subvention)
)
returns uuid
language plpgsql security invoker set search_path = public as $$
declare
  b      baux%rowtype;
  v_loc  jsonb;
  v_ext  jsonb;
  v_bail uuid;
begin
  select * into b from baux where id = p_bail and deleted_at is null for update;
  if not found then raise exception 'Bail introuvable.'; end if;
  if b.date_depart is not null then
    raise exception 'Ce bail a une date de départ : entre plutôt le nouveau bail.';
  end if;
  if p_date_debut is null then raise exception 'Entre la date de début du nouveau bail.'; end if;
  if p_date_fin is not null and p_date_fin < p_date_debut then
    raise exception 'La fin du nouveau bail doit être après son début.';
  end if;
  if p_loyer_cents is null or p_loyer_cents < 0 then raise exception 'Entre un loyer valide.'; end if;
  if b.date_fin is null or p_date_debut <= b.date_fin then
    raise exception 'Le nouveau bail doit commencer après la fin du bail actuel (%).',
      coalesce(date_fr(b.date_fin), 'durée indéterminée');
  end if;
  if exists (select 1 from baux n where n.bail_precedent_id = p_bail and n.deleted_at is null) then
    raise exception 'Ce bail est déjà renouvelé (ou cédé) : ouvre le bail qui le suit.';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('id', bl.locataire_id) order by bl.principal desc), '[]'::jsonb)
    into v_loc
    from bail_locataires bl where bl.bail_id = p_bail;

  select coalesce(jsonb_agg(jsonb_build_object('libelle', x.libelle, 'montant_cents', x.montant_cents)), '[]'::jsonb)
    into v_ext
    from bail_extras x where x.bail_id = p_bail;

  begin
    v_bail := creer_bail(jsonb_build_object(
      'logement_id', b.logement_id,
      'date_debut', p_date_debut,
      'date_fin', p_date_fin,
      'loyer_cents', p_loyer_cents,
      'jour_echeance', b.jour_echeance,
      'mode_paiement', b.mode_paiement,
      'inclusions', b.inclusions,
      'notes', 'Renouvellement du bail du ' || date_fr(b.date_debut) || ' au ' || date_fr(b.date_fin),
      'bail_precedent_id', p_bail,
      'locataires', v_loc,
      'extras', v_ext,
      'mois_payes', coalesce(p_mois_payes, '[]'::jsonb),
      'part_omh_cents', p_part_omh_cents
    ));
  exception when exclusion_violation then
    raise exception 'Un autre bail occupe déjà ce logement pendant ces dates. Raccourcis la durée.';
  end;

  update baux set origine = 'renouvellement' where id = v_bail;

  update renouvellements set reponse = 'acceptee', updated_at = now()
   where bail_id = p_bail and reponse = 'en_attente';

  return v_bail;
end $$;

revoke execute on function public.renouveler_bail(uuid, date, date, bigint, jsonb, bigint) from public, anon;
grant  execute on function public.renouveler_bail(uuid, date, date, bigint, jsonb, bigint) to authenticated;

-- ---------------------------------------------------------------------
-- 6b. Céder un bail (020) : plus la part de l'OMH du nouveau locataire
--     (la subvention suit le ménage : elle n'est pas copiée de l'ancien bail)
-- ---------------------------------------------------------------------
drop function if exists public.ceder_bail(uuid, date, jsonb);
drop function if exists public.ceder_bail(uuid, date, jsonb, jsonb);

create or replace function public.ceder_bail(
  p_bail uuid, p_date date, p_locataires jsonb,
  p_mois_payes jsonb default '[]'::jsonb,
  p_part_omh_cents bigint default null      -- v0.9.12 : part de l'OMH du cessionnaire (vide = sans subvention)
)
returns uuid
language plpgsql security invoker set search_path = public as $$
declare
  b       baux%rowtype;
  v_loyer bigint;
  v_ext   jsonb;
  v_anc   text;
  v_bail  uuid;
  c       record;
begin
  select * into b from baux where id = p_bail and deleted_at is null for update;
  if not found then raise exception 'Bail introuvable.'; end if;
  if b.date_depart is not null then
    raise exception 'Ce bail a déjà une date de départ (%). Annule cette fin de bail sur sa fiche, puis recommence.',
      date_fr(b.date_depart);
  end if;
  if p_date is null then raise exception 'Entre la date de la cession.'; end if;
  if extract(day from p_date) <> 1 then
    raise exception 'La cession prend effet le 1er d''un mois.';
  end if;
  if p_date <= b.date_debut then
    raise exception 'La cession doit prendre effet après le début du bail (%).', date_fr(b.date_debut);
  end if;
  if b.date_fin is not null and p_date > b.date_fin then
    raise exception 'Le bail se termine le % : la cession doit prendre effet avant.', date_fr(b.date_fin);
  end if;
  if exists (select 1 from baux n where n.bail_precedent_id = p_bail and n.deleted_at is null) then
    raise exception 'Ce bail est déjà renouvelé (ou cédé). Fais la cession sur le bail qui le suit, ou supprime d''abord ce bail suivant.';
  end if;
  if jsonb_array_length(coalesce(p_locataires, '[]'::jsonb)) = 0 then
    raise exception 'Entre le nouveau locataire (cessionnaire).';
  end if;
  if exists (select 1 from jsonb_array_elements(p_locataires) l
              where nullif(l->>'id', '') is null
                and (coalesce(btrim(l->>'prenom'), '') = '' or coalesce(btrim(l->>'nom'), '') = '')) then
    raise exception 'Entre le prénom et le nom de chaque nouveau locataire.';
  end if;

  -- Loyer au moment de la cession (hausses comprises), sinon le loyer du bail
  select e.loyer_cents into v_loyer from echeances e where e.bail_id = p_bail and e.mois = p_date;
  if v_loyer is null then
    select c2.nouveau_loyer_cents into v_loyer from changements_loyer c2
     where c2.bail_id = p_bail and c2.date_effet <= p_date
     order by c2.date_effet desc, c2.created_at desc limit 1;
  end if;
  v_loyer := coalesce(v_loyer, b.loyer_cents);

  select coalesce(jsonb_agg(jsonb_build_object('libelle', x.libelle, 'montant_cents', x.montant_cents)), '[]'::jsonb)
    into v_ext
    from bail_extras x where x.bail_id = p_bail;

  select string_agg(lo.prenom || ' ' || lo.nom, ', ' order by bl.principal desc, lo.nom)
    into v_anc
    from bail_locataires bl join locataires lo on lo.id = bl.locataire_id
   where bl.bail_id = p_bail;

  -- Mois après la cession marqués payés automatiquement : pas de vrais paiements
  update paiements p set deleted_at = now(), updated_at = now()
    from echeances e
   where p.echeance_id = e.id and e.bail_id = p_bail and e.mois >= p_date
     and p.deleted_at is null and p.notes = 'Marqué payé à la création du bail';

  perform terminer_bail(p_bail, p_date - 1, 0,
    'Bail cédé à compter du ' || date_fr(p_date));

  begin
    v_bail := creer_bail(jsonb_build_object(
      'logement_id', b.logement_id,
      'date_debut', p_date,
      'date_fin', b.date_fin,
      'loyer_cents', v_loyer,
      'jour_echeance', b.jour_echeance,
      'mode_paiement', b.mode_paiement,
      'inclusions', b.inclusions,
      'notes', 'Cession du bail de ' || coalesce(v_anc, 'l''ancien locataire') ||
               ' (bail du ' || date_fr(b.date_debut) || coalesce(' au ' || date_fr(b.date_fin), '') ||
               '), à compter du ' || date_fr(p_date),
      'bail_precedent_id', p_bail,
      'locataires', p_locataires,
      'extras', v_ext,
      'part_omh_cents', p_part_omh_cents
    ));
  exception when exclusion_violation then
    raise exception 'Un autre bail occupe déjà ce logement pendant ces dates.';
  end;

  update baux set origine = 'cession' where id = v_bail;

  -- Hausses déjà prévues après la cession : elles suivent le bail
  for c in select * from changements_loyer
            where bail_id = p_bail and date_effet > p_date
            order by date_effet, created_at loop
    if exists (select 1 from echeances e where e.bail_id = v_bail and e.mois = c.date_effet
                and e.loyer_cents <> c.nouveau_loyer_cents) then
      perform changer_loyer(v_bail, c.date_effet, c.nouveau_loyer_cents, c.raison);
    end if;
  end loop;

  -- Mois passés déjà payés par le nouveau locataire (après les hausses : bon montant)
  perform marquer_mois_payes(v_bail, coalesce(p_mois_payes, '[]'::jsonb));

  return v_bail;
end $$;

revoke execute on function public.ceder_bail(uuid, date, jsonb, jsonb, bigint) from public, anon;
grant  execute on function public.ceder_bail(uuid, date, jsonb, jsonb, bigint) to authenticated;


-- ---------------------------------------------------------------------
-- 7a. Part de l'OMH d'un bail à partir d'un mois (aide interne)
--     p_omh vide ou 0 = plus de subvention. Les paiements déjà inscrits
--     ne changent pas. Refusé si la part dépasse le dû d'un mois touché.
-- ---------------------------------------------------------------------
create or replace function public.definir_part_omh(p_bail uuid, p_omh bigint, p_depuis date)
returns int
language plpgsql security invoker set search_path = public as $$
declare
  v_omh  bigint := coalesce(p_omh, 0);
  v_nb   int;
  r      record;
begin
  if v_omh < 0 then raise exception 'La part de l''OMH doit être un montant positif.'; end if;
  update baux set part_omh_cents = nullif(v_omh, 0), updated_at = now() where id = p_bail;
  update echeances set omh_cents = v_omh, updated_at = now()
   where bail_id = p_bail and mois >= date_trunc('month', p_depuis)::date and omh_cents <> v_omh;
  get diagnostics v_nb = row_count;
  select mois, montant_du_cents into r from echeances
   where bail_id = p_bail and omh_cents > montant_du_cents order by mois limit 1;
  if found then
    raise exception 'La part de l''OMH (%) dépasse le loyer dû de % (%).',
      cents_fr(v_omh), to_char(r.mois, 'YYYY-MM'), cents_fr(r.montant_du_cents);
  end if;
  return v_nb;
end $$;

revoke execute on function public.definir_part_omh(uuid, bigint, date) from public, anon;
grant  execute on function public.definir_part_omh(uuid, bigint, date) to authenticated;

-- ---------------------------------------------------------------------
-- 7b. Modifier le bail (012) avec la part de l'OMH
--     p = { …champs de modifier_bail…, "part_omh_cents": 18800 | null }
--     Si la part change, elle s'applique aux mois qui avaient la part
--     actuelle (une part changée en cours de bail avec « Modifier le prix
--     du loyer » reste pour les mois d'avant).
-- ---------------------------------------------------------------------
create or replace function public.modifier_bail_omh(p jsonb)
returns uuid
language plpgsql security invoker set search_path = public as $$
declare
  v_bail    uuid := (p->>'id')::uuid;
  v_ancien  bigint;
  v_nouveau bigint := coalesce(nullif(p->>'part_omh_cents', '')::bigint, 0);
  r         record;
begin
  select coalesce(part_omh_cents, 0) into v_ancien from baux where id = v_bail and deleted_at is null;
  if not found then raise exception 'Bail introuvable.'; end if;
  if v_nouveau < 0 then raise exception 'La part de l''OMH doit être un montant positif.'; end if;

  perform modifier_bail(p);

  if v_nouveau <> v_ancien then
    update baux set part_omh_cents = nullif(v_nouveau, 0), updated_at = now() where id = v_bail;
    update echeances set omh_cents = v_nouveau, updated_at = now()
     where bail_id = v_bail and omh_cents = v_ancien;
  end if;
  select mois, montant_du_cents into r from echeances
   where bail_id = v_bail and omh_cents > montant_du_cents order by mois limit 1;
  if found then
    raise exception 'La part de l''OMH (%) dépasse le loyer dû de % (%).',
      cents_fr(v_nouveau), to_char(r.mois, 'YYYY-MM'), cents_fr(r.montant_du_cents);
  end if;
  return v_bail;
end $$;

revoke execute on function public.modifier_bail_omh(jsonb) from public, anon;
grant  execute on function public.modifier_bail_omh(jsonb) to authenticated;

-- ---------------------------------------------------------------------
-- 7c. Modifier le prix du loyer (005) avec la part de l'OMH
--     Le loyer reconnu et la part de l'OMH changent à partir du même mois.
--     Seule la part de l'OMH peut changer (revenu du ménage revu par l'OMH).
-- ---------------------------------------------------------------------
create or replace function public.changer_loyer_omh(
  p_bail uuid, p_date_effet date, p_nouveau_cents bigint, p_omh_cents bigint, p_raison text default null
)
returns int
language plpgsql security invoker set search_path = public as $$
declare
  b        baux%rowtype;
  v_mois   date := date_trunc('month', p_date_effet)::date;
  v_loyer  bigint;
  v_omh    bigint;
  v_nb     int := 0;
begin
  select * into b from baux where id = p_bail and deleted_at is null;
  if not found then raise exception 'Bail introuvable.'; end if;
  select loyer_cents, omh_cents into v_loyer, v_omh from echeances where bail_id = p_bail and mois = v_mois;
  if not found then raise exception 'Ce mois n''est pas dans le bail.'; end if;

  if p_nouveau_cents is distinct from v_loyer then
    v_nb := changer_loyer(p_bail, v_mois, p_nouveau_cents, p_raison);
  end if;
  if coalesce(p_omh_cents, 0) <> v_omh then
    v_nb := greatest(v_nb, definir_part_omh(p_bail, p_omh_cents, v_mois));
  elsif v_nb > 0 then
    -- Le loyer a changé, la part de l'OMH reste : on vérifie qu'elle ne dépasse pas
    perform definir_part_omh(p_bail, v_omh, v_mois);
  end if;
  if p_nouveau_cents is not distinct from v_loyer and coalesce(p_omh_cents, 0) = v_omh then
    raise exception 'Le loyer et la part de l''OMH sont déjà à ces montants pour ce mois.';
  end if;
  return v_nb;
end $$;

revoke execute on function public.changer_loyer_omh(uuid, date, bigint, bigint, text) from public, anon;
grant  execute on function public.changer_loyer_omh(uuid, date, bigint, bigint, text) to authenticated;


-- ---------------------------------------------------------------------
-- 8. Répartir un dépôt (021) : un dépôt du locataire ou de l'OMH
--    p = { …champs de 021…, "payeur": "locataire" | "omh" }
--    Chaque mois reçoit la part qui reste à payer par ce payeur ; seuls
--    les paiements de ce payeur sont remplacés.
-- ---------------------------------------------------------------------
create or replace function public.repartir_depot(p jsonb)
returns uuid
language plpgsql security invoker set search_path = public as $$
declare
  v_bail    uuid := (p->>'bail_id')::uuid;
  v_total   bigint := (p->>'montant_cents')::bigint;
  v_reste   bigint;
  v_depot   uuid := gen_random_uuid();
  v_ancien  uuid;
  v_ids     uuid[];
  v_nb      int;
  v_i       int := 0;
  v_part    bigint;
  v_payeur  text := coalesce(nullif(p->>'payeur', ''), 'locataire');   -- v0.9.12
  r         record;
begin
  if v_payeur not in ('locataire', 'omh') then raise exception 'Payeur inconnu.'; end if;
  if v_total is null or v_total <= 0 then raise exception 'Entre le montant du dépôt.'; end if;
  if nullif(p->>'date_recue', '') is null then raise exception 'Entre la date du dépôt.'; end if;
  if not exists (select 1 from baux where id = v_bail and deleted_at is null) then
    raise exception 'Bail introuvable.';
  end if;

  select array_agg(distinct (x #>> '{}')::uuid) into v_ids
  from jsonb_array_elements(coalesce(p->'echeance_ids', '[]'::jsonb)) x;
  v_nb := coalesce(array_length(v_ids, 1), 0);
  if v_nb = 0 then raise exception 'Choisis au moins un mois.'; end if;
  if (select count(*) from echeances where id = any(v_ids) and bail_id = v_bail) <> v_nb then
    raise exception 'Un des mois choisis n''appartient pas à ce bail.';
  end if;

  -- Le paiement qu'on corrige, et tout son ancien dépôt s'il y en avait un
  if nullif(p->>'paiement_id', '') is not null then
    select depot_id into v_ancien from paiements where id = (p->>'paiement_id')::uuid;
    update paiements set deleted_at = now()
     where deleted_at is null
       and (id = (p->>'paiement_id')::uuid or (v_ancien is not null and depot_id = v_ancien));
  end if;

  -- Les paiements déjà inscrits sur ces mois sont remplacés (les crédits restent)
  update paiements set deleted_at = now()
   where echeance_id = any(v_ids) and deleted_at is null and mode <> 'credit' and payeur = v_payeur;

  v_reste := v_total;
  for r in
    select e.id, e.mois,
           case when v_payeur = 'omh' then e.omh_cents
                else e.montant_du_cents - e.omh_cents
                   - coalesce((select sum(c.montant_cents) from paiements c
                                where c.echeance_id = e.id and c.deleted_at is null
                                  and c.mode = 'credit' and c.statut = 'recu'), 0) end as du
    from echeances e
    where e.id = any(v_ids)
    order by e.mois
  loop
    v_i := v_i + 1;
    v_part := case when v_i = v_nb then v_reste else least(v_reste, greatest(r.du, 0)) end;
    if v_part > 0 then
      insert into paiements (echeance_id, montant_cents, mode, statut, date_recue, reference, notes, depot_id, payeur)
      values (r.id, v_part,
              coalesce(nullif(p->>'mode', '')::mode_loyer, 'interac'), 'recu',
              (p->>'date_recue')::date,
              nullif(btrim(p->>'reference'), ''),
              nullif(btrim(p->>'notes'), ''),
              v_depot, v_payeur);
      v_reste := v_reste - v_part;
    end if;
  end loop;

  return v_depot;
end $$;

revoke execute on function public.repartir_depot(jsonb) from public, anon;
grant  execute on function public.repartir_depot(jsonb) to authenticated;


-- ---------------------------------------------------------------------
-- 9. Alertes du jour (016) : retard du locataire et retard de l'OMH séparés
-- ---------------------------------------------------------------------
create or replace function public.alertes_du_jour()
returns table (type text, cible_id uuid, cle text, titre text, description text)
language sql stable security definer set search_path = public as $$
  with auj as (select (now() at time zone 'America/Toronto')::date as d)

  -- Fin de terme hypothécaire (prêt pas encore renouvelé)
  select 'hypotheque_renouvellement', h.immeuble_id,
         'hypo:' || h.id || ':' || p.seuil,
         'Renouveler l''hypothèque · ' || i.nom,
         'Le terme du prêt « ' || h.nom_pret || ' »' || coalesce(' (' || h.preteur || ')', '') ||
         ' se termine le ' || date_fr(h.fin_terme) || ', ' || dans_jours(h.fin_terme - auj.d) ||
         '. Communiquez avec le prêteur pour comparer les taux, puis entrez le nouveau terme dans Frais fixes > Renouveler le terme.'
    from hypotheques h
    join immeubles i on i.id = h.immeuble_id and i.actif and i.deleted_at is null
    cross join auj
    cross join lateral (select min(s) as seuil from unnest(array[30, 60, 120]) s
                         where s >= h.fin_terme - auj.d) p
   where h.deleted_at is null
     and h.fin_terme >= auj.d and p.seuil is not null
     and not exists (select 1 from hypotheques n
                      where n.deleted_at is null and n.id <> h.id and n.immeuble_id = h.immeuble_id
                        and n.nom_pret = h.nom_pret and n.debut_terme >= h.fin_terme)

  union all
  -- Renouvellement de l'assurance (police pas encore renouvelée)
  select 'assurance_renouvellement', a.immeuble_id,
         'assu:' || a.id || ':' || p.seuil,
         'Renouveler l''assurance · ' || i.nom,
         'La police ' || a.assureur || coalesce(' no ' || a.no_police, '') || ' arrive à échéance le ' ||
         date_fr(a.date_renouvellement) || ', ' || dans_jours(a.date_renouvellement - auj.d) ||
         '. Vérifiez la nouvelle prime, puis touchez Renouveler dans Frais fixes > Assurances.'
    from assurances a
    join immeubles i on i.id = a.immeuble_id and i.actif and i.deleted_at is null
    cross join auj
    cross join lateral (select min(s) as seuil from unnest(array[7, 30]) s
                         where s >= a.date_renouvellement - auj.d) p
   where a.deleted_at is null
     and a.date_renouvellement >= auj.d and p.seuil is not null
     and not exists (select 1 from assurances n
                      where n.deleted_at is null and n.id <> a.id and n.immeuble_id = a.immeuble_id
                        and n.date_debut >= a.date_renouvellement)

  union all
  -- Versement de taxes à payer (14 jours, 3 jours) ou en retard
  select 'taxes_echeance', t.immeuble_id,
         'taxe:' || t.id || ':' || coalesce(p.seuil::text, 'retard'),
         case when t.echeance < auj.d then 'Taxes en retard · ' else 'Payer les taxes · ' end || i.nom,
         'Versement de taxes ' || case t.type when 'fonciere' then 'foncières' else 'scolaires' end ||
         ' ' || t.annee || ' de ' || cents_fr(t.montant_cents) ||
         case when t.echeance < auj.d then ' : l''échéance du ' || date_fr(t.echeance) || ' est passée'
              else ' dû le ' || date_fr(t.echeance) || ', ' || dans_jours(t.echeance - auj.d) end ||
         '. Payez-le, puis touchez Payé dans Frais fixes > Taxes.'
    from taxes_versements t
    join immeubles i on i.id = t.immeuble_id and i.actif and i.deleted_at is null
    cross join auj
    cross join lateral (select min(s) as seuil from unnest(array[3, 14]) s
                         where s >= t.echeance - auj.d and t.echeance >= auj.d) p
   where t.deleted_at is null and t.date_paiement is null
     and (t.echeance < auj.d or p.seuil is not null)

  union all
  -- Avis de renouvellement de bail (TAL) : fenêtre ouverte, puis 14 jours avant sa fermeture
  select 'avis_tal', b.immeuble_id,
         'tal:' || b.id || ':' || case when b.avis_au - auj.d <= 14 then 'rappel' else 'ouverture' end,
         'Envoyer l''avis de renouvellement · ' || b.immeuble || ' ' || b.logement,
         'Le bail de ' || coalesce(b.locataires, 'ce logement') || ' se termine le ' || date_fr(b.date_fin) ||
         '. L''avis de modification (hausse de loyer ou autre changement) doit être envoyé au plus tard le ' ||
         date_fr(b.avis_au) || ', ' || dans_jours(b.avis_au - auj.d) ||
         '. Préparez-le, puis inscrivez la date d''envoi sur la fiche du bail (onglet Baux).'
    from v_baux b
    join immeubles i on i.id = b.immeuble_id and i.actif and i.deleted_at is null
    cross join auj
   where b.avis_du is not null and b.date_depart is null and b.date_avis_envoye is null
     and b.avis_du <= auj.d and b.avis_au >= auj.d
     and not exists (select 1 from baux n where n.bail_precedent_id = b.id and n.deleted_at is null)  -- v0.9.3 : déjà renouvelé

  union all
  -- Loyer impayé depuis 5 jours (une seule alerte par mois de loyer). Les retards de plus
  -- de 35 jours ne déclenchent rien : ce ne sont pas des nouvelles (ex. vieux baux entrés après coup).
  -- v0.9.12 : la part du locataire seulement (la part de l'OMH a sa propre alerte, plus bas)
  select 'loyer_retard', s.immeuble_id,
         'loyer:' || s.echeance_id,
         'Loyer en retard · ' || s.immeuble || ' ' || s.logement,
         'Le loyer ' || de_mois_fr(s.mois) || ' n''est pas reçu (reste ' || cents_fr(s.solde_locataire_cents::bigint) || ', ' ||
         s.jours_retard || ' jours de retard). Appelez ' || coalesce(s.locataires, 'le locataire') ||
         ' ou inscrivez le paiement dans l''onglet Loyers.'
    from v_soldes s
    join immeubles i on i.id = s.immeuble_id and i.actif and i.deleted_at is null
   where s.solde_locataire_cents > 0 and s.jours_retard between 5 and 35

  union all
  -- Supplément au loyer de l'OMH pas reçu : on n'appelle pas le locataire, on vérifie avec l'OMH
  select 'loyer_retard', s.immeuble_id,
         'omh:' || s.echeance_id,
         'Supplément OMH en retard · ' || s.immeuble || ' ' || s.logement,
         'La part de l''OMH ' || de_mois_fr(s.mois) || ' (supplément au loyer de ' || coalesce(s.locataires, 'ce logement') ||
         ') n''est pas reçue (reste ' || cents_fr(s.solde_omh_cents::bigint) || ', ' || s.jours_retard ||
         ' jours de retard). Vérifiez le dépôt de l''OMH ou communiquez avec l''OMH, puis inscrivez le paiement dans l''onglet Loyers.'
    from v_soldes s
    join immeubles i on i.id = s.immeuble_id and i.actif and i.deleted_at is null
   where s.solde_omh_cents > 0 and s.jours_retard between 5 and 35

  union all
  -- Compteur du véhicule autour du 1er janvier (du 24 décembre au 10 janvier),
  -- s'il n'y a pas déjà un relevé entre le 15 décembre et le 15 janvier
  select 'vehicule_compteur', v.id,
         'compteur:' || v.id || ':' || j.annee,
         'Entrer le compteur · ' || v.nom,
         'Inscrivez le kilométrage du compteur autour du 1er janvier ' || j.annee ||
         ' (onglet Véhicule > Compteur). Il sert à calculer la part déductible de ' || (j.annee - 1) ||
         ' et de ' || j.annee || '.'
    from vehicules v
    cross join auj
    cross join lateral (select case when extract(month from auj.d) = 12
                                    then extract(year from auj.d)::int + 1
                                    else extract(year from auj.d)::int end as annee) j
   where v.deleted_at is null and v.actif
     and (to_char(auj.d, 'MM-DD') >= '12-24' or to_char(auj.d, 'MM-DD') <= '01-10')
     and not exists (select 1 from releves_odometre r
                      where r.vehicule_id = v.id and r.deleted_at is null
                        and r.date_releve between make_date(j.annee - 1, 12, 15) and make_date(j.annee, 1, 15))
$$;

revoke execute on function public.alertes_du_jour() from public, anon, authenticated;
