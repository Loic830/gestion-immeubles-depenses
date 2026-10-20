-- =====================================================================
--  v0.9.5 – Cession de bail et type de bail (dossier prêteur)
--
--  À exécuter une fois dans Supabase > SQL Editor (après 017).
--  Le script peut être exécuté plusieurs fois sans effet de bord.
--
--  1. baux.origine : 'nouveau', 'renouvellement' ou 'cession'.
--     Un renouvellement ou une cession pointe vers le bail qu'il suit
--     (bail_precedent_id) : le dossier prêteur remonte cette chaîne pour
--     joindre le bail d'origine signé, chaque renouvellement et la cession.
--     Un « nouveau » bail (autre locataire, même s'il remplace un bail en
--     cours) commence une nouvelle chaîne.
--     Les baux déjà renouvelés avec le bouton de 0.9.3 sont reconnus par
--     leur note « Renouvellement du bail du … ».
--  2. v_baux : ajoute la colonne origine (à la fin, mêmes colonnes avant).
--  3. renouveler_bail : même fonction qu'en 016, inscrit origine = renouvellement.
--  4. ceder_bail(bail, date, locataires) : le bail en cours se termine la
--     veille de la cession (terminer_bail), puis un bail au nom des
--     nouveaux locataires est créé avec le même loyer, la même fin, les
--     mêmes extras, mode, jour et inclusions, et les hausses déjà prévues.
--     La cession prend effet le 1er d'un mois. Tout ou rien.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Type de bail
-- ---------------------------------------------------------------------
alter table public.baux add column if not exists origine text not null default 'nouveau';
alter table public.baux drop constraint if exists baux_origine_check;
alter table public.baux add constraint baux_origine_check
  check (origine in ('nouveau', 'renouvellement', 'cession'));

update public.baux set origine = 'renouvellement'
 where origine = 'nouveau' and bail_precedent_id is not null
   and notes like 'Renouvellement du bail du %';

-- ---------------------------------------------------------------------
-- 2. v_baux avec origine (colonnes de 004 dans le même ordre, origine à la fin)
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
  b.origine
from public.baux b
join public.logements l on l.id = b.logement_id
join public.immeubles i on i.id = l.immeuble_id
left join public.renouvellements r on r.bail_id = b.id
where b.deleted_at is null;

-- ---------------------------------------------------------------------
-- 3. Renouveler un bail (016) : le nouveau bail est un renouvellement
-- ---------------------------------------------------------------------
create or replace function public.renouveler_bail(
  p_bail uuid, p_date_debut date, p_date_fin date, p_loyer_cents bigint
)
returns uuid
language plpgsql security invoker set search_path = public as $$
declare
  b      baux%rowtype;
  v_loc  jsonb;
  v_ext  jsonb;
  v_bail uuid;
begin
  select * into b from baux where id = p_bail and deleted_at is null;
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
      'extras', v_ext
    ));
  exception when exclusion_violation then
    raise exception 'Un autre bail occupe déjà ce logement pendant ces dates.';
  end;

  update baux set origine = 'renouvellement' where id = v_bail;

  update renouvellements set reponse = 'acceptee', updated_at = now()
   where bail_id = p_bail and reponse = 'en_attente';

  return v_bail;
end $$;

revoke execute on function public.renouveler_bail(uuid, date, date, bigint) from public, anon;
grant  execute on function public.renouveler_bail(uuid, date, date, bigint) to authenticated;

-- ---------------------------------------------------------------------
-- 4. Céder un bail
--
--  p_locataires = [ { "prenom": "...", "nom": "...", "telephone": "...", "courriel": "..." }
--                 | { "id": "uuid" } ]   (le premier est le locataire principal)
--  Retourne l'id du nouveau bail.
-- ---------------------------------------------------------------------
create or replace function public.ceder_bail(p_bail uuid, p_date date, p_locataires jsonb)
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

  perform terminer_bail(p_bail, p_date - 1, 0,
    'Bail cédé à compter du ' || date_fr(p_date));

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
    'extras', v_ext
  ));

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

  return v_bail;
end $$;

revoke execute on function public.ceder_bail(uuid, date, jsonb) from public, anon;
grant  execute on function public.ceder_bail(uuid, date, jsonb) to authenticated;
