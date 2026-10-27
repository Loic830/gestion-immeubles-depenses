-- =====================================================================
--  v0.9.16 – Entretien : équipements des immeubles et des logements
--
--  À exécuter une fois dans Supabase > SQL Editor (après 023).
--  Le script peut être exécuté plusieurs fois sans effet de bord.
--
--  1. equipements : chauffe-eau, fournaise, toiture, électroménagers…
--     d'un immeuble (parties communes : logement_id vide) ou d'un logement.
--     Date d'installation + durée de vie (ans) → date de remplacement prévue,
--     ou une date prévue inscrite à la main (a priorité).
--     Entretien périodique facultatif : aux N mois, dernier entretien.
--     Remplacé = date_retrait + remplace_par_id (le nouvel équipement) :
--     l'ancien reste pour l'historique.
--  2. v_equipements : libellé du type, date prévue, prochain entretien.
--     (vue : « drop view » puis « create » pour pouvoir relancer le script)
--  3. RPC remplacer_equipement : retire l'ancien et crée le nouveau en une fois.
--  4. alertes_du_jour : + equipement_remplacement et equipement_entretien
--     (cible = immeuble, pour les préférences).
--  5. supprimer_immeuble : retire aussi les équipements.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Équipements
-- ---------------------------------------------------------------------
create table if not exists public.equipements (
  id                 uuid primary key default gen_random_uuid(),
  immeuble_id        uuid not null references public.immeubles(id),
  logement_id        uuid references public.logements(id),          -- vide = parties communes
  type               text not null check (btrim(type) <> ''),        -- code de lib/entretien.ts (chauffe_eau, fournaise…) ou « autre »
  nom                text,                                           -- précision libre : « 60 gallons », « Toit plat arrière »
  marque             text,
  modele             text,
  no_serie           text,
  date_installation  date,
  duree_vie_ans      int check (duree_vie_ans between 1 and 100),
  date_remplacement  date,                                           -- prévue, inscrite à la main (a priorité sur le calcul)
  garantie_fin       date,
  cout_cents         bigint check (cout_cents >= 0),
  fournisseur        text,                                           -- installateur
  entretien_mois     int check (entretien_mois between 1 and 120),
  entretien_quoi     text,                                           -- « Vidanger », « Changer le filtre »
  dernier_entretien  date,
  date_retrait       date,                                           -- remplacé ou enlevé
  remplace_par_id    uuid references public.equipements(id),
  notes              text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz
);
create index if not exists equipements_immeuble_idx on public.equipements (immeuble_id) where deleted_at is null;

drop trigger if exists trg_equipements_maj on public.equipements;
create trigger trg_equipements_maj before update on public.equipements for each row execute function public.maj_updated_at();

-- Le logement doit être dans l'immeuble
create or replace function public.equipement_logement_coherent()
returns trigger language plpgsql as $$
begin
  if new.logement_id is not null and not exists
     (select 1 from logements where id = new.logement_id and immeuble_id = new.immeuble_id) then
    raise exception 'Ce logement n''est pas dans cet immeuble';
  end if;
  return new;
end $$;
drop trigger if exists trg_equipements_logement on public.equipements;
create trigger trg_equipements_logement before insert or update of immeuble_id, logement_id on public.equipements
  for each row execute function public.equipement_logement_coherent();

alter table public.equipements enable row level security;
drop policy if exists acces_authentifie on public.equipements;
create policy acces_authentifie on public.equipements for all to authenticated using (true) with check (true);

-- ---------------------------------------------------------------------
-- 2. Vue : libellé, date de remplacement prévue, prochain entretien
--    (libellés : garder pareils que TYPES_EQUIPEMENT de lib/entretien.ts)
-- ---------------------------------------------------------------------
create or replace function public.libelle_equipement(t text)
returns text language sql immutable as $$
  select case t
    when 'chauffe_eau'    then 'Chauffe-eau'
    when 'fournaise'      then 'Fournaise'
    when 'thermopompe'    then 'Thermopompe'
    when 'climatiseur'    then 'Climatiseur'
    when 'plinthes'       then 'Plinthes électriques'
    when 'echangeur_air'  then 'Échangeur d''air'
    when 'toiture'        then 'Toiture'
    when 'fenetres'       then 'Fenêtres'
    when 'refrigerateur'  then 'Réfrigérateur'
    when 'cuisiniere'     then 'Cuisinière'
    when 'laveuse'        then 'Laveuse'
    when 'secheuse'       then 'Sécheuse'
    when 'lave_vaisselle' then 'Lave-vaisselle'
    when 'hotte'          then 'Hotte de cuisinière'
    when 'detecteur_fumee' then 'Détecteur de fumée'
    when 'detecteur_co'   then 'Détecteur de monoxyde de carbone'
    when 'extincteur'     then 'Extincteur'
    when 'panneau_electrique' then 'Panneau électrique'
    when 'pompe_puisard'  then 'Pompe de puisard'
    when 'cheminee'       then 'Cheminée'
    else 'Équipement'
  end
$$;

drop view if exists public.v_equipements;
create view public.v_equipements with (security_invoker = true) as
select e.*,
       -- « Autre » : la précision sert de nom (ex. « Asphalte du stationnement »)
       case when e.type = 'autre' and nullif(btrim(e.nom), '') is not null then btrim(e.nom)
            else libelle_equipement(e.type) end as libelle,
       case when e.type = 'autre' then null else nullif(btrim(e.nom), '') end as precision_nom,
       coalesce(e.date_remplacement,
                (e.date_installation + make_interval(years => e.duree_vie_ans))::date) as date_prevue,
       case when e.entretien_mois is not null and coalesce(e.dernier_entretien, e.date_installation) is not null
            then (coalesce(e.dernier_entretien, e.date_installation) + make_interval(months => e.entretien_mois))::date
       end as prochain_entretien
  from equipements e
 where e.deleted_at is null;

-- ---------------------------------------------------------------------
-- 3. Remplacer un équipement : l'ancien est retiré à la date choisie et
--    le nouveau (même immeuble, logement et type) est créé, installé ce jour-là.
-- ---------------------------------------------------------------------
create or replace function public.remplacer_equipement(p_id uuid, p jsonb)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  a equipements%rowtype;
  v_date date := (p->>'date_installation')::date;
  v_nouveau uuid;
begin
  if auth.uid() is null then raise exception 'Connexion requise'; end if;
  select * into a from equipements where id = p_id and deleted_at is null for update;
  if not found then raise exception 'Équipement introuvable'; end if;
  if a.date_retrait is not null then raise exception 'Cet équipement est déjà remplacé'; end if;
  if v_date is null then raise exception 'Date du remplacement obligatoire'; end if;

  insert into equipements (immeuble_id, logement_id, type, nom, marque, modele, no_serie, date_installation,
                           duree_vie_ans, date_remplacement, garantie_fin, cout_cents, fournisseur,
                           entretien_mois, entretien_quoi, dernier_entretien, notes)
  values (a.immeuble_id, a.logement_id, a.type,
          nullif(btrim(p->>'nom'), ''), nullif(btrim(p->>'marque'), ''), nullif(btrim(p->>'modele'), ''),
          nullif(btrim(p->>'no_serie'), ''), v_date,
          (p->>'duree_vie_ans')::int, (p->>'date_remplacement')::date, (p->>'garantie_fin')::date,
          (p->>'cout_cents')::bigint, nullif(btrim(p->>'fournisseur'), ''),
          (p->>'entretien_mois')::int, nullif(btrim(p->>'entretien_quoi'), ''), null,
          nullif(btrim(p->>'notes'), ''))
  returning id into v_nouveau;

  update equipements set date_retrait = v_date, remplace_par_id = v_nouveau where id = p_id;
  return v_nouveau;
end $$;
revoke execute on function public.remplacer_equipement(uuid, jsonb) from public, anon;
grant  execute on function public.remplacer_equipement(uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------
-- 4. Alertes du jour : même fonction qu'en 022, + les deux alertes d'équipement
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

  union all
  -- v0.9.16 : équipement à remplacer (fin de la durée de vie) : 180 et 60 jours avant, puis une fois si la date est passée.
  -- La clé contient la date prévue : une date repoussée redonne des alertes.
  select 'equipement_remplacement', e.immeuble_id,
         'equip:' || e.id || ':' || e.date_prevue || ':' || coalesce(p.seuil::text, 'retard'),
         case when e.date_prevue < auj.d then 'Remplacement dû : ' else 'Prévoir le remplacement : ' end ||
         e.libelle || ' · ' || i.nom || coalesce(' ' || l.numero, ''),
         e.libelle || coalesce(' (' || e.precision_nom || ')', '') ||
         coalesce(' · installation le ' || date_fr(e.date_installation), '') ||
         ' · remplacement prévu le ' || date_fr(e.date_prevue) ||
         case when e.date_prevue < auj.d
              then ' (date passée' || coalesce(', durée de vie de ' || e.duree_vie_ans || ' ans', '') || ')'
              else ', ' || dans_jours(e.date_prevue - auj.d) || coalesce(' (durée de vie de ' || e.duree_vie_ans || ' ans)', '') end
         || '. Faites vérifier l''équipement ou demandez une soumission. Quand il est changé, touchez « Remplacé » dans '
         || 'Profil > Entretien (ou changez la date prévue s''il est encore bon).'
    from v_equipements e
    join immeubles i on i.id = e.immeuble_id and i.actif and i.deleted_at is null
    left join logements l on l.id = e.logement_id
    cross join auj
    cross join lateral (select min(s) as seuil from unnest(array[60, 180]) s
                         where s >= e.date_prevue - auj.d and e.date_prevue >= auj.d) p
   where e.date_retrait is null and e.date_prevue is not null
     and (e.date_prevue < auj.d or p.seuil is not null)

  union all
  -- v0.9.16 : entretien périodique (ex. vidanger le chauffe-eau chaque année) : 14 jours avant, une fois par entretien
  select 'equipement_entretien', e.immeuble_id,
         'entr:' || e.id || ':' || e.prochain_entretien,
         'Faire l''entretien : ' || e.libelle || ' · ' || i.nom || coalesce(' ' || l.numero, ''),
         coalesce(e.entretien_quoi, 'Entretien') || ' · ' || e.libelle || coalesce(' (' || e.precision_nom || ')', '') ||
         ' · prévu le ' || date_fr(e.prochain_entretien) ||
         case when e.prochain_entretien < auj.d then ' (date passée' else ', ' || dans_jours(e.prochain_entretien - auj.d) || ' (' end ||
         case when e.prochain_entretien < auj.d then ', ' else '' end || 'aux ' || e.entretien_mois || ' mois). '
         || 'Une fois fait, touchez « Entretien fait » dans Profil > Entretien.'
    from v_equipements e
    join immeubles i on i.id = e.immeuble_id and i.actif and i.deleted_at is null
    left join logements l on l.id = e.logement_id
    cross join auj
   where e.date_retrait is null and e.prochain_entretien is not null
     and e.prochain_entretien - auj.d <= 14
$$;
revoke execute on function public.alertes_du_jour() from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 5. Supprimer un immeuble de partout : retire aussi ses équipements
-- ---------------------------------------------------------------------
create or replace function public.supprimer_immeuble(p_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_maintenant timestamptz := now();
begin
  if auth.uid() is null then raise exception 'Connexion requise'; end if;
  if not exists (select 1 from immeubles where id = p_id and deleted_at is null) then
    raise exception 'Immeuble introuvable';
  end if;

  -- Baux des logements de l'immeuble (loyers dus et paiements suivent : v_soldes et v_baux filtrent les baux retirés)
  update baux b set deleted_at = v_maintenant
    from logements l
   where l.id = b.logement_id and l.immeuble_id = p_id and b.deleted_at is null;
  update logements set deleted_at = v_maintenant where immeuble_id = p_id and deleted_at is null;

  -- Dépenses entièrement sur cet immeuble ; une dépense répartie garde ses autres lignes
  update depenses d set deleted_at = v_maintenant
   where d.deleted_at is null
     and exists     (select 1 from depense_lignes x where x.depense_id = d.id and x.immeuble_id = p_id)
     and not exists (select 1 from depense_lignes x where x.depense_id = d.id and x.immeuble_id <> p_id);

  -- Véhicule : trajets vers cet immeuble, trajets fréquents, lieu
  update deplacements    set deleted_at = v_maintenant where immeuble_id = p_id and deleted_at is null;
  update trajets_favoris set deleted_at = v_maintenant where immeuble_id = p_id and deleted_at is null;
  update lieux           set deleted_at = v_maintenant where immeuble_id = p_id and deleted_at is null;

  -- Frais fixes
  update hypotheque_releves r set deleted_at = v_maintenant
    from hypotheques h
   where h.id = r.hypotheque_id and h.immeuble_id = p_id and r.deleted_at is null;
  update hypotheques      set deleted_at = v_maintenant where immeuble_id = p_id and deleted_at is null;
  update assurances       set deleted_at = v_maintenant where immeuble_id = p_id and deleted_at is null;
  update taxes_versements set deleted_at = v_maintenant where immeuble_id = p_id and deleted_at is null;

  -- Entretien (v0.9.16)
  update equipements set deleted_at = v_maintenant where immeuble_id = p_id and deleted_at is null;

  -- Notifications et préférences de tout le monde
  update notifications set deleted_at = v_maintenant where cible_id = p_id and deleted_at is null;
  delete from notifications_exclusions where cible_id = p_id;

  update immeubles set deleted_at = v_maintenant, actif = false, updated_at = v_maintenant where id = p_id;
end;
$$;
revoke execute on function public.supprimer_immeuble(uuid) from public, anon;
grant  execute on function public.supprimer_immeuble(uuid) to authenticated;
