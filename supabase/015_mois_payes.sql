-- =====================================================================
--  v0.9.1 – Nouveau bail : « Tous les mois passés sont payés »
--
--  À exécuter une fois dans Supabase > SQL Editor (après 014).
--  Le script peut être exécuté plusieurs fois sans effet de bord.
--
--  1. marquer_mois_payes(bail, mois) : pour chaque mois donné
--     (["2026-07-01", "2026-08-01"…]), inscrit un paiement « reçu » égal au
--     solde du mois, au mode de paiement du bail, daté du jour d'échéance.
--     Seuls les mois du bail dont l'échéance est passée (ou aujourd'hui)
--     sont touchés ; un mois déjà payé est laissé tel quel.
--  2. creer_bail(p) accepte « mois_payes » (même liste) et appelle
--     marquer_mois_payes dans la même transaction. creer_bail_en_remplacement
--     passe par creer_bail : il en profite aussi.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Marquer des mois payés
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
    select s.echeance_id, s.solde_cents, s.date_echeance
    from v_soldes s
    where s.bail_id = p_bail
      and s.mois in (select date_trunc('month', (x #>> '{}')::date)::date
                     from jsonb_array_elements(p_mois) x)
      and s.date_echeance <= current_date
      and s.solde_cents > 0
  loop
    insert into paiements (echeance_id, montant_cents, mode, statut, date_recue, notes)
    values (r.echeance_id, r.solde_cents, b.mode_paiement, 'recu', r.date_echeance,
            'Marqué payé à la création du bail');
    v_nb := v_nb + 1;
  end loop;
  return v_nb;
end $$;

revoke execute on function public.marquer_mois_payes(uuid, jsonb) from public, anon;
grant  execute on function public.marquer_mois_payes(uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------
-- 2. creer_bail : même fonction qu'en 004, plus l'étape des mois payés
--    p = { …champs de 004…, "mois_payes": ["2026-07-01", "2026-08-01"] }
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
  -- v0.9.1 : « Tous les mois passés sont payés » (mois exclus déjà retirés par l'app)
  perform marquer_mois_payes(v_bail, coalesce(p->'mois_payes', '[]'::jsonb));

  select * into f from fenetre_avis((p->>'date_debut')::date, nullif(p->>'date_fin', '')::date);
  insert into renouvellements (bail_id, avis_du, avis_au) values (v_bail, f.avis_du, f.avis_au);

  return v_bail;
end $$;

revoke execute on function public.creer_bail(jsonb) from public, anon;
grant  execute on function public.creer_bail(jsonb) to authenticated;
