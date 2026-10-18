-- =====================================================================
-- 013 — Centre de notifications (v0.8.9)
--
-- À exécuter une fois dans Supabase > SQL Editor (après 012).
--
-- 1. notifications : une ligne par personne et par alerte (titre +
--    description), lue ou non lue. Chacun ne voit que les siennes.
-- 2. notifications_exclusions : préférences. Une ligne = une notification
--    que la personne ne veut pas recevoir, pour tout (cible_id vide) ou
--    pour un immeuble / un véhicule précis.
-- 3. abonnements_push : les téléphones qui ont accepté les notifications
--    poussées (Web Push, iPhone avec l'app sur l'écran d'accueil).
-- 4. generer_notifications() : calcule les alertes du jour pour chaque
--    personne (sauf exclusions) ; une même alerte n'est jamais créée deux
--    fois (colonne cle). Appelée chaque matin par Vercel Cron et à
--    l'ouverture de l'app.
--
-- Catalogue (doit rester identique à lib/notifications.ts) :
--   hypotheque_renouvellement  fin de terme dans 120, 60, 30 jours  (immeuble)
--   assurance_renouvellement   renouvellement dans 30, 7 jours      (immeuble)
--   taxes_echeance             versement dans 14, 3 jours, en retard (immeuble)
--   avis_tal                   fenêtre d'avis ouverte, 14 jours avant la fin (immeuble)
--   loyer_retard               loyer impayé depuis 5 jours (35 au plus) (immeuble)
--   vehicule_compteur          relevé du compteur autour du 1er janvier (véhicule)
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------
create table public.notifications (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  type        text not null,                      -- code du catalogue (lib/notifications.ts)
  cible_id    uuid,                               -- immeuble ou véhicule visé (préférences)
  cle         text not null,                      -- empêche les doublons (ex. hypo:<id>:60)
  titre       text not null check (btrim(titre) <> ''),
  description text not null check (btrim(description) <> ''),
  est_test    boolean not null default false,     -- envoyée par « Tester les notifications possibles »
  lue_le      timestamptz,                        -- vide = non lue
  poussee_le  timestamptz,                        -- envoyée au téléphone (Web Push)
  created_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  unique (user_id, cle)
);
create index notifications_user_idx on public.notifications (user_id, created_at desc) where deleted_at is null;
create index notifications_a_pousser_idx on public.notifications (created_at) where poussee_le is null and deleted_at is null;

create table public.notifications_exclusions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  type       text not null,
  cible_id   uuid,                                -- vide = ce type au complet
  created_at timestamptz not null default now()
);
create unique index notifications_exclusions_uniq
  on public.notifications_exclusions (user_id, type, coalesce(cible_id, '00000000-0000-0000-0000-000000000000'::uuid));

create table public.abonnements_push (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  endpoint   text not null unique,
  p256dh     text not null,
  auth       text not null,
  appareil   text,                                -- navigateur (user agent), pour s'y retrouver
  created_at timestamptz not null default now()
);
create index abonnements_push_user_idx on public.abonnements_push (user_id);

-- Chacun ne voit et ne modifie que ses propres lignes (pas de suppression :
-- une notification se retire par deleted_at ; préférences et abonnements
-- peuvent être supprimés).
alter table public.notifications            enable row level security;
alter table public.notifications_exclusions enable row level security;
alter table public.abonnements_push         enable row level security;

create policy mes_notifications on public.notifications
  for select to authenticated using (user_id = auth.uid());
create policy mes_notifications_ajout on public.notifications
  for insert to authenticated with check (user_id = auth.uid());
create policy mes_notifications_maj on public.notifications
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy mes_exclusions on public.notifications_exclusions
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy mes_abonnements on public.abonnements_push
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

grant select, insert, update on public.notifications to authenticated;
grant select, insert, update, delete on public.notifications_exclusions to authenticated;
grant select, insert, update, delete on public.abonnements_push to authenticated;
grant all on public.notifications, public.notifications_exclusions, public.abonnements_push to service_role;


-- ---------------------------------------------------------------------
-- 2. Petites aides d'affichage en français
-- ---------------------------------------------------------------------
-- 2027-02-15 → « 15 février 2027 », 2027-01-01 → « 1er janvier 2027 »
create or replace function public.date_fr(d date)
returns text language sql immutable as $$
  select case when extract(day from d) = 1 then '1er' else extract(day from d)::int::text end || ' ' ||
         (array['janvier','février','mars','avril','mai','juin','juillet','août',
                'septembre','octobre','novembre','décembre'])[extract(month from d)::int] || ' ' ||
         extract(year from d)::int
$$;

-- 123456 → « 1 234,56 $ »
create or replace function public.cents_fr(c bigint)
returns text language sql immutable as $$
  select replace(replace(to_char(c / 100.0, 'FM999G999G990D00'), ',', ' '), '.', ',') || ' $'
$$;

-- 2026-08-01 → « d'août 2026 », 2026-07-01 → « de juillet 2026 »
create or replace function public.de_mois_fr(d date)
returns text language sql immutable as $$
  select case when extract(month from d) in (4, 8, 10) then 'd''' else 'de ' end ||
         (array['janvier','février','mars','avril','mai','juin','juillet','août',
                'septembre','octobre','novembre','décembre'])[extract(month from d)::int] || ' ' ||
         extract(year from d)::int
$$;

-- « dans 1 jour », « dans 30 jours », « aujourd'hui »
create or replace function public.dans_jours(n int)
returns text language sql immutable as $$
  select case when n <= 0 then 'aujourd''hui' when n = 1 then 'demain' else 'dans ' || n || ' jours' end
$$;


-- ---------------------------------------------------------------------
-- 3. Alertes du jour (sans personne) : type, cible, clé, titre, description
--    Palier = le plus petit seuil atteint (ex. 50 jours avant → seuil 60).
--    Si l'app n'a pas tourné pendant un moment, on saute directement au
--    bon palier sans envoyer les anciens.
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


-- ---------------------------------------------------------------------
-- 4. generer_notifications : crée les alertes du jour pour chaque personne
--    (sauf préférences) ; retourne le nombre de notifications créées.
-- ---------------------------------------------------------------------
create or replace function public.generer_notifications()
returns int language plpgsql volatile security definer set search_path = public as $$
declare
  v_nb int;
begin
  insert into notifications (user_id, type, cible_id, cle, titre, description)
  select u.id, a.type, a.cible_id, a.cle, a.titre, a.description
    from alertes_du_jour() a
    cross join auth.users u
   where not exists (select 1 from notifications_exclusions x
                      where x.user_id = u.id and x.type = a.type
                        and (x.cible_id is null or x.cible_id = a.cible_id))
  on conflict (user_id, cle) do nothing;
  get diagnostics v_nb = row_count;
  return v_nb;
end $$;

revoke execute on function public.generer_notifications() from public, anon;
grant  execute on function public.generer_notifications() to authenticated, service_role;
