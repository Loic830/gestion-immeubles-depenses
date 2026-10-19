-- =====================================================================
--  v0.9.4 – Enquête de crédit et règlements d'immeuble sur un bail
--
--  À exécuter une fois dans Supabase > SQL Editor (après 016).
--  Le script peut être exécuté plusieurs fois sans effet de bord.
--
--  La table documents accepte deux nouveaux types, rangés comme le bail
--  signé (photos ou PDF dans baux/AAAA/MM/ du bucket recus) :
--    enquete_credit : enquête de crédit du locataire
--    reglements     : règlements d'immeuble signés par le locataire
--  Le dossier du prêteur continue de prendre seulement le bail signé.
-- =====================================================================

alter type public.type_document add value if not exists 'enquete_credit';
alter type public.type_document add value if not exists 'reglements';
