-- =====================================================================
--  Module 1 – Migration 002 : enregistrement d'une dépense en un seul appel
--
--  À exécuter APRÈS module1_schema.sql (Supabase > SQL Editor > Run).
--
--  Pourquoi : la vérification « somme des lignes = total » s'exécute à la
--  fin de la transaction. L'en-tête, les lignes et les pièces jointes
--  doivent donc être créés dans la MÊME transaction. Cette fonction le fait
--  en un seul appel depuis l'application : supabase.rpc('enregistrer_depense').
--
--  Paramètre p (jsonb) :
--  {
--    "fournisseur_nom": "Home Depot",        -- créé s'il n'existe pas
--    "mode_paiement_id": "uuid" | null,
--    "date_facture": "2026-10-16",
--    "no_facture": "A123" | null,
--    "sous_total_cents": 12383 | null,
--    "tps_cents": 619, "tvq_cents": 1235,
--    "total_cents": 14237 | null,            -- null permis en brouillon
--    "statut": "brouillon" | "complete",
--    "notes": "..." | null,
--    "lignes": [ { "immeuble_id": "uuid", "logement_id": "uuid"|null,
--                  "categorie_id": "uuid"|null, "montant_cents": 14237|null,
--                  "description": "..."|null } ],
--    "pieces": [ { "storage_key": "2026/10/x.jpg", "miniature_key": "...",
--                  "mime_type": "image/jpeg", "taille_octets": 123456,
--                  "largeur": 2000, "hauteur": 1500,
--                  "sha256": "...", "nom_original": "IMG_1234.HEIC" } ]
--  }
--  Retour : l'id de la dépense créée.
-- =====================================================================

create or replace function public.enregistrer_depense(p jsonb)
returns uuid
language plpgsql
security invoker              -- respecte les règles RLS de l'utilisateur connecté
set search_path = public, extensions
as $$
declare
  v_depense     uuid;
  v_fournisseur uuid;
  v_nom         text;
  v_cat_defaut  uuid;
  l             jsonb;
  pj            jsonb;
begin
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
  insert into depenses (
    fournisseur_id, mode_paiement_id, date_facture, no_facture,
    sous_total_cents, tps_cents, tvq_cents, total_cents, statut, notes
  ) values (
    v_fournisseur,
    nullif(p->>'mode_paiement_id', '')::uuid,
    coalesce(nullif(p->>'date_facture', '')::date, current_date),
    nullif(btrim(p->>'no_facture'), ''),
    (p->>'sous_total_cents')::bigint,
    coalesce((p->>'tps_cents')::bigint, 0),
    coalesce((p->>'tvq_cents')::bigint, 0),
    (p->>'total_cents')::bigint,
    coalesce(nullif(p->>'statut', '')::statut_depense, 'brouillon'),
    nullif(btrim(p->>'notes'), '')
  )
  returning id into v_depense;

  -- 3. Lignes (la ventilation)
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
    -- Le fournisseur « apprend » sa catégorie habituelle
    if v_cat_defaut is null then
      v_cat_defaut := nullif(l->>'categorie_id', '')::uuid;
    end if;
  end loop;

  if v_fournisseur is not null and v_cat_defaut is not null then
    update fournisseurs set categorie_defaut_id = v_cat_defaut
    where id = v_fournisseur and categorie_defaut_id is null;
  end if;

  -- 4. Pièces jointes (fichiers déjà téléversés dans le bucket « recus »)
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

-- Seuls les utilisateurs connectés peuvent appeler la fonction.
revoke execute on function public.enregistrer_depense(jsonb) from public, anon;
grant  execute on function public.enregistrer_depense(jsonb) to authenticated;
