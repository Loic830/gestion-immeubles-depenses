-- =====================================================================
--  v0.9.9 – Céder un bail terminé (entrer l'historique des baux)
--
--  À exécuter une fois dans Supabase > SQL Editor (après 019).
--  Le script peut être exécuté plusieurs fois sans effet de bord.
--
--  ceder_bail(bail, date, locataires, mois_payes) : même fonction qu'en
--  018, avec ces changements :
--   1. La liste des mois passés déjà payés du nouveau bail (comme
--      « Tous les mois passés sont payés » du Nouveau bail).
--   2. Un bail terminé (ou aux dates passées) peut être cédé : la cession
--      peut être dans le passé, entre le début et la fin du bail.
--   3. Les mois de l'ancien bail après la cession qui avaient été marqués
--      payés automatiquement (« Marqué payé à la création du bail ») sont
--      retirés avec ces mois : ce n'étaient pas de vrais paiements. Un vrai
--      paiement inscrit après la cession bloque toujours (à régler d'abord).
--   4. Un bail déjà renouvelé ou cédé (un bail le suit) est refusé.
-- =====================================================================

drop function if exists public.ceder_bail(uuid, date, jsonb);

create or replace function public.ceder_bail(
  p_bail uuid, p_date date, p_locataires jsonb,
  p_mois_payes jsonb default '[]'::jsonb
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
      'extras', v_ext
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

revoke execute on function public.ceder_bail(uuid, date, jsonb, jsonb) from public, anon;
grant  execute on function public.ceder_bail(uuid, date, jsonb, jsonb) to authenticated;
