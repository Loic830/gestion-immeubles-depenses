-- =====================================================================
--  v0.9.0 – Véhicules (plusieurs), Actifs, suppression d'un immeuble
--
--  À exécuter une fois dans Supabase > SQL Editor (après 013).
--  Le script peut être exécuté plusieurs fois sans effet de bord.
--
--  1. Véhicules : marque, modèle, couleur, année ; vente (date, prix).
--     La colonne « nom » reste utilisée partout (exports, notifications) :
--     l'app la remplit avec « marque modèle couleur ».
--  2. supprimer_vehicule(id) : retire le véhicule et ses trajets, frais
--     et relevés du compteur (suppression douce, deleted_at).
--  3. supprimer_immeuble(id) : retire l'immeuble « de partout »
--     (suppression douce) : logements, baux, dépenses, trajets, lieux,
--     frais fixes et notifications. Les données restent en base.
--  4. v_depenses_detail : les lignes d'un immeuble supprimé disparaissent
--     (dépense répartie entre plusieurs immeubles : les autres lignes restent).
--  5. Le nom d'un immeuble supprimé peut être réutilisé.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Véhicules
-- ---------------------------------------------------------------------
alter table public.vehicules
  add column if not exists marque           text,
  add column if not exists modele           text,
  add column if not exists couleur          text,
  add column if not exists annee            int check (annee between 1950 and 2100),
  add column if not exists date_vente       date,
  add column if not exists prix_vente_cents bigint check (prix_vente_cents >= 0);

-- Une date de vente implique un véhicule inactif (vendu), comme les immeubles.
alter table public.vehicules drop constraint if exists vehicule_vente_coherente;
alter table public.vehicules add constraint vehicule_vente_coherente
  check (date_vente is null or actif = false);

comment on column public.vehicules.nom        is 'Nom affiché : marque modèle couleur (rempli par l''app)';
comment on column public.vehicules.date_vente is 'Date de vente ; renseignée seulement si actif = false';

-- ---------------------------------------------------------------------
-- 2. Supprimer un véhicule (suppression douce)
-- ---------------------------------------------------------------------
create or replace function public.supprimer_vehicule(p_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_maintenant timestamptz := now();
begin
  if auth.uid() is null then raise exception 'Connexion requise'; end if;
  if not exists (select 1 from vehicules where id = p_id and deleted_at is null) then
    raise exception 'Véhicule introuvable';
  end if;

  update deplacements     set deleted_at = v_maintenant where vehicule_id = p_id and deleted_at is null;
  update frais_vehicule   set deleted_at = v_maintenant where vehicule_id = p_id and deleted_at is null;
  update releves_odometre set deleted_at = v_maintenant where vehicule_id = p_id and deleted_at is null;
  -- Notifications et préférences de tout le monde (security definer : la RLS limite chacun à ses lignes)
  update notifications    set deleted_at = v_maintenant where cible_id = p_id and deleted_at is null;
  delete from notifications_exclusions where cible_id = p_id;
  update vehicules        set deleted_at = v_maintenant, actif = false where id = p_id;
end;
$$;

-- ---------------------------------------------------------------------
-- 3. Supprimer un immeuble de partout (suppression douce)
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

  -- Notifications et préférences de tout le monde
  update notifications set deleted_at = v_maintenant where cible_id = p_id and deleted_at is null;
  delete from notifications_exclusions where cible_id = p_id;

  update immeubles set deleted_at = v_maintenant, actif = false, updated_at = v_maintenant where id = p_id;
end;
$$;

revoke execute on function public.supprimer_vehicule(uuid) from public, anon;
revoke execute on function public.supprimer_immeuble(uuid) from public, anon;
grant  execute on function public.supprimer_vehicule(uuid) to authenticated;
grant  execute on function public.supprimer_immeuble(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 4. v_depenses_detail : sans les immeubles supprimés (mêmes colonnes qu'en 001)
-- ---------------------------------------------------------------------
create or replace view public.v_depenses_detail
with (security_invoker = true) as
select
  l.id                 as ligne_id,
  d.id                 as depense_id,
  d.date_facture,
  d.date_paiement,
  d.statut,
  f.nom                as fournisseur,
  i.id                 as immeuble_id,
  i.nom                as immeuble,
  lg.numero            as logement,
  c.id                 as categorie_id,
  c.nom                as categorie,
  cp.nom               as categorie_parent,
  c.code_fiscal,
  l.nature,
  l.montant_cents,
  d.sous_total_cents,
  d.tps_cents,
  d.tvq_cents,
  d.total_cents,
  mp.nom               as mode_paiement,
  d.no_facture,
  l.description,
  d.notes,
  (select count(*) from public.pieces_jointes p where p.depense_id = d.id) as nb_pieces
from public.depense_lignes l
join public.depenses d        on d.id  = l.depense_id
join public.immeubles i       on i.id  = l.immeuble_id
left join public.logements lg on lg.id = l.logement_id
left join public.categories c on c.id  = l.categorie_id
left join public.categories cp on cp.id = c.parent_id
left join public.fournisseurs f on f.id = d.fournisseur_id
left join public.modes_paiement mp on mp.id = d.mode_paiement_id
where d.deleted_at is null
  and i.deleted_at is null;

-- ---------------------------------------------------------------------
-- 5. Nom d'immeuble unique parmi les immeubles non supprimés seulement
-- ---------------------------------------------------------------------
alter table public.immeubles drop constraint if exists immeubles_nom_key;
create unique index if not exists immeubles_nom_unique
  on public.immeubles (nom) where deleted_at is null;
