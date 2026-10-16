-- =====================================================================
--  Module 1 – Migration 003 : modification d'une dépense en un seul appel
--
--  À exécuter APRÈS 002_enregistrer_depense.sql (SQL Editor > Run).
--
--  Sert à : modifier une dépense, compléter un brouillon, ajouter des pages
--  au reçu. Tout se fait dans une seule transaction pour que la vérification
--  « somme des lignes = total » s'applique au résultat final.
--
--  Paramètre p (jsonb) : mêmes champs que enregistrer_depense, plus "id".
--    - Les lignes envoyées REMPLACENT les lignes existantes.
--    - Les pièces envoyées S'AJOUTENT aux existantes (aucun reçu n'est retiré).
-- =====================================================================

create or replace function public.modifier_depense(p jsonb)
returns uuid
language plpgsql
security invoker
set search_path = public, extensions
as $$
declare
  v_depense     uuid := (p->>'id')::uuid;
  v_fournisseur uuid;
  v_nom         text;
  v_cat_defaut  uuid;
  l             jsonb;
  pj            jsonb;
begin
  if v_depense is null or not exists (
    select 1 from depenses where id = v_depense and deleted_at is null
  ) then
    raise exception 'Dépense introuvable ou supprimée.';
  end if;

  -- 1. Fournisseur : retrouvé par nom normalisé, sinon créé
  v_nom := nullif(regexp_replace(btrim(coalesce(p->>'fournisseur_nom', '')), '\s+', ' ', 'g'), '');
  if v_nom is not null then
    select id into v_fournisseur
    from fournisseurs
    where nom_normalise = lower(unaccent(v_nom)) and deleted_at is null;
    if v_fournisseur is null then
      insert into fournisseurs (nom) values (v_nom) returning id into v_fournisseur;
    end if;
  end if;

  -- 2. En-tête
  update depenses set
    fournisseur_id   = v_fournisseur,
    mode_paiement_id = nullif(p->>'mode_paiement_id', '')::uuid,
    date_facture     = coalesce(nullif(p->>'date_facture', '')::date, date_facture),
    no_facture       = nullif(btrim(p->>'no_facture'), ''),
    sous_total_cents = (p->>'sous_total_cents')::bigint,
    tps_cents        = coalesce((p->>'tps_cents')::bigint, 0),
    tvq_cents        = coalesce((p->>'tvq_cents')::bigint, 0),
    total_cents      = (p->>'total_cents')::bigint,
    statut           = coalesce(nullif(p->>'statut', '')::statut_depense, statut),
    notes            = nullif(btrim(p->>'notes'), '')
  where id = v_depense;

  -- 3. Lignes : remplacées
  delete from depense_lignes where depense_id = v_depense;
  for l in select * from jsonb_array_elements(coalesce(p->'lignes', '[]'::jsonb)) loop
    insert into depense_lignes (depense_id, immeuble_id, logement_id, categorie_id, montant_cents, description)
    values (
      v_depense,
      (l->>'immeuble_id')::uuid,
      nullif(l->>'logement_id', '')::uuid,
      nullif(l->>'categorie_id', '')::uuid,
      (l->>'montant_cents')::bigint,
      nullif(btrim(l->>'description'), '')
    );
    if v_cat_defaut is null then
      v_cat_defaut := nullif(l->>'categorie_id', '')::uuid;
    end if;
  end loop;

  if v_fournisseur is not null and v_cat_defaut is not null then
    update fournisseurs set categorie_defaut_id = v_cat_defaut
    where id = v_fournisseur and categorie_defaut_id is null;
  end if;

  -- 4. Nouvelles pièces jointes : ajoutées
  for pj in select * from jsonb_array_elements(coalesce(p->'pieces', '[]'::jsonb)) loop
    insert into pieces_jointes (depense_id, storage_key, miniature_key, mime_type,
                                taille_octets, largeur, hauteur, sha256, nom_original)
    values (
      v_depense,
      pj->>'storage_key',
      nullif(pj->>'miniature_key', ''),
      pj->>'mime_type',
      (pj->>'taille_octets')::int,
      (pj->>'largeur')::int,
      (pj->>'hauteur')::int,
      nullif(pj->>'sha256', ''),
      nullif(pj->>'nom_original', '')
    );
  end loop;

  return v_depense;
end $$;

revoke execute on function public.modifier_depense(jsonb) from public, anon;
grant  execute on function public.modifier_depense(jsonb) to authenticated;
