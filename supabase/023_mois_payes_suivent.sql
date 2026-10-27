-- =====================================================================
--  v0.9.13 – Les mois « Marqué payé à la création du bail » suivent le bail
--
--  À exécuter une fois dans Supabase > SQL Editor (après 022).
--  Le script peut être exécuté plusieurs fois sans effet de bord.
--
--  Problème : un bail créé avec « Tous les mois passés sont payés » reçoit
--  un paiement par mois égal au dû de ce jour-là. Si on corrige ensuite le
--  bail (ex. un extra de -112 $ ajouté avec « Modifier le bail »), le dû
--  passe à 995 $ mais les paiements restent à 1 107 $ : trop-payé caché.
--
--  1. paiements.auto : vrai pour un paiement « Marqué payé à la création
--     du bail » jamais modifié à la main. Dès qu'on l'enregistre dans le
--     détail du paiement (même sans changer le montant), il devient un vrai
--     dépôt (auto = faux) et n'est plus jamais réaligné.
--  2. marquer_mois_payes : même fonction qu'en 022, avec auto = vrai.
--  3. realigner_mois_payes(bail) : chaque paiement auto prend le montant qui
--     met à zéro le solde de son payeur (locataire ou OMH) ; les crédits et
--     les autres paiements du mois comptent. S'il n'y a plus rien à payer,
--     il est retiré (suppression douce).
--  4. modifier_bail et modifier_bail_omh l'appellent à la fin.
--     (« Modifier le prix du loyer » ne change toujours pas les paiements.)
--  5. Correction unique des baux existants.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Paiements automatiques
-- ---------------------------------------------------------------------
alter table public.paiements add column if not exists auto boolean not null default false;

-- Les paiements déjà créés : ceux qui n'ont jamais été modifiés (première exécution seulement)
do $$
begin
  if not exists (select 1 from paiements where auto) then
    update paiements set auto = true
     where notes = 'Marqué payé à la création du bail'
       and deleted_at is null and depot_id is null and mode <> 'credit' and statut = 'recu'
       and updated_at <= created_at + interval '2 seconds';
  end if;
end $$;

-- Une modification à la main en fait un paiement ordinaire
create or replace function public.paiement_auto_modifie()
returns trigger
language plpgsql set search_path = public as $$
begin
  -- Toute modification enregistrée dans l'app compte (même sans changer le montant : le chiffre
  -- inscrit est le vrai dépôt) ; seule une annulation (deleted_at) ne compte pas.
  if old.auto and coalesce(current_setting('somax.realignement', true), '') <> 'oui'
     and new.deleted_at is not distinct from old.deleted_at then
    new.auto := false;
  end if;
  return new;
end $$;

drop trigger if exists trg_paiements_auto on public.paiements;
create trigger trg_paiements_auto before update on public.paiements
  for each row execute function public.paiement_auto_modifie();


-- ---------------------------------------------------------------------
-- 2. Marquer des mois payés (022) : auto = vrai
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
      insert into paiements (echeance_id, montant_cents, mode, statut, date_recue, notes, payeur, auto)
      values (r.echeance_id, r.solde_locataire_cents, b.mode_paiement, 'recu', r.date_echeance,
              'Marqué payé à la création du bail', 'locataire', true);
    end if;
    if r.solde_omh_cents > 0 then
      insert into paiements (echeance_id, montant_cents, mode, statut, date_recue, notes, payeur, auto)
      values (r.echeance_id, r.solde_omh_cents, 'depot_direct'::text::mode_loyer, 'recu', r.date_echeance,
              'Marqué payé à la création du bail', 'omh', true);
    end if;
    v_nb := v_nb + 1;
  end loop;
  return v_nb;
end $$;

revoke execute on function public.marquer_mois_payes(uuid, jsonb) from public, anon;
grant  execute on function public.marquer_mois_payes(uuid, jsonb) to authenticated;


-- ---------------------------------------------------------------------
-- 3. Réaligner les mois marqués payés
-- ---------------------------------------------------------------------
create or replace function public.realigner_mois_payes(p_bail uuid)
returns int
language plpgsql security invoker set search_path = public as $$
declare
  r    record;
  v_nb int := 0;
begin
  perform set_config('somax.realignement', 'oui', true);
  for r in
    select p.id, p.montant_cents,
           -- ce qui reste à payer par ce payeur, ce paiement compris
           case when p.payeur = 'omh' then s.solde_omh_cents else s.solde_locataire_cents end as solde
    from paiements p
    join v_soldes s on s.echeance_id = p.echeance_id
    where s.bail_id = p_bail
      and p.auto and p.deleted_at is null and p.statut = 'recu' and p.depot_id is null
      -- un seul paiement auto par mois et par payeur (sinon on ne devine pas)
      and (select count(*) from paiements q
            where q.echeance_id = p.echeance_id and q.deleted_at is null and q.auto and q.payeur = p.payeur) = 1
  loop
    if r.solde = 0 then
      continue;
    elsif r.montant_cents + r.solde > 0 then
      update paiements set montant_cents = r.montant_cents + r.solde where id = r.id;
    else
      update paiements set deleted_at = now() where id = r.id;
    end if;
    v_nb := v_nb + 1;
  end loop;
  perform set_config('somax.realignement', '', true);
  return v_nb;
end $$;

revoke execute on function public.realigner_mois_payes(uuid) from public, anon;
grant  execute on function public.realigner_mois_payes(uuid) to authenticated;


-- ---------------------------------------------------------------------
-- 4a. modifier_bail : même fonction qu'en 012, plus le réalignement
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

  -- v0.9.13 : les mois « Marqué payé à la création du bail » suivent le nouveau montant dû
  perform realigner_mois_payes(v_bail);

  return v_bail;
end $$;

revoke execute on function public.modifier_bail(jsonb) from public, anon;
grant  execute on function public.modifier_bail(jsonb) to authenticated;


-- ---------------------------------------------------------------------
-- 4b. modifier_bail_omh : même fonction qu'en 022, plus le réalignement
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
  -- v0.9.13 : la part de l'OMH a pu changer après modifier_bail
  perform realigner_mois_payes(v_bail);
  return v_bail;
end $$;

revoke execute on function public.modifier_bail_omh(jsonb) from public, anon;
grant  execute on function public.modifier_bail_omh(jsonb) to authenticated;


-- ---------------------------------------------------------------------
-- 5. Correction unique des baux déjà corrigés avant cette version
-- ---------------------------------------------------------------------
select realigner_mois_payes(b.id) from baux b where b.deleted_at is null;
