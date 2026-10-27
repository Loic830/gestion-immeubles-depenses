-- =====================================================================
--  v0.9.10 – Un dépôt qui paie plusieurs mois
--
--  À exécuter une fois dans Supabase > SQL Editor (après 020).
--  Le script peut être exécuté plusieurs fois sans effet de bord.
--
--  1. paiements.depot_id : les parts d'un même dépôt (ex. 2 589 $ pour
--     juillet, août et septembre) partagent le même identifiant.
--  2. repartir_depot(p) : remplace les paiements des mois choisis par un
--     seul dépôt réparti mois par mois (le plus ancien d'abord).
--  3. annuler_depot(depot) : annule toutes les parts d'un dépôt.
-- =====================================================================

alter table public.paiements add column if not exists depot_id uuid;
create index if not exists paiements_depot_idx on public.paiements (depot_id) where depot_id is not null;

-- ---------------------------------------------------------------------
-- 2. Répartir un dépôt
--    p = { "bail_id": uuid, "echeance_ids": [uuid…], "montant_cents": 258900,
--          "mode": "interac", "date_recue": "2026-09-01", "reference": "…",
--          "notes": "…", "paiement_id": uuid (facultatif : le paiement
--          qu'on corrige ; s'il fait partie d'un dépôt, tout ce dépôt est remplacé) }
--
--  Chaque mois reçoit ce qui reste à payer après ses crédits ; le dernier
--  mois reçoit le reste (un trop-payé reste visible sur ce mois). Les
--  paiements (autres que les crédits) déjà inscrits sur ces mois sont
--  annulés (suppression douce) : le dépôt les remplace.
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
  r         record;
begin
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
   where echeance_id = any(v_ids) and deleted_at is null and mode <> 'credit';

  v_reste := v_total;
  for r in
    select e.id, e.mois, e.montant_du_cents
         - coalesce((select sum(c.montant_cents) from paiements c
                      where c.echeance_id = e.id and c.deleted_at is null
                        and c.mode = 'credit' and c.statut = 'recu'), 0) as du
    from echeances e
    where e.id = any(v_ids)
    order by e.mois
  loop
    v_i := v_i + 1;
    v_part := case when v_i = v_nb then v_reste else least(v_reste, greatest(r.du, 0)) end;
    if v_part > 0 then
      insert into paiements (echeance_id, montant_cents, mode, statut, date_recue, reference, notes, depot_id)
      values (r.id, v_part,
              coalesce(nullif(p->>'mode', '')::mode_loyer, 'interac'), 'recu',
              (p->>'date_recue')::date,
              nullif(btrim(p->>'reference'), ''),
              nullif(btrim(p->>'notes'), ''),
              v_depot);
      v_reste := v_reste - v_part;
    end if;
  end loop;

  return v_depot;
end $$;

revoke execute on function public.repartir_depot(jsonb) from public, anon;
grant  execute on function public.repartir_depot(jsonb) to authenticated;

-- ---------------------------------------------------------------------
-- 3. Annuler un dépôt au complet (erreur de saisie)
-- ---------------------------------------------------------------------
create or replace function public.annuler_depot(p_depot uuid)
returns int
language plpgsql security invoker set search_path = public as $$
declare
  v_nb int;
begin
  update paiements set deleted_at = now() where depot_id = p_depot and deleted_at is null;
  get diagnostics v_nb = row_count;
  return v_nb;
end $$;

revoke execute on function public.annuler_depot(uuid) from public, anon;
grant  execute on function public.annuler_depot(uuid) to authenticated;
