-- =====================================================================
-- 012 — Modifier un bail, remplacer un bail en cours, retirer une page (v0.8.7)
--
-- À exécuter une fois dans Supabase > SQL Editor (après 011).
--
-- 1. documents.deleted_at : une page de bail ajoutée par erreur peut être
--    retirée (suppression douce ; le fichier reste dans le bucket).
-- 2. modifier_bail(p jsonb) : corrige tous les détails d'un bail en une
--    transaction (logement, dates, loyer, extras et crédits, mode, jour,
--    inclusions, notes, locataires et leurs coordonnées). Les loyers dus
--    sont recalculés ; les paiements déjà reçus restent.
-- 3. creer_bail_en_remplacement(p jsonb, p_ancien uuid) : nouveau bail sur
--    un logement qui a déjà un bail en cours. L'ancien bail se termine le
--    dernier jour du mois avant le début du nouveau (terminer_bail), puis
--    le nouveau est créé (creer_bail). Tout ou rien.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Pages de bail retirées
-- ---------------------------------------------------------------------
alter table public.documents add column if not exists deleted_at timestamptz;


-- ---------------------------------------------------------------------
-- 2. modifier_bail
--
--  p = {
--    "id": "uuid du bail",
--    "logement_id": "uuid", "date_debut": "2026-07-01", "date_fin": "2027-06-30" | null,
--    "loyer_cents": 95000,          -- loyer au DÉBUT du bail (avant les changements de loyer)
--    "jour_echeance": 1, "mode_paiement": "interac", "inclusions": "...", "notes": "...",
--    "locataires": [ { "id": "uuid" }                                   -- locataire connu, inchangé
--                  | { "id": "uuid", "prenom": "...", "nom": "...", ... } -- coordonnées corrigées
--                  | { "prenom": "...", "nom": "...", "telephone": "...", "courriel": "..." } ],
--                  (le premier de la liste est le locataire principal)
--    "extras": [ { "libelle": "Stationnement", "montant_cents": 3000 } ]  -- remplace la liste
--  }
-- ---------------------------------------------------------------------
create or replace function public.modifier_bail(p jsonb)
returns uuid
language plpgsql security invoker set search_path = public as $$
declare
  v_bail     uuid := (p->>'id')::uuid;
  b          baux%rowtype;
  v_debut    date := (p->>'date_debut')::date;
  v_fin      date := nullif(p->>'date_fin', '')::date;
  v_loyer    bigint := (p->>'loyer_cents')::bigint;
  v_premier  date;          -- premier changement de loyer (mois), s'il y en a
  v_fin_ech  date;          -- dernier mois de loyer dû selon les nouvelles dates
  v_payes    int;
  v_extra    bigint;
  v_ancien_x bigint;
  v_forfait  bigint := 0;
  v_ech_fin  uuid;
  l          jsonb;
  e          jsonb;
  v_loc      uuid;
  v_i        int := 0;
  f          record;
begin
  select * into b from baux where id = v_bail and deleted_at is null for update;
  if not found then raise exception 'Bail introuvable.'; end if;
  if v_debut is null then raise exception 'Entre la date de début.'; end if;
  if v_fin is not null and v_fin < v_debut then raise exception 'La date de fin est avant la date de début.'; end if;
  if v_loyer is null or v_loyer < 0 then raise exception 'Le loyer doit être un montant positif.'; end if;
  if jsonb_array_length(coalesce(p->'locataires', '[]'::jsonb)) = 0 then
    raise exception 'Un bail doit avoir au moins un locataire.';
  end if;
  if b.date_depart is not null and b.date_depart < v_debut then
    raise exception 'Le départ du locataire (%) est avant la nouvelle date de début. Annule d''abord la fin du bail.', to_char(b.date_depart, 'YYYY-MM-DD');
  end if;
  if b.date_depart is not null and v_fin is not null and b.date_depart > v_fin then
    raise exception 'Le départ du locataire (%) est après la nouvelle date de fin. Annule d''abord la fin du bail.', to_char(b.date_depart, 'YYYY-MM-DD');
  end if;

  select min(date_effet) into v_premier from changements_loyer where bail_id = v_bail;
  v_fin_ech := date_trunc('month', coalesce(b.date_depart, v_fin))::date;
  if v_premier is not null and (v_premier < date_trunc('month', v_debut)::date
                                or (v_fin_ech is not null and v_premier > v_fin_ech)) then
    raise exception 'Un changement de loyer (%) tombe en dehors des nouvelles dates du bail.', to_char(v_premier, 'YYYY-MM');
  end if;

  -- Mois qui sortent du bail : refusé s'ils ont déjà des paiements
  select count(*) into v_payes
    from echeances x join paiements pa on pa.echeance_id = x.id and pa.deleted_at is null
   where x.bail_id = v_bail
     and (x.mois < date_trunc('month', v_debut)::date or (v_fin_ech is not null and x.mois > v_fin_ech));
  if v_payes > 0 then
    raise exception 'Il y a % paiement(s) inscrit(s) sur des mois qui sortiraient du bail. Annule-les dans l''onglet Loyers, puis recommence.', v_payes;
  end if;

  -- 2a. Le bail lui-même (la contrainte baux_sans_chevauchement vérifie le logement et les dates)
  update baux set
    logement_id   = (p->>'logement_id')::uuid,
    date_debut    = v_debut,
    date_fin      = v_fin,
    loyer_cents   = case when v_premier is null then v_loyer else loyer_cents end,
    jour_echeance = coalesce((p->>'jour_echeance')::int, 1),
    mode_paiement = coalesce(nullif(p->>'mode_paiement', '')::mode_loyer, 'interac'),
    inclusions    = nullif(btrim(p->>'inclusions'), ''),
    notes         = nullif(btrim(p->>'notes'), ''),
    updated_at    = now()
  where id = v_bail;

  -- Le loyer de départ d'un bail qui a eu des changements : on corrige l'historique
  if v_premier is not null then
    update changements_loyer set ancien_loyer_cents = v_loyer
     where bail_id = v_bail and date_effet = v_premier;
  end if;

  -- 2b. Locataires : liste remplacée, coordonnées corrigées
  delete from bail_locataires where bail_id = v_bail;
  for l in select * from jsonb_array_elements(p->'locataires') loop
    if nullif(l->>'id', '') is not null then
      v_loc := (l->>'id')::uuid;
      if l ? 'prenom' then
        if nullif(btrim(l->>'prenom'), '') is null or nullif(btrim(l->>'nom'), '') is null then
          raise exception 'Chaque locataire a besoin d''un prénom et d''un nom.';
        end if;
        update locataires set
          prenom = btrim(l->>'prenom'), nom = btrim(l->>'nom'),
          telephone = nullif(btrim(l->>'telephone'), ''), courriel = nullif(btrim(l->>'courriel'), ''),
          updated_at = now()
        where id = v_loc;
      end if;
    else
      insert into locataires (prenom, nom, telephone, courriel)
      values (btrim(l->>'prenom'), btrim(l->>'nom'),
              nullif(btrim(l->>'telephone'), ''), nullif(btrim(l->>'courriel'), ''))
      returning id into v_loc;
    end if;
    insert into bail_locataires (bail_id, locataire_id, principal) values (v_bail, v_loc, v_i = 0)
    on conflict (bail_id, locataire_id) do nothing;   -- même personne choisie deux fois
    v_i := v_i + 1;
  end loop;

  -- 2c. Extras et crédits : liste remplacée
  select coalesce(sum(montant_cents), 0) into v_ancien_x from bail_extras where bail_id = v_bail;
  delete from bail_extras where bail_id = v_bail;
  for e in select * from jsonb_array_elements(coalesce(p->'extras', '[]'::jsonb)) loop
    insert into bail_extras (bail_id, libelle, montant_cents)
    values (v_bail, btrim(e->>'libelle'), (e->>'montant_cents')::bigint);
  end loop;
  select coalesce(sum(montant_cents), 0) into v_extra from bail_extras where bail_id = v_bail;

  -- 2d. Loyers dus : mois hors des nouvelles dates retirés, mois manquants créés
  delete from echeances
   where bail_id = v_bail
     and (mois < date_trunc('month', v_debut)::date or (v_fin_ech is not null and mois > v_fin_ech));

  -- Bail à durée indéterminée devenu déterminé (ou l'inverse) : generer_echeances complète
  perform generer_echeances(v_bail);

  -- Loyer de départ appliqué aux mois avant le premier changement
  update echeances set loyer_cents = v_loyer, updated_at = now()
   where bail_id = v_bail and (v_premier is null or mois < v_premier) and loyer_cents <> v_loyer;

  -- Extras recalculés seulement s'ils ont changé (le forfait de fin de bail est conservé)
  select echeance_id, forfait_cents into v_ech_fin, v_forfait from fins_bail where bail_id = v_bail;
  -- (les mois nouvellement créés ont déjà reçu la somme des extras)
  if v_extra <> v_ancien_x then
    update echeances
       set extras_cents = v_extra + case when id = v_ech_fin then coalesce(v_forfait, 0) else 0 end,
           updated_at = now()
     where bail_id = v_bail;
  end if;

  -- 2e. Fenêtre d'avis TAL selon les nouvelles dates
  select * into f from fenetre_avis(v_debut, v_fin);
  update renouvellements set avis_du = f.avis_du, avis_au = f.avis_au, updated_at = now() where bail_id = v_bail;
  if not found then
    insert into renouvellements (bail_id, avis_du, avis_au) values (v_bail, f.avis_du, f.avis_au);
  end if;

  return v_bail;
end $$;


-- ---------------------------------------------------------------------
-- 3. creer_bail_en_remplacement : termine le bail en cours, puis crée le nouveau
--    p : mêmes champs que creer_bail ; p_ancien : le bail qui se termine
--    Fin de l'ancien = dernier jour du mois avant le début du nouveau
--    (nouveau bail le 1er juillet 2027 → ancien bail terminé le 30 juin 2027).
-- ---------------------------------------------------------------------
create or replace function public.creer_bail_en_remplacement(p jsonb, p_ancien uuid)
returns uuid
language plpgsql security invoker set search_path = public as $$
declare
  a       baux%rowtype;
  v_debut date := (p->>'date_debut')::date;
  v_fin   date;
begin
  select * into a from baux where id = p_ancien and deleted_at is null for update;
  if not found then raise exception 'Le bail en cours est introuvable.'; end if;
  if a.logement_id <> (p->>'logement_id')::uuid then
    raise exception 'Le bail en cours n''est pas sur ce logement.';
  end if;

  v_fin := (date_trunc('month', v_debut) - interval '1 day')::date;
  if v_fin < a.date_debut then
    raise exception 'Le bail en cours commence le % : il ne peut pas se terminer le %. Modifie ou supprime ce bail.',
      to_char(a.date_debut, 'YYYY-MM-DD'), to_char(v_fin, 'YYYY-MM-DD');
  end if;
  if a.date_depart is not null then
    raise exception 'Le bail en cours a déjà une date de départ (%). Annule cette fin de bail sur sa fiche, puis recommence.',
      to_char(a.date_depart, 'YYYY-MM-DD');
  end if;

  perform terminer_bail(p_ancien, v_fin, 0,
    'Remplacé par un nouveau bail débutant le ' || to_char(v_debut, 'YYYY-MM-DD'));

  return creer_bail(p || jsonb_build_object('bail_precedent_id', p_ancien));
end $$;

revoke execute on function public.modifier_bail(jsonb) from public, anon;
grant  execute on function public.modifier_bail(jsonb) to authenticated;
revoke execute on function public.creer_bail_en_remplacement(jsonb, uuid) from public, anon;
grant  execute on function public.creer_bail_en_remplacement(jsonb, uuid) to authenticated;
