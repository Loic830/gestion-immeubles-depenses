# Passation — Gestion des immeubles

> Document de référence pour reprendre le projet : à lire en premier, par une personne
> ou par une nouvelle conversation avec Claude. État au **20 octobre 2026**, version **0.9.5**.
> Le `README.md` complète ce document (détail de chaque écran et historique des versions).

---

## 1. Le projet en bref

Application web progressive (PWA), utilisée surtout sur iPhone, pour gérer **3 immeubles à Alma** (21 logements) :

| Immeuble | Logements | Numérotation |
| --- | --- | --- |
| Gauthier | 9 | 1 à 9 |
| Robert-Jean | 8 | numéros civiques 680 à 69x |
| Camélias | 4 | 2130 à 2136 |

**Personnes**
- **Maxime** : propriétaire, utilisateur principal (iPhone). Parle français québécois.
- **Conjointe de Maxime** : utilisatrice (compte séparé). Tout le monde voit tout.
- **Loïc** (fils) : déploie et valide les choix techniques. Compte Supabase et Vercel.
- **Comptable** : reçoit les exports annuels (T776 fédéral, TP-128 Québec).

**Ce que l'app fait aujourd'hui** : en-tête « Immeubles So-Max » (cloche, avatar → Profil et Actifs) et
5 onglets en bas, dans l'ordre : Loyers · Baux · Frais fixes · Dépenses · Véhicules.
1. **Loyers** 💵 : loyers dus du mois par immeuble, « Reçu » en un geste, paiements partiels, crédits ponctuels, retards (tous mois) ; encadré des dépôts faits du mois (toucher = par immeuble, v0.9.4) et boutons « Appeler » / « Texter » pour les retards (v0.9.2).
2. **Dépenses** 🧾 : saisie avec photo du reçu, brouillons, répartition entre immeubles, récapitulatif en haut, navigation Mois / Année avec flèches (v0.8.8) ; choix d'un ou plusieurs immeubles (puces « Tous » + chaque immeuble, v0.9.1) ; anneau par catégorie et barres en mode Mois et Année (v0.9.2), cachés par défaut : toucher le montant du haut les affiche (v0.9.4). Les exports sont dans Profil > Rapport d'impôts (v0.9.0).
3. **Baux** 🔑 : baux et locataires, photo du bail signé, changement de loyer en cours de bail, fin de bail anticipée avec montant forfaitaire, extras et crédits mensuels, fenêtre d'avis TAL ; filtre par années (courante à courante − 6), immeuble et recherche ; dossier prêteur par immeuble **pour la période choisie** ; historique des baux d'un logement ; **modification complète d'un bail** ; pop-up de remplacement quand un nouveau bail chevauche un bail en cours (v0.8.7) ; nouveau bail : « Tous les mois passés sont payés » avec mois à exclure, prix le plus récent du logement affiché avant le loyer (v0.9.1) ; encadré du haut : taux d'occupation, loyers par mois et barres de l'année (toucher = par immeuble) (v0.9.2) ; filtres par logement (immeuble choisi) et par état des baux, « Renouveler le bail », « Modifier le prix du loyer » (v0.9.3) ; nouveau bail : question sur les mois passés, alerte sans photo du bail, photos de l'enquête de crédit et des règlements d'immeuble (aussi sur la fiche) (v0.9.4) ; **cession de bail** sur la fiche, type de bail (nouveau, renouvellement, cession) et dossier prêteur qui joint toute la chaîne des copies : bail d'origine, renouvellements, cession (v0.9.5).
4. **Véhicules** 🚗 (v0.9.0 : plusieurs véhicules, flèches ‹ › avec « marque modèle couleur » au centre) : journal de bord (km), trajets fréquents (puce choisie colorée, immeuble caché ; « Composer un trajet » en dernière puce), frais du véhicule, relevés du compteur, prorata déductible par immeuble.
5. **Frais fixes** 🏦 (v0.8.6) : par immeuble et par année, prêts hypothécaires (plusieurs par immeuble, ventilation capital / intérêts recalculée, relevé du prêteur prioritaire), assurances (police en PDF), taxes foncières et scolaires par versement ; « Payé » inscrit la dépense dans Dépenses.
6. **Profil** (v0.8.5) : mon compte, déconnexion, Actifs séparés en **Immeubles** (ajout, logements, vente, « Supprimer cet immeuble de partout ») et **Véhicules** (ajout, modification, vente, suppression) ; **Rapport d'impôts** (v0.9.0) : année + dépenses et reçus (ZIP), CSV, dossier de chaque véhicule ; en bas, « Tester les notifications possibles » (v0.8.9).
7. **Notifications** 🔔 (v0.8.9) : cloche jaune-orangé s'il y a du non lu ; tiroir (plus récent en haut, contour jaune-orangé = non lue, toucher = lue / non lue) ; préférences par type et par immeuble ou véhicule ; notifications poussées sur l'iPhone (Web Push, app sur l'écran d'accueil).

---

## 2. Technique

| Élément | Choix |
| --- | --- |
| Interface | Next.js 15 (App Router), React 19, TypeScript ; **tous les écrans sont des composants client** (`"use client"`) |
| Données | Supabase (Postgres, Auth, Storage) via `@supabase/supabase-js`, session côté client |
| Exports | ExcelJS et JSZip, **chargés seulement au clic** (`import()` dynamique) |
| Hébergement | Vercel, déploiement automatique depuis la branche **`main`** |
| Projet Supabase | « Gestion des immeubles » (compte de Loïc) |
| Variables | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` ; notifications poussées (v0.8.9) : `NEXT_PUBLIC_VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUJET`, `SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET` (voir `.env.local.example` et README) |
| Tâche quotidienne | Vercel Cron (`vercel.json`) : `GET /api/notifications/envoyer` à 12 h UTC (calcule et pousse les notifications) |
| Notifications poussées | Web Push (`web-push` côté serveur, `public/sw.js` côté téléphone). iPhone : iOS 16.4+, app ajoutée à l'écran d'accueil |

**Sécurité**
- Inscriptions publiques **désactivées** ; les comptes sont créés à la main dans Supabase.
- RLS activé partout, politique unique `acces_authentifie` : tout utilisateur connecté lit et écrit tout.
- Bucket Storage **privé** `recus` (15 Mo, jpeg/webp/pdf), sans politique de suppression. Dossiers :
  `AAAA/MM/…` (reçus de dépenses), `baux/AAAA/MM/…` (baux signés), `vehicule/AAAA/MM/…` (reçus du véhicule).
  Affichage par URL signées (10 min).

**Conventions de code (à respecter)**
- **Argent en cents entiers** (`bigint`), jamais de décimales en base. Affichage : `formatCents` ; saisie : `versCents` (`lib/argent.ts`).
- **Dates en chaînes `AAAA-MM-JJ`**, jamais d'objet `Date` pour stocker (évite les décalages de fuseau) : `lib/dates.ts`.
- **Suppression douce** (`deleted_at`) : on ne supprime jamais une dépense, un bail ou un paiement.
- Opérations à plusieurs tables = **fonctions RPC** en une transaction (`enregistrer_depense`, `creer_bail`, `changer_loyer`, `terminer_bail`…).
- Statuts calculés, jamais saisis (ex. statut d'un bail dans `v_baux`).
- Vues en `security_invoker = true`.
- Interface **en français**, textes courts, gros boutons ; écrans pensés pour le téléphone d'abord.
- Exports Excel : toujours écrire `result` à côté d'une `formula` (l'aperçu de l'iPhone n'évalue pas les formules).
- Images traitées sur le téléphone avant l'envoi (`lib/image.ts`) : 2000 px, JPEG 0,8, miniature 400 px, EXIF/GPS retirés, empreinte SHA-256.

---

## 3. Base de données — migrations

Fichiers dans `supabase/`, à exécuter **une seule fois chacun, dans l'ordre**, dans Supabase > SQL Editor.
Un message « already exists » signifie que le fichier a déjà été exécuté.

| # | Fichier | Contenu | État |
| --- | --- | --- | --- |
| 001 | `001_module1_schema.sql` | immeubles, logements, catégories (codes T776), fournisseurs, modes de paiement, dépenses, lignes, pièces jointes, bucket, RLS | exécuté |
| 002 | `002_enregistrer_depense.sql` | RPC `enregistrer_depense` | exécuté |
| 003 | `003_modifier_depense.sql` | RPC `modifier_depense` | exécuté |
| 004 | `004_module2_loyers.sql` | locataires, baux, extras, échéances, paiements, renouvellements, documents ; `creer_bail`, `generer_echeances`, `prolonger_echeances`, `fenetre_avis`, `occupation` ; vues `v_soldes`, `v_baux` | exécuté |
| 005 | `005_changement_loyer_credits.sql` | `changements_loyer`, RPC `changer_loyer` ; mode de paiement `credit` | exécuté |
| 006 | `006_fin_de_bail.sql` | `fins_bail`, RPC `terminer_bail`, `annuler_fin_bail` | exécuté |
| 007 | `007_vehicule.sql` | véhicules, relevés du compteur, trajets favoris, déplacements, frais du véhicule | **à confirmer** |
| 008 | `008_lieux_distances.sql` | lieux, distances entre lieux, `trajets_favoris.etapes` | **à confirmer** |
| 009 | `009_credits_mensuels.sql` | extras négatifs (crédits mensuels), `annuler_fin_bail` corrigée | **à confirmer** |
| 010 | `010_profil_actifs.sql` | `immeubles` : valeur d'achat, date et prix de vente (v0.8.5) | **à confirmer** |
| 011 | `011_frais_fixes.sql` | `hypotheques`, `hypotheque_releves`, `assurances`, `taxes_versements` ; `documents.bail_id` facultatif + type `assurance` ; RPC `payer_frais_fixe`, `annuler_paiement_frais_fixe` (v0.8.6) | **à confirmer** |
| 012 | `012_modifier_bail.sql` | `documents.deleted_at` ; RPC `modifier_bail`, `creer_bail_en_remplacement` (v0.8.7) | **à exécuter** |
| 013 | `013_notifications.sql` | `notifications` (lue_le, poussee_le, cle unique), `notifications_exclusions`, `abonnements_push` (RLS : chacun ses lignes) ; `alertes_du_jour()`, `generer_notifications()` ; aides `date_fr`, `cents_fr`, `de_mois_fr` (v0.8.9) | **à exécuter** |
| 014 | `014_vehicules_actifs.sql` | `vehicules` : marque, modele, couleur, annee, date_vente, prix_vente_cents ; RPC `supprimer_vehicule`, `supprimer_immeuble` (security definer, suppression douce en cascade) ; `v_depenses_detail` filtre `immeubles.deleted_at` ; index unique partiel sur `immeubles.nom` (v0.9.0) | **à exécuter** |
| 015 | `015_mois_payes.sql` | RPC `marquer_mois_payes(bail, mois jsonb)` (paiement « reçu » = solde du mois, mode du bail, daté de l'échéance ; seulement les mois échus) ; `creer_bail` redéfinie (copie de 004 + `mois_payes`) (v0.9.1) | **à exécuter** |
| 016 | `016_renouveler_bail.sql` | RPC `renouveler_bail(bail, début, fin, loyer)` (via `creer_bail`, `bail_precedent_id`, réponse = acceptée) ; `alertes_du_jour` redéfinie (copie de 013 + pas d'avis TAL si un bail suit avec `bail_precedent_id`) (v0.9.3) | **à exécuter** |
| 017 | `017_documents_bail.sql` | types de documents `enquete_credit` et `reglements` (v0.9.4) | **à exécuter** |
| 018 | `018_cession_bail.sql` | `baux.origine` (nouveau / renouvellement / cession ; anciens renouvellements reconnus par leur note) ; `v_baux` redéfinie (colonnes explicites + `origine` à la fin) ; `renouveler_bail` redéfinie (copie de 016 + origine) ; RPC `ceder_bail(bail, date, locataires)` (terminer_bail la veille + creer_bail, mêmes loyer/fin/extras, hausses prévues reportées) (v0.9.5) | **à exécuter** |

> Mettre à jour la colonne « État » quand Loïc confirme. La prochaine migration sera `019_…`.
> Vérifier aussi que les fichiers 005 à 012 sont bien poussés dans le dépôt GitHub.

**Modèle — points clés**
- `depenses` (en-tête, `statut` brouillon/complete) → `depense_lignes` (une par immeuble/catégorie ; somme des lignes = total, vérifiée par trigger différé) → `pieces_jointes`.
- `baux` (contrainte d'exclusion : pas de chevauchement sur un logement ; `date_fin` vide = durée indéterminée ; `date_depart` = départ réel) → `bail_locataires` (un principal) → `bail_extras` (montant positif = extra, **négatif = crédit mensuel**).
- `echeances` : un loyer dû par bail et par mois (`loyer_cents + extras_cents` = `montant_du_cents`, colonne générée ; total ≥ 0).
- `paiements` : statut `recu` / `en_main` / `sans_provision` ; mode `interac` / `cheque` / `prelevement` / `comptant` / `credit` (crédit : raison obligatoire dans `notes`).
- `v_soldes` : dû, reçu, chèques en main, solde, jours de retard par échéance.
- Fenêtre d'avis TAL (C.c.Q. art. 1942) : bail de 12 mois ou plus → 6 à 3 mois avant la fin ; moins de 12 mois → 2 à 1 mois avant.

**Tester le SQL sans toucher à la vraie base** : une copie locale PostgreSQL 16 avec un fichier de remplacement
(`stub.sql`) qui crée les schémas `auth`/`storage`, les rôles `authenticated`/`anon`, `auth.uid()` et les tables
`storage.buckets`/`storage.objects`. Chaque migration a été testée ainsi avant d'être livrée.

---

## 4. Carte des fichiers

**Attention : il y a 17 fichiers `page.tsx`.** Ne jamais se fier au nom du fichier seul ; chacun se reconnaît
à sa ligne `export default function` :

| Chemin | Écran | `export default function` |
| --- | --- | --- |
| `app/page.tsx` | onglet **Dépenses** (récapitulatif, Mois / Année, liste, exports) | `Accueil` |
| `app/nouvelle/page.tsx` | nouvelle dépense | `NouvelleDepense` |
| `app/depense/[id]/page.tsx` | détail d'une dépense | `DetailDepense` |
| `app/depense/[id]/modifier/page.tsx` | modifier / compléter | `ModifierDepense` |
| `app/loyers/page.tsx` | onglet **Loyers** | `PageLoyers` |
| `app/baux/page.tsx` | onglet **Baux** (liste) | `PageBaux` |
| `app/baux/nouveau/page.tsx` | nouveau bail | `PageNouveauBail` |
| `app/baux/[id]/page.tsx` | fiche du bail ; « Cession de bail », type et lien vers le bail précédent (v0.9.5) | `DetailBail` |
| `app/baux/[id]/modifier/page.tsx` | modifier le bail (v0.8.7) ; type de bail si le bail suit un autre bail (v0.9.5) | `ModifierBail` |
| `app/baux/logement/[id]/page.tsx` | historique des baux d'un logement (v0.8.7) | `HistoriqueLogement` |
| `app/vehicule/page.tsx` | onglet **Véhicules** | `PageVehicule` |
| `app/login/page.tsx` | connexion | `PageConnexion` |
| `app/frais-fixes/page.tsx` | onglet **Frais fixes** | `PageFraisFixes` |
| `app/profil/page.tsx` | Profil, Actifs (Immeubles, Véhicules), Rapport d'impôts | `PageProfil` |
| `app/profil/immeubles/[id]/page.tsx` | détail d'un immeuble | `PageDetailImmeuble` |
| `app/profil/vehicules/[id]/page.tsx` | détail d'un véhicule : modifier, vendre, supprimer (v0.9.0) | `PageDetailVehicule` |
| `app/profil/notifications/page.tsx` | Tester les notifications possibles (v0.8.9) | `PageTestNotifications` |

**Composants et bibliothèques**

| Fichier | Rôle |
| --- | --- |
| `components/BarreOnglets.tsx` | barre d'onglets du bas (Loyers · Baux · Frais fixes · Dépenses · Véhicule) |
| `components/EnTete.tsx` | en-tête fixe : nom de l'app, cloche (jaune-orangé si non lues ; compte au retour dans l'app et après un test), avatar → Profil |
| `components/TiroirNotifications.tsx`, `PreferencesNotifications.tsx`, `ActivationPush.tsx` | tiroir de la cloche, préférences, « Sur ce téléphone » (v0.8.9) |
| `lib/notifications.ts` | **catalogue des notifications** (code, nom, moment, portée immeuble / véhicule, exemple) + lecture et comptage |
| `lib/push.ts` | Web Push côté téléphone (service worker, permission, abonnement) |
| `app/api/notifications/envoyer/route.ts` | seule route serveur : GET = Vercel Cron (calcul + envoi à tous), POST = envoi des tests de la personne connectée |
| `public/sw.js` | service worker : affiche la notification ; la toucher ouvre `/` sans la marquer lue |
| `components/FeuillePret.tsx`, `FeuilleReleve.tsx`, `FeuilleAssurance.tsx`, `FeuilleTaxes.tsx`, `FeuillePaiement.tsx` | feuilles (formulaires du bas) de la page Frais fixes |
| `lib/amortissement.ts` | capital / intérêts d'un prêt à taux fixe, composé semestriellement, versements mensuels |
| `lib/fraisFixes.ts` | types Frais fixes, intérêts de l'année (relevé prioritaire), statut des versements, totaux |
| `components/FormulaireBail.tsx` | formulaire partagé Nouveau bail / Modifier le bail (validation, paramètre `p` des RPC) ; questions avant d'enregistrer (mois passés, bail sans photo) (v0.9.4) |
| `components/DocumentsBail.tsx` | fiche du bail : une section de documents (bail signé, enquête de crédit, règlements) (v0.9.4) |
| `lib/documents.ts` | `DOCUMENTS_BAIL` (types, titres, textes) et `televerserDocument` (bucket + table documents) (v0.9.4) |
| `lib/baux.ts` | période de l'onglet Baux : années proposées, bail dans la période, libellé « 2024 à 2026 » ; `etatsBail`, `ETATS`, `lireEtats` (filtre d'état, v0.9.3) ; `LIBELLE_ORIGINE`, `TITRE_COPIE`, `chaineDe` (chaîne bail d'origine → renouvellements → cession, v0.9.5) |
| `components/FormulaireDepense.tsx` | formulaire partagé saisie/modification ; ordre : montant, fournisseur, catégorie, date, immeuble ou répartition |
| `components/ChoixFournisseur.tsx` | champ fournisseur avec menu (recherche sans accents, plus utilisés en premier) |
| `components/ConstructeurTrajet.tsx` | composer un trajet par lieux, distances retenues dans les deux sens |
| `lib/supabase.ts` | client Supabase, `BUCKET_RECUS = "recus"` |
| `lib/useSession.ts` | session et redirection vers la connexion |
| `lib/argent.ts` | cents, TPS 5 % / TVQ 9,975 % |
| `lib/dates.ts` | dates AAAA-MM-JJ, fin de bail, lendemain, fin du mois, `ajouterMois`, tri naturel des numéros |
| `lib/image.ts` | compression, miniature, EXIF, SHA-256 |
| `lib/periodes.ts` | périodes de filtre (mois, trimestre, année…) |
| `lib/repartition.ts` | répartition au cent près (méthode du plus fort reste) |
| `lib/csv.ts` | CSV pour Excel français (`;`, virgule décimale, BOM UTF-8) |
| `lib/exportDossier.ts` | dossier comptable : `depenses.xlsx` + `recus/` (+ véhicule sur une année complète) |
| `lib/exportBaux.ts` | dossier prêteur par période : `etat_des_loyers.xlsx` (un bail par ligne avec son type, onglets « Par année » et « Copies des baux ») + `baux/` avec la chaîne complète de chaque bail (`Gauthier_6_1-bail-2023_…`, `2-renouvellement-…`, `3-cession-…`) (v0.9.5) |
| `lib/vehicule.ts` | calcul du prorata (km immeubles / km totaux), segments de trajets |
| `lib/exportVehicule.ts` | onglets et reçus du véhicule (seul ou dans le dossier comptable) |
| `app/globals.css` | thème vert, clair et sombre (contrastes ≥ 7:1) |
| `public/` | icônes et manifeste (fournis par Loïc) |

---

## 5. Règles d'affaires et fiscales retenues

- **Dépenses** : catégories liées aux lignes du T776 ; nature « courante » ou « capital » (amortissable). Un fournisseur retient sa catégorie habituelle. Doublons détectés (même photo, ou même fournisseur + même numéro de facture).
- **Répartition** : par parts égales ou au prorata des logements (9/8/4), au cent près.
- **Changement de loyer** : s'applique d'un mois donné jusqu'à la fin du bail ; le passé et les paiements restent ; historique dans `changements_loyer`. Au Québec, une hausse en cours de bail demande l'accord écrit du locataire (entente à joindre dans « Bail signé »).
- **Crédit ponctuel** (ex. porte achetée par le locataire) : paiement de mode `credit` avec raison ; le loyer reste dû au complet (revenu brut intact) ; la dépense correspondante s'entre aussi dans Dépenses.
- **Crédit mensuel** (ex. tonte de pelouse −50 $) : extra négatif sur le bail ; le revenu est alors inscrit net (à signaler au comptable ; le rapport v1.0 devra l'afficher à part).
- **Période d'un bail** (onglet Baux, dossier prêteur) : un bail compte pour une année s'il en couvre au moins un jour (du début au départ, sinon à la fin, sinon sans fin) ; les baux à venir suivent l'année courante.
- **Modifier un bail** = correction d'une erreur de saisie : les montants dus de tous les mois sont recalculés, les paiements restent. Une hausse en cours de bail passe plutôt par « Modifier le prix du loyer ». Des mois qui sortiraient du bail avec des paiements bloquent la correction.
- **Remplacement** : nouveau bail qui chevauche un bail en cours (sans départ inscrit) → l'ancien se termine le dernier jour du mois avant le début du nouveau (`terminer_bail`, sans forfait, raison « Remplacé par un nouveau bail… »), dans la même transaction que la création. Le nouveau bail pointe vers l'ancien (`bail_precedent_id`).
- **Fin de bail** : `date_depart` inscrite, loyers futurs sans paiement retirés, forfait ajouté au dernier mois, suivi TAL arrêté ; bloqué si des paiements existent après le départ ; annulable tant qu'aucun nouveau bail n'occupe le logement.
- **Hypothèques** : prêts à taux fixe canadiens, intérêt composé deux fois par année ; taux par versement mensuel
  i = (1 + taux/2)^(2/12) − 1 ; intérêts = solde × i au cent ; les versements datés dans l'année comptent pour l'année.
  Rien n'est stocké : recalcul à partir du prêt. Le relevé annuel du prêteur a priorité (avertissement au-delà de 1 % d'écart).
  Total des intérêts = T776 ligne 8710 / TP-128. Un renouvellement = un nouveau terme (nouvelle ligne). Les versements
  hypothécaires ne vont pas dans Dépenses.
- **Assurances et taxes** : « Payé » inscrit la dépense dans Dépenses (catégorie 8690 ou 9180, immeuble du versement) en une
  transaction ; « Annuler » la retire (suppression douce). Assurance mensuelle : la dépense est la prime de l'année au complet.
- **Véhicule** : avec des immeubles sur au moins deux sites, les frais pour percevoir les loyers, superviser des travaux ou gérer sont déductibles **au prorata des km**. Frais entrés à 100 % ; part = frais × km immeubles / km totaux (compteur au 1er janvier et au 31 décembre, tolérance 31 jours) ; trajets « Plusieurs immeubles » répartis selon le nombre de logements ; ligne T776 **9281** dans le dossier comptable. La DPA (amortissement) n'est pas calculée : laissée au comptable.

---

## 6. Façon de travailler (important)

**Notifications : règle pour toute nouvelle notification (demande de Maxime, v0.8.9)**
- Toujours **titre** (l'action à faire) + **description** (ce que l'utilisateur doit faire).
- L'ajouter au `CATALOGUE` de `lib/notifications.ts` : elle apparaît alors automatiquement dans Profil >
  « Tester les notifications possibles » et dans « Préférences des notifications » (exclusion par type et par immeuble / véhicule).
- Le calcul va dans `alertes_du_jour()` (nouvelle migration, même code, `cible_id` = immeuble ou véhicule visé,
  `cle` unique pour ne jamais la créer deux fois). Les préférences sont appliquées par `generer_notifications()`.
- Une notification poussée sur iOS contient le titre et la description ; la toucher ouvre l'app à l'accueil et ne la marque pas lue.

**Livraison des mises à jour**
- Claude ne peut pas toujours installer les paquets npm ni compiler l'app : **Loïc compile et déploie**.
  (Les v0.8.6 à v0.8.9 ont été compilées avec succès par Claude, `npm run build`, avant la livraison.)
  Claude vérifie la syntaxe TypeScript, teste le SQL sur une copie locale et les calculs avec Node.
- Chaque mise à jour est livrée en **ZIP avec les fichiers déjà rangés dans leurs dossiers** et un
  `LISEZMOI_MISE_A_JOUR.txt` : quels fichiers, quel SQL, dans quel ordre. Loïc décompresse **à la racine du projet**
  par-dessus les fichiers existants, exécute le SQL s'il y en a, puis fait un commit sur `main`.
- **Ne jamais envoyer des `page.tsx` en vrac** : un mélange a déjà remplacé l'onglet Dépenses par l'écran Nouveau bail.
- Faire le travail sur le code **dans une seule conversation** (celle qui a les fichiers). Une autre conversation
  n'a pas les fichiers : elle doit partir de ce document et du ZIP complet le plus récent.
- Les bugs remontent par capture d'écran (Maxime transfère les messages de Loïc).

**iPhone : pièges connus**
- Le signet doit pointer vers le **domaine de production** Vercel, pas une URL de prévisualisation.
- Le clavier `inputMode="decimal"` n'a **pas de signe moins** : prévoir un bouton (ex. « − Ajouter un crédit »).
- `<datalist>` s'affiche mal : utiliser un menu maison (`ChoixFournisseur`).
- Champs `date` : correctif CSS de débordement déjà en place dans `globals.css`.
- L'aperçu Excel de l'iPhone n'évalue pas les formules (voir conventions).
- Pas de mode hors ligne : sans réseau, l'envoi échoue avec un message.

---

## 7. Limites connues

- Un fichier téléversé reste orphelin dans le bucket si l'enregistrement échoue ensuite (sans conséquence).
- Plafond de 1000 lignes par affichage dans la liste des dépenses (limite Supabase par défaut).
- Exports faits dans le navigateur : préférer un ordinateur pour une année complète avec beaucoup de reçus.
- Fin de bail en milieu de mois : le dernier loyer reste complet (ajuster avec un crédit).
- Les km ne se calculent pas à partir d'une carte : la distance entre deux lieux s'entre une fois à la main.

---

## 8. À faire

**Proposé à Maxime, en attente de réponse**
- Ajouter ou retirer un **extra / crédit mensuel sur un bail existant à partir d'un mois donné** (comme « Modifier le prix du loyer ») ;
  « Modifier le bail » (v0.8.7) corrige les extras sur tous les mois.
- (Fait en 0.8.7 : modification des coordonnées des locataires, via « Modifier le bail ».)

**À faire par Loïc (v0.8.9)**
- Exécuter `013_notifications.sql`, faire `npm install` (nouvelle dépendance `web-push`), puis configurer les 5 variables
  des notifications poussées dans Vercel (README > « Notifications poussées »). Sans elles, la cloche fonctionne mais rien n'arrive sur le téléphone.

**À faire par Loïc (v0.9.0)**
- Exécuter `014_vehicules_actifs.sql`. Ensuite, ouvrir Profil > Actifs > Véhicules > le véhicule existant et remplir
  marque, modèle, couleur, année (son nom affiché devient « marque modèle couleur »).

**À faire par Loïc (v0.9.1)**
- Exécuter `015_mois_payes.sql`. Sans elle, la case « mois passés payés » est ignorée sans message (l'ancienne `creer_bail` ne lit pas `mois_payes`).

**À faire par Loïc (v0.9.5)**
- Exécuter `018_cession_bail.sql`. Sans elle, l'historique d'un logement, « Modifier le bail », la cession et le dossier prêteur affichent une erreur (colonne `origine` ou fonction `ceder_bail` introuvable).

**Choix faits en 0.9.5** (demande de Maxime du 20 oct. : les banques veulent les baux en cours avec le bail d'origine,
la cession et les renouvellements). Chaîne = on remonte `bail_precedent_id` tant que le bail est un renouvellement ou une cession ;
un « nouveau » bail (même créé par remplacement, qui pose aussi `bail_precedent_id`) commence une nouvelle chaîne. Le dossier joint
la chaîne de chaque bail de la période, même si les baux précédents sont avant la période ; chaque copie n'est jointe qu'une fois.
Cession : prend effet le 1er d'un mois (les loyers sont mensuels) ; l'ancien bail se termine la veille (`terminer_bail`, mois et
paiements gardés à son nom), le nouveau reprend loyer du mois de la cession, fin, extras, mode, jour, inclusions et hausses déjà prévues.
Le type se corrige dans « Modifier le bail » (seulement si le bail suit un autre bail), par exemple pour une cession entrée avant 0.9.5
comme nouveau bail. Les photos « bail » d'un renouvellement s'appellent « Renouvellement signé », celles d'une cession « Entente de cession ».

**À faire par Loïc (v0.9.4)**
- Exécuter `017_documents_bail.sql`. Sans elle, les photos d'enquête de crédit et de règlements ne s'enregistrent pas
  (le bail, lui, s'enregistre ; un message dit que des pages n'ont pas pu être envoyées).

**Choix faits en 0.9.4** (demandes de Maxime du 19 oct.) : exemple « stationnement » ajouté au bouton « + Ajouter un extra »
(le champ l'avait déjà). Question des mois passés : Oui = tous les mois passés, sans exclusion (pour en exclure, cocher la case).
Alerte photos : seulement pour le bail signé (enquête et règlements restent facultatifs) ; pop-ups maison (pas `window.confirm`).
Enquête de crédit et règlements : pas dans le dossier du prêteur (renseignements personnels). Dépenses : graphique caché à
l'ouverture, non gardé dans l'adresse. Loyers : « dépôts faits » = paiements `recu` des loyers du mois affiché, sans `credit`
(rattachés au mois du loyer, pas à la date du dépôt) ; pas de migration pour ça.

**À faire par Loïc (v0.9.3)**
- Exécuter `016_renouveler_bail.sql`. Sans elle, « Renouveler » affiche une erreur (fonction introuvable) ; les filtres marchent sans.

**Choix faits en 0.9.3** : « relation faite » demandé par Maxime = l'état existant « Relocation faite ». États = `etatsBail` (lib/baux.ts),
plusieurs au choix ; « Actifs » inclut renouvelés, départ prévu et relocation faite. Filtre de logements : seulement avec un immeuble choisi,
plusieurs au choix. Renouvellement réservé à un bail actif avec date de fin et sans départ (un bail à durée indéterminée se reconduit seul) ;
durée en mois (12 par défaut), fin = `finApresMois`. Le nouveau bail reprend locataires, extras et crédits ; pour changer le reste,
« Modifier le bail » sur le nouveau bail. Supprimer le nouveau bail (erreur) réaffiche « Renouveler le bail » sur l'ancien.

**Choix faits en 0.9.2** (pas de migration) : graphiques maison en SVG (`components/Graphiques.tsx`, aucune librairie).
Dépenses : anneau des 5 plus grosses catégories + « Autres », barres par semaine (mode Mois) ou par mois (mode Année).
Baux : occupation = logements actifs avec un bail en cours ; loyers = loyer + extras des baux en cours ; barres = `v_soldes.montant_du_cents`
de chaque mois de la plus récente des années choisies ; l'encadré ignore le filtre d'immeuble. Loyers : « à encaisser » = somme des soldes
positifs du mois affiché. « Texter » ouvre Messages avec un rappel prérempli (format iPhone `sms:numéro&body=`) ; rien n'est envoyé
automatiquement (les textos automatiques restent reportés).

**Choix faits en 0.9.1** : « mois passés » = mois du bail dont le jour d'échéance est aujourd'hui ou avant (`moisEchus` dans lib/dates.ts,
même règle côté SQL). Paiements inscrits avec la note « Marqué payé à la création du bail » ; ils s'annulent un par un dans Loyers.
Prix le plus récent = `loyer_cents` du bail le plus récent du logement (inclut les changements de loyer), bouton « Reprendre ce prix ».
Filtre d'immeubles de Dépenses : par ligne de dépense (une dépense répartie montre seulement la part de l'immeuble choisi).

**Choix faits en 0.9.0** : « supprimer de partout » = suppression douce (`deleted_at`) avec confirmation (nom à écrire),
jamais d'effacement définitif. Les années futures sont permises dans l'onglet Véhicules. Rapport d'impôts : année courante par défaut.

**Feuille de route**
1. **v0.8.x** : série de chèques postdatés en un geste, confirmation des prélèvements, chèques sans provision, reçu pour paiement comptant.
2. **v0.9** : renouvellements TAL (envoi de l'avis, réponse du locataire, preuve) et suivi des logements vacants.
3. **v1.0** : rapport annuel par immeuble (revenus bruts, crédits, dépenses par ligne T776 / TP-128, véhicule, intérêts hypothécaires via `lib/fraisFixes.ts`), prêt pour le comptable.

**Recommandation en cours** : entrer les 21 baux et utiliser l'app pendant un mois de loyers avant d'entreprendre la v0.8.x.

---

## 9. Pour une nouvelle conversation avec Claude

Donner ce document **et** le ZIP complet le plus récent du projet (`gestion-immeubles-vX.zip`), puis demander :
> « Voici la passation et le code du projet. Lis PASSATION.md, puis [demande]. Livre les changements en ZIP
> rangé par dossiers avec un LISEZMOI_MISE_A_JOUR.txt, et la migration SQL suivante s'il y en a une. »
