-- =====================================================================
-- 009 — Crédits mensuels sur le bail (ex. tonte de pelouse : −50 $ par mois)
--
-- À exécuter une fois dans Supabase > SQL Editor (après 008).
--
-- Un « extra » peut maintenant être négatif : c'est un crédit récurrent
-- déduit du montant dû chaque mois. Le total dû du mois ne peut pas
-- descendre sous zéro.
-- =====================================================================

alter table public.bail_extras drop constraint if exists bail_extras_montant_cents_check;
alter table public.bail_extras add constraint bail_extras_montant_non_nul check (montant_cents <> 0);

alter table public.echeances drop constraint if exists echeances_extras_cents_check;
alter table public.echeances add constraint echeances_total_positif check (loyer_cents + extras_cents >= 0);

-- annuler_fin_bail : retirer le forfait sans ramener les extras à zéro
-- (ils peuvent maintenant être négatifs à cause d'un crédit)
create or replace function public.annuler_fin_bail(p_bail uuid)
returns void
language plpgsql security invoker set search_path = public as $$
declare
  f fins_bail%rowtype;
begin
  select * into f from fins_bail where bail_id = p_bail for update;
  if not found then raise exception 'Ce bail n''a pas de fin anticipée à annuler.'; end if;

  if exists (
    select 1 from baux b2 join baux b on b.id = p_bail
     where b2.logement_id = b.logement_id and b2.id <> b.id and b2.deleted_at is null
       and daterange(b2.date_debut, coalesce(b2.date_depart, b2.date_fin), '[]')
        && daterange(b.date_debut, b.date_fin, '[]')
  ) then
    raise exception 'Un nouveau bail est déjà inscrit pour ce logement : impossible d''annuler la fin de ce bail.';
  end if;

  if f.forfait_cents > 0 and f.echeance_id is not null then
    update echeances
       set extras_cents = extras_cents - f.forfait_cents,
           note = nullif(regexp_replace(coalesce(note, ''), '( · )?Montant forfaitaire de fin de bail : [^·]*\$', ''), ''),
           updated_at = now()
     where id = f.echeance_id;
  end if;

  update baux set date_depart = null, updated_at = now() where id = p_bail;
  update renouvellements set reponse = 'en_attente' where bail_id = p_bail and reponse = 'depart';
  delete from fins_bail where bail_id = p_bail;

  perform generer_echeances(p_bail);
end $$;
