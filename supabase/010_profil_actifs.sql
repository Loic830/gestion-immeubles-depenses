-- =====================================================================
--  v0.8.5 – Profil et Actifs
--  Valeur d'achat et vente d'un immeuble.
--
--  Utilisation : Supabase > SQL Editor > New query > coller tout > Run.
--  Le script peut être exécuté plusieurs fois sans effet de bord.
--
--  Un immeuble vendu passe à actif = false : il disparaît des nouvelles
--  saisies (dépenses, véhicule) mais reste dans l'historique (loyers,
--  baux, liste des dépenses, exports). Rien n'est supprimé.
--
--  Les infos personnelles (nom, cellulaire) sont gardées dans le compte
--  Supabase Auth (user_metadata) : aucune table nécessaire.
-- =====================================================================

alter table public.immeubles
  add column if not exists valeur_achat_cents bigint check (valeur_achat_cents >= 0),
  add column if not exists date_vente         date,
  add column if not exists prix_vente_cents   bigint check (prix_vente_cents >= 0);

-- Une date de vente implique un immeuble inactif (vendu).
alter table public.immeubles drop constraint if exists immeuble_vente_coherente;
alter table public.immeubles add constraint immeuble_vente_coherente
  check (date_vente is null or actif = false);

comment on column public.immeubles.valeur_achat_cents is 'Prix payé à l''achat (gain en capital à la vente)';
comment on column public.immeubles.date_vente         is 'Date de vente ; renseignée seulement si actif = false';
comment on column public.immeubles.prix_vente_cents   is 'Prix de vente';
