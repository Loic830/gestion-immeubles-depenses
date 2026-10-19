-- =====================================================================
--  v0.9.3 – Renouveler un bail
--
--  À exécuter une fois dans Supabase > SQL Editor (après 015).
--  Le script peut être exécuté plusieurs fois sans effet de bord.
--
--  1. renouveler_bail(bail, début, fin, loyer) : crée le bail suivant du
--     même logement, avec les mêmes locataires (même principal), les mêmes
--     extras et crédits, le même mode, jour de paiement et inclusions.
--     Le nouveau bail pointe vers l'ancien (bail_precedent_id) et la
--     réponse à l'avis de renouvellement de l'ancien passe à « acceptée ».
--     Tout se fait dans une seule transaction (passe par creer_bail).
--  2. alertes_du_jour : l'avis TAL n'est plus rappelé pour un bail déjà
--     renouvelé (même fonction qu'en 013, une condition de plus).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Renouveler un bail
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

  update renouvellements set reponse = 'acceptee', updated_at = now()
   where bail_id = p_bail and reponse = 'en_attente';

  return v_bail;
end $$;

revoke execute on function public.renouveler_bail(uuid, date, date, bigint) from public, anon;
grant  execute on function public.renouveler_bail(uuid, date, date, bigint) to authenticated;

-- ---------------------------------------------------------------------
-- 2. Alertes du jour : pas d'avis TAL pour un bail déjà renouvelé
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
  select 'loyer_retard', s.immeuble_id,
         'loyer:' || s.echeance_id,
         'Loyer en retard · ' || s.immeuble || ' ' || s.logement,
         'Le loyer ' || de_mois_fr(s.mois) || ' n''est pas reçu (reste ' || cents_fr(s.solde_cents::bigint) || ', ' ||
         s.jours_retard || ' jours de retard). Appelez ' || coalesce(s.locataires, 'le locataire') ||
         ' ou inscrivez le paiement dans l''onglet Loyers.'
    from v_soldes s
    join immeubles i on i.id = s.immeuble_id and i.actif and i.deleted_at is null
   where s.solde_cents > 0 and s.jours_retard between 5 and 35

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
