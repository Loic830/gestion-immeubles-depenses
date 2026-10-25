-- =====================================================================
--  v0.9.6 – Renouveler un bail terminé (entrer l'historique des baux)
--
--  À exécuter une fois dans Supabase > SQL Editor (après 018).
--  Le script peut être exécuté plusieurs fois sans effet de bord.
--
--  1. renouveler_bail(bail, début, fin, loyer, mois_payes) : même fonction
--     qu'en 018, avec la liste des mois passés déjà payés (comme
--     « Tous les mois passés sont payés » du Nouveau bail). Un bail
--     terminé peut être renouvelé : les dates passées sont permises ;
--     seul un chevauchement avec un autre bail du logement est refusé.
--     Un bail déjà renouvelé (un bail le suit déjà) est refusé.
--  2. lier_renouvellement(bail, suivant) : le bail qui suit déjà (entré
--     avec « Nouveau bail ») devient le renouvellement de celui-ci : il
--     pointe vers lui (bail_precedent_id) et son type passe à
--     « renouvellement ». Sert à raccorder l'historique au bail en cours.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Renouveler un bail (aussi terminé)
-- ---------------------------------------------------------------------
drop function if exists public.renouveler_bail(uuid, date, date, bigint);

create or replace function public.renouveler_bail(
  p_bail uuid, p_date_debut date, p_date_fin date, p_loyer_cents bigint,
  p_mois_payes jsonb default '[]'::jsonb
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
      'mois_payes', coalesce(p_mois_payes, '[]'::jsonb)
    ));
  exception when exclusion_violation then
    raise exception 'Un autre bail occupe déjà ce logement pendant ces dates. Raccourcis la durée.';
  end;

  update baux set origine = 'renouvellement' where id = v_bail;

  update renouvellements set reponse = 'acceptee', updated_at = now()
   where bail_id = p_bail and reponse = 'en_attente';

  return v_bail;
end $$;

revoke execute on function public.renouveler_bail(uuid, date, date, bigint, jsonb) from public, anon;
grant  execute on function public.renouveler_bail(uuid, date, date, bigint, jsonb) to authenticated;

-- ---------------------------------------------------------------------
-- 2. Raccorder le bail suivant comme renouvellement
-- ---------------------------------------------------------------------
create or replace function public.lier_renouvellement(p_bail uuid, p_suivant uuid)
returns void
language plpgsql security invoker set search_path = public as $$
declare
  b baux%rowtype;
  s baux%rowtype;
begin
  select * into b from baux where id = p_bail and deleted_at is null;
  if not found then raise exception 'Bail introuvable.'; end if;
  select * into s from baux where id = p_suivant and deleted_at is null for update;
  if not found then raise exception 'Bail suivant introuvable.'; end if;
  if s.logement_id <> b.logement_id then
    raise exception 'Les deux baux doivent être dans le même logement.';
  end if;
  if b.date_depart is not null then
    raise exception 'Ce bail a une date de départ : il ne peut pas être renouvelé.';
  end if;
  if b.date_fin is null or s.date_debut <= b.date_fin then
    raise exception 'Le bail suivant doit commencer après la fin de ce bail.';
  end if;
  if s.bail_precedent_id is not null and s.bail_precedent_id <> p_bail then
    raise exception 'Le bail suivant est déjà rattaché à un autre bail.';
  end if;
  if exists (select 1 from baux n where n.bail_precedent_id = p_bail and n.id <> p_suivant and n.deleted_at is null) then
    raise exception 'Ce bail est déjà renouvelé par un autre bail.';
  end if;

  update baux set bail_precedent_id = p_bail, origine = 'renouvellement', updated_at = now()
   where id = p_suivant;

  update renouvellements set reponse = 'acceptee', updated_at = now()
   where bail_id = p_bail and reponse = 'en_attente';
end $$;

revoke execute on function public.lier_renouvellement(uuid, uuid) from public, anon;
grant  execute on function public.lier_renouvellement(uuid, uuid) to authenticated;
