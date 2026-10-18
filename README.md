# Immeubles So-Max — gestion des immeubles

Application web progressive (PWA) : Next.js 15 + Supabase.
Version 0.8.8 : onglet Dépenses simplifié — récapitulatif en haut, navigation Mois / Année avec flèches (comme Loyers), filtres retirés. 0.8.7 : onglet Baux — filtre par années, dossier prêteur par période, historique d'un logement, modification d'un bail, remplacement d'un bail en cours. 0.8.6 : page Frais fixes (prêts hypothécaires avec capital / intérêts, assurances, taxes). 0.8.5 : en-tête « Immeubles So-Max », 5 onglets, page Profil et Actifs. Module 1 complet (dépenses) ; Module 2 : baux, copies de baux, dossier prêteur, onglet Loyers (« Reçu » en un geste, partiels, retards). Thème vert.

## 1. Base de données

Dans Supabase > SQL Editor, exécuter dans l'ordre :

1. `supabase/001_module1_schema.sql` (déjà fait)
2. `supabase/002_enregistrer_depense.sql` — fonction qui enregistre l'en-tête, les lignes
   et les pièces jointes dans **une seule transaction** (obligatoire : la vérification
   « somme des lignes = total » s'exécute en fin de transaction).
3. `supabase/003_modifier_depense.sql` — même principe pour la modification
   (v0.2 : écran Modifier / Compléter).
4. `supabase/004_module2_loyers.sql` — Module 2 : locataires, baux, extras, échéances,
   paiements, renouvellements, documents ; vues v_soldes et v_baux ; RPC creer_bail.
5. `supabase/005_changement_loyer_credits.sql` — changement de loyer en cours de bail
   (table `changements_loyer`, RPC `changer_loyer`) et crédits au locataire (mode `credit`).
6. `supabase/006_fin_de_bail.sql` — fin de bail anticipée : table `fins_bail`, RPC `terminer_bail`
   et `annuler_fin_bail`.
7. `supabase/007_vehicule.sql` — véhicule : véhicules, relevés du compteur, trajets fréquents,
   journal de bord (déplacements) et frais du véhicule.
9. `supabase/009_credits_mensuels.sql` — extras négatifs = crédits récurrents (ex. tonte de pelouse −50 $/mois).
8. `supabase/008_lieux_distances.sql` — lieux (Maison + immeubles, puis Rona, BMR…) et distances
   entre deux lieux, pour composer des trajets.
10. `supabase/010_profil_actifs.sql` — valeur d'achat et vente d'un immeuble (v0.8.5).
11. `supabase/011_frais_fixes.sql` — Frais fixes : hypotheques, hypotheque_releves, assurances, taxes_versements ;
    RPC `payer_frais_fixe` / `annuler_paiement_frais_fixe` ; la table documents accepte la police d'assurance (v0.8.6).
12. `supabase/012_modifier_bail.sql` — RPC `modifier_bail` (corriger tous les détails d'un bail) et
    `creer_bail_en_remplacement` (termine le bail en cours, puis crée le nouveau) ; `documents.deleted_at` (v0.8.7).

## 2. Lancer en local

```bash
cp .env.local.example .env.local   # puis coller l'URL et la clé anon (bouton « Connect » dans Supabase)
npm install
npm run dev                        # http://localhost:3000
```

Pour tester la caméra sur l'iPhone, il faut HTTPS : le plus simple est de déployer (étape 3).

## 3. Déployer (Vercel, gratuit)

1. Pousser le dossier sur un dépôt GitHub privé.
2. Vercel > Add New Project > importer le dépôt.
3. Ajouter les variables `NEXT_PUBLIC_SUPABASE_URL` et `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
4. Deploy. Sur l'iPhone : ouvrir l'URL dans Safari > Partager > « Sur l'écran d'accueil ».

## Structure

| Fichier | Rôle |
| --- | --- |
| `components/BarreOnglets.tsx` | Barre d'onglets du bas : Loyers · Baux · Frais fixes · Dépenses · Véhicule |
| `components/EnTete.tsx` | En-tête fixe : « Immeubles So-Max », cloche (tiroir de notifications), avatar → Profil |
| `app/profil/page.tsx` | Profil : nom, cellulaire, courriel, mot de passe, déconnexion ; Actifs (immeubles, ajout, vendus) |
| `app/profil/immeubles/[id]/page.tsx` | Détail d'un immeuble : adresse, achat, logements (numéros, ajout, désactivation), vente |
| `app/frais-fixes/page.tsx` | Frais fixes : une carte par immeuble (Hypothèque, Assurances, Taxes), sélecteur d'année, totaux |
| `components/FeuillePret.tsx` | Ajouter, modifier, renouveler (nouveau terme) ou retirer un prêt |
| `components/FeuilleReleve.tsx` | Intérêts selon le relevé annuel du prêteur (a priorité sur le calcul) |
| `components/FeuilleAssurance.tsx` | Police d'assurance (terme, prime, PDF dans documents) ; renouvellement |
| `components/FeuilleTaxes.tsx` | Compte de taxes foncières ou scolaires et ses versements |
| `components/FeuillePaiement.tsx` | « Payé » : date + dépense correspondante dans Dépenses (RPC payer_frais_fixe) |
| `lib/amortissement.ts` | Ventilation capital / intérêts : taux fixe composé semestriellement, versements mensuels |
| `lib/fraisFixes.ts` | Types, intérêts de l'année (relevé prioritaire), statuts des versements, totaux par immeuble |
| `app/loyers/page.tsx` | Loyers du mois par immeuble, retards (tous mois), feuille « Reçu » / partiel / annulation |
| `app/baux/page.tsx` | Les 21 logements par immeuble avec les baux des années choisies, filtres (années, immeuble, recherche), occupation, alertes d'avis TAL |
| `app/baux/nouveau/page.tsx` | Nouveau bail (formulaire partagé) ; pop-up si un bail couvre déjà la période (remplacement) |
| `app/baux/[id]/page.tsx` | Fiche du bail : locataires (appeler / texto), conditions, fenêtre TAL, loyers dus ; « Modifier le bail », « Historique » |
| `app/baux/[id]/modifier/page.tsx` | Modifier le bail : tous les détails (RPC modifier_bail) |
| `app/baux/logement/[id]/page.tsx` | Historique de tous les baux d'un logement |
| `components/FormulaireBail.tsx` | Formulaire partagé Nouveau bail / Modifier le bail |
| `lib/baux.ts` | Période de l'onglet Baux : années proposées, bail dans la période, libellé « 2024 à 2026 » |
| `lib/exportBaux.ts` | Dossier prêteur par immeuble et par période : etat_des_loyers.xlsx (un bail par ligne, loyers dus et reçus de la période, onglet « Par année ») + dossier baux/ |
| `app/vehicule/page.tsx` | Onglet Véhicule : trajets (favoris, motif), frais (reçu), compteur, résumé du prorata, export |
| `components/ConstructeurTrajet.tsx` | Composer un trajet par lieux ; distances retenues dans les deux sens |
| `lib/vehicule.ts` | Calcul du prorata : km immeubles / km totaux, part déductible et répartition par immeuble |
| `lib/exportVehicule.ts` | Dossier véhicule : vehicule_AAAA.xlsx (résumé, journal de bord, frais avec liens) + recus/ |
| `lib/dates.ts` | Dates AAAA-MM-JJ sans décalage de fuseau, fin de bail, tri naturel des numéros |
| `app/login/page.tsx` | Connexion courriel + mot de passe (comptes créés dans Supabase) |
| `app/page.tsx` | Récapitulatif, navigation Mois / Année (gardée dans l'URL), liste, exports, bouton « + » |
| `lib/periodes.ts` | Ancien calcul des périodes (plus utilisé depuis v0.8.8) |
| `lib/exportDossier.ts` | Dossier comptable ZIP : depenses.xlsx (liens vers les reçus, onglet par catégorie) + dossier recus/ |
| `lib/csv.ts` | Export CSV pour Excel en français (séparateur « ; », virgule décimale, UTF-8 avec BOM) |
| `app/nouvelle/page.tsx` | Nouvelle dépense (utilise le formulaire partagé) |
| `app/depense/[id]/page.tsx` | Détail : reçus (URL signées 10 min), plein écran, téléchargement, suppression douce |
| `app/depense/[id]/modifier/page.tsx` | Modifier une dépense ou compléter un brouillon |
| `components/FormulaireDepense.tsx` | Formulaire partagé saisie / modification |
| `components/ChoixFournisseur.tsx` | Champ fournisseur : menu déroulant avec recherche dans l'historique |
| `lib/image.ts` | Compression (2000 px, JPEG 0,8), miniature 400 px, retrait EXIF/GPS, SHA-256 |
| `lib/repartition.ts` | Répartition d'un montant au cent près (parts égales ou au prorata des logements) |
| `lib/argent.ts` | Montants en cents, décomposition TPS (5 %) / TVQ (9,975 %) |
| `supabase/002_enregistrer_depense.sql` | Fonction RPC d'enregistrement atomique |
| `supabase/003_modifier_depense.sql` | Fonction RPC de modification atomique (lignes remplacées, reçus ajoutés) |

## Fonctionnement de l'écran de saisie

- « Prendre une photo » ouvre la caméra arrière ; « + Page » pour une facture de plusieurs pages ;
  « Fichier ou PDF » pour les factures reçues par courriel.
- La photo est traitée sur le téléphone avant l'envoi : environ 300 à 600 Ko par reçu.
- Avertissement si la même photo a déjà été téléversée (empreinte SHA-256).
- Le dernier immeuble utilisé est présélectionné.
- Le fournisseur est créé à la volée s'il est nouveau ; il « retient » la catégorie choisie
  la première fois et la propose ensuite.
- « Photo seulement » enregistre un brouillon (immeuble obligatoire, le reste peut attendre).
- Fichiers stockés dans le bucket privé `recus` sous `AAAA/MM/<uuid>.jpg` (+ `_min.jpg`).

## Écran de détail (v0.2)

- Toucher une dépense dans la liste ouvre son détail.
- Toucher un reçu l'affiche en plein écran ; « Ouvrir (zoom) » ouvre l'original pour zoomer ;
  « Télécharger » récupère le fichier. Les PDF s'ouvrent directement.
- « Modifier » / « Compléter » réutilise le formulaire ; on peut y ajouter des pages au reçu.
  Les reçus existants ne sont jamais retirés.
- « Supprimer » est une suppression douce (`deleted_at`) : la dépense disparaît des listes
  et des totaux, mais les données et les reçus restent en base.

## Liste et export (v0.3, navigation revue en v0.8.8)

- En haut : récapitulatif de la période (total, nombre de brouillons à compléter, part en capital,
  répartition par catégorie principale) et les boutons d'export.
- Plus bas : boutons « Mois » et « Année », puis flèches ‹ › comme dans l'onglet Loyers.
  Par défaut : le mois courant. En mode Année : l'année civile entière (1er janv. au 31 déc.), année courante par défaut.
  « Revenir au mois courant » / « Revenir à l'année courante » quand on s'en éloigne.
- Passer de Mois à Année garde l'année du mois affiché ; revenir à Mois ouvre le mois courant
  (si c'est l'année courante), sinon janvier de l'année affichée.
- La période est gardée dans l'adresse : `/?m=2026-09` (un mois) ou `/?a=2025` (une année) ; `/` = mois courant.
- Les anciens filtres (immeubles, catégorie, statut, dates précises) sont retirés en v0.8.8 ;
  `lib/periodes.ts` n'est plus utilisé.
- « Exporter en CSV » : une ligne par ligne de dépense, avec la ligne T776, prête pour Excel.
- Plafond : 1000 lignes par affichage (limite Supabase par défaut) ; un avis s'affiche si atteint.

## Dossier comptable (v0.4)

Bouton « Exporter Excel + reçus (ZIP) » : exporte la sélection affichée (mêmes filtres).

```
dossier_depenses_2026-01-01_2026-12-31.zip
├── depenses.xlsx          ← onglet « Dépenses » (lien cliquable vers chaque reçu, total)
│                             onglet « Par catégorie » (totaux par ligne T776, courante / capital)
├── recus/
│   ├── 2026-10-16_Simplex_384,13.jpg
│   ├── 2026-07-10_BMR_13,03_p1.jpg   ← facture de plusieurs pages
│   └── ...
├── LISEZMOI.txt
└── RECUS_MANQUANTS.txt    ← seulement si un fichier n'a pas pu être téléchargé
```

- Les liens sont relatifs : **décompresser le ZIP** avant d'ouvrir depenses.xlsx.
- Les noms de fichiers sont sans accents ni caractères spéciaux (compatibles Windows, Mac, iPhone).
- ExcelJS et JSZip sont chargés seulement au clic (l'application reste légère).
- Tout se fait dans le navigateur : à privilégier sur ordinateur pour une année complète.

## Répartition entre immeubles (v0.5)

- Dans le formulaire : « + Répartir entre plusieurs immeubles » sous les boutons d'immeuble.
- Chaque ligne a son immeuble, son montant, sa catégorie et (facultatif) son logement.
- Raccourcis : « Parts égales » ou « Selon nb de logements » (ex. 9 / 8 / 4) ; la méthode du
  plus fort reste garantit que la somme des lignes égale le total au cent près.
- Indicateur « Reste à répartir » ; l'enregistrement « complète » est bloqué tant que ça ne balance pas
  (et la base le vérifie aussi).
- Une dépense déjà répartie s'ouvre en mode répartition dans « Modifier ».
- Dans la liste, les filtres et les exports, chaque ligne compte pour son immeuble.

## Baux (v0.6)

- Onglet « Baux » : chaque logement avec son bail actif (ou à venir) ; « Vacant » si aucun bail,
  toucher pour en créer un avec le logement déjà choisi.
- « Nouveau bail » appelle la fonction `creer_bail` : bail, locataires, extras, loyers dus
  (un par mois) et fenêtre d'avis TAL sont créés dans une seule transaction.
- Durée « 12 mois » : la fin est calculée (1er juillet → 30 juin). « Indéterminée » : les loyers
  dus se prolongent à chaque ouverture de l'onglet (`prolonger_echeances`).
- Deux baux qui se chevauchent sur le même logement sont refusés (contrainte d'exclusion).
- La suppression d'un bail est réservée aux erreurs de saisie (suppression douce).
- Fiche du bail : « Photo du bail » (plusieurs pages) ou « Fichier ou PDF » ; fichiers compressés
  comme les reçus, stockés dans le bucket privé sous `baux/AAAA/MM/`, table `documents` (type `bail`).
- « Dossier prêteur » (par immeuble, onglet Baux) : ZIP avec `etat_des_loyers.xlsx` (un logement
  par ligne, vacants inclus, loyer + extras, totaux mensuel et annuel, lien vers la copie du bail)
  et le dossier `baux/` (ex. `Gauthier_6_Tremblay_p1.jpg`). Décompresser avant d'ouvrir l'Excel.

## Loyers (v0.7)

- Onglet « Loyers » : mois courant par défaut, flèches ‹ › pour changer de mois (gardé dans l'adresse `?m=AAAA-MM`).
- En haut : encaissé sur dû, avec barre de progression ; section « En retard » (tous mois confondus,
  du plus ancien au plus récent) avec bouton « Appeler ».
- Toucher un logement ouvre une feuille : montant (solde restant), mode (celui du bail), date reçue, référence.
  Montant = solde → bouton « Reçu » ; sinon « Enregistrer ce montant » (paiement partiel).
- Les paiements déjà enregistrés sont listés dans la feuille ; « Annuler » = suppression douce (erreur de saisie).
- Paiements insérés directement dans `paiements` (statut `recu`) ; `v_soldes` calcule soldes et retards.

## Véhicule (v0.8)

- Onglet « Véhicule » (5e onglet). Premier usage : nommer le véhicule, puis inscrire le compteur.
- Trajet : immeuble (ou « Plusieurs »), km aller-retour, date, motif obligatoire (puces ou texte),
  destination ; « Garder comme trajet fréquent » crée un raccourci en un toucher.
- « Composer un trajet » : toucher les lieux dans l'ordre (Maison → Gauthier → Rona → Gauthier → Maison) ;
  chaque distance entre deux lieux s'entre une fois et sert ensuite dans les deux sens. « Garder comme fréquent »
  crée le raccourci sans inscrire de trajet ; « Utiliser maintenant » remplit le formulaire.
- Frais : montant complet (100 %), type (essence, entretien, assurance, SAAQ, intérêts, location, autre),
  photo du reçu (bucket `recus`, dossier `vehicule/`).
- Compteur : relevés datés ; début = relevé le plus proche du 1er janvier, fin = le plus proche du 31 décembre
  (tolérance 31 jours), sinon premier et dernier de l'année (« à ce jour »).
- % = km du journal / km du compteur ; part déductible = frais × % ; répartie par immeuble selon ses km,
  les trajets « Plusieurs » selon le nombre de logements.
- Export par année : vehicule_AAAA.xlsx (Résumé, Journal de bord, Frais) + reçus. La DPA est laissée au comptable.
- Dossier comptable (onglet Dépenses) en mode Année : une ligne « Frais de véhicule (part immeubles) » par immeuble (T776 ligne 9281) dans
  depenses.xlsx, comprise dans les totaux et « Par catégorie », + onglets « Véhicule - … » et dossier recus_vehicule/.

## En-tête, navigation et Profil (v0.8.5)

- En-tête vert fixe sur toutes les pages sauf la connexion : « Immeubles So-Max » à gauche,
  cloche puis avatar (initiales) à droite. La cloche ouvre le tiroir de notifications (alertes en v0.8.9).
- Onglets du bas, dans l'ordre : Loyers · Baux · Frais fixes · Dépenses · Véhicule.
- La déconnexion est dans le Profil (retirée de la page Dépenses).
- Profil > Mon compte : nom et cellulaire gardés dans le compte Supabase (`user_metadata`) ;
  un changement de courriel demande la confirmation par lien ; changement du mot de passe.
- Profil > Actifs : immeubles actifs (puis vendus, sur demande) ; « + Ajouter » crée l'immeuble et ses
  logements numérotés 1..n. Penser à ajouter aussi le lieu dans Véhicule pour les trajets.
- Détail d'un immeuble : nom, adresse, date et valeur d'achat ; numéros de logement modifiables
  (les baux, loyers et dépenses suivent, car ils pointent vers l'identifiant) ; ajout et désactivation
  de logements (refusée s'il y a un bail en cours ou à venir) ; `nb_logements` est tenu à jour.
- « Marquer comme vendu » : date et prix de vente, `actif = false` ; l'immeuble disparaît des nouvelles
  saisies mais reste dans l'historique. « Annuler la vente » corrige une erreur.

## Frais fixes (v0.8.6)

- Onglet « Frais fixes » : sélecteur d'année (gardé dans l'adresse `?a=2026`), résumé des frais de l'année par immeuble,
  puis une carte par immeuble : Hypothèque, Assurances, Taxes. Depuis Profil > immeuble, « Frais fixes » ouvre
  la page sur cet immeuble seulement (`?i=<id>`).
- **Prêts** : plusieurs par immeuble ; tous à taux fixe, versements mensuels. Champs : solde au début du terme, taux,
  début et fin du terme, premier versement, amortissement restant (sert à vérifier le versement), versement du prêteur.
  Un renouvellement crée un nouveau terme (« Renouveler le terme », proposé 180 jours avant la fin) ; l'ancien reste
  pour les intérêts des années passées.
- **Calcul** (`lib/amortissement.ts`, rien n'est stocké) : taux par versement i = (1 + taux/2)^(2/12) − 1 ;
  intérêts = solde × i (au cent), capital = versement − intérêts. Les versements datés dans l'année comptent pour l'année.
  Vérifié : 100 000 $ à 5 % sur 25 ans → 581,60 $ par mois.
- **Relevé du prêteur** : intérêts de l'année selon le relevé ; il a priorité sur le calcul (avertissement si l'écart
  dépasse 1 %). Total des intérêts = T776 ligne 8710 (et TP-128).
- **Assurances** : une ligne par terme de police (assureur, police, prime annuelle, début, renouvellement, annuel ou
  mensuel, PDF ou photo de la police dans `documents`, dossier `assurances/` du bucket). « Renouveler » préremplit la
  police suivante (proposé 60 jours avant).
- **Taxes** : « + Ajouter un compte de taxes » : foncières ou scolaires, total, nombre de versements et première échéance ;
  les versements sont préparés (parts égales, aux 3 mois) puis ajustables. Statut calculé : à payer, en retard, payé.
- **Payé** (taxes et assurances) : date du paiement et, coché par défaut, la dépense correspondante est inscrite dans
  Dépenses (complète, catégorie « Taxes foncières et scolaires » 9180 ou « Assurances » 8690, fournisseur proposé :
  Ville d'Alma, Taxe scolaire ou l'assureur). « Annuler » retire aussi cette dépense (suppression douce).
  Les versements hypothécaires ne vont pas dans Dépenses : seuls les intérêts calculés comptent.
- Total des frais fixes de l'année : intérêts retenus + primes des polices qui commencent dans l'année + taxes de l'année.

## Baux : période, historique, modification (v0.8.7)

- **Période** : puces d'années en haut de l'onglet Baux (année courante à année courante − 6), une ou plusieurs ;
  par défaut l'année courante. Gardée dans l'adresse (`?a=2026,2025`), avec le filtre d'immeuble (`&i=<id>`).
  Un bail fait partie de la période s'il couvre au moins un jour d'une année choisie ; les baux à venir suivent l'année courante.
  Recherche par locataire (sans accents) ou numéro de logement.
- **Dossier prêteur** : le bouton affiche la période (ex. « 2024 à 2026 ») et le ZIP ne contient que les baux de la période
  (`dossier_preteur_Gauthier_2024-2026.zip`). Excel : un bail par ligne (statut, début, fin réelle, loyer, extras, mois dans la
  période, loyers dus et reçus dans la période), logements sans bail inclus, total de la période, revenu mensuel des baux en cours ;
  onglet « Par année » (dus, reçus, mois loués, taux d'occupation). Totaux avec `result` (aperçu iPhone).
- **Historique** : sur la fiche du bail, bouton « Historique (n) » → tous les baux du logement, du plus récent au plus ancien.
- **Modifier le bail** : logement, locataires (coordonnées, ajout, retrait, principal), dates, durée, loyer, extras et crédits,
  mode, jour, inclusions, notes. RPC `modifier_bail` en une transaction : mois hors des nouvelles dates retirés (refusé s'ils ont des
  paiements), mois manquants créés, montants dus recalculés (paiements intacts), fenêtre TAL recalculée. Si le loyer a déjà été
  changé (« Changer le loyer »), le champ corrige le loyer du début et les changements restent appliqués.
- **Pages du bail** : × sur une vignette retire une page ajoutée par erreur (suppression douce, `documents.deleted_at`).
- **Remplacement** : en enregistrant un nouveau bail, si un bail couvre déjà la période sur ce logement, un pop-up propose de
  mettre fin à l'ancien bail le dernier jour du mois avant le début du nouveau (ex. nouveau bail le 1er décembre → ancien terminé
  le 30 novembre). « Oui » appelle `creer_bail_en_remplacement` : `terminer_bail` + `creer_bail` dans une seule transaction
  (refusé s'il y a des paiements après cette date ; rien n'est enregistré). « Non » n'enregistre rien.

## Thème

- Vert `#1b4d34` (icône et barre d'état) ; mode sombre `#7cc49a`. Contrastes du texte ≥ 7:1.
- Icônes et manifeste fournis par Loïc (dossier `public/`, icône « maskable » incluse).

## Correctifs

- 0.7.1 : photo du bail directement dans « Nouveau bail ».
- 0.7.2 : totaux visibles dans l'aperçu Excel de l'iPhone (résultats des formules enregistrés dans le fichier).
- 0.7.3 : fournisseur avec menu déroulant (recherche sans accents, les plus utilisés en premier, « + Nouveau fournisseur »).
- 0.7.4 : « Changer le loyer » sur la fiche du bail (à partir d'un mois, jusqu'à la fin ; passé et paiements intacts, historique gardé) ;
  « Crédit au locataire » dans la feuille de paiement (montant + raison obligatoire ; le loyer reste dû au complet).
- 0.7.5 : « Terminer le bail (départ du locataire) » : date de départ, montant forfaitaire ajouté au dernier mois, raison ;
  loyers futurs retirés, historique gardé ; « Entrer le nouveau bail » (logement et date préremplis) ; autres baux du logement.
- 0.8.3 : formulaire de dépense : fournisseur, catégorie et date restent en place en mode répartition
  (l'immeuble et la répartition viennent après la date) ; la catégorie du haut s'applique à toutes les lignes.
- 0.8.4 : « − Ajouter un crédit » dans Nouveau bail : crédit déduit chaque mois (montant négatif dans bail_extras) ;
  le total dû du mois ne peut pas être négatif.

## Limites connues

- Pas de mode hors ligne : sans réseau, l'envoi échoue avec un message.
- Si l'enregistrement échoue après l'envoi de la photo, le fichier reste orphelin dans le bucket
  (sans conséquence, à nettoyer plus tard).

## Prochaines étapes

1. v0.8.9 : centre de notifications (rappels de refinancement, assurances, taxes, avis TAL).
2. v0.8.x : chèques postdatés, prélèvements, chèques sans provision, reçu pour comptant.
3. v0.9 : renouvellements TAL (envoi, réponse, preuve) et logements vacants.
4. v1.0 : rapport annuel par immeuble (revenus + dépenses + intérêts hypothécaires de Frais fixes), format T776 / TP-128.
