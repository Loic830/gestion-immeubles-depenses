# Gestion des immeubles — Modules 1 (dépenses) et 2 (loyers)

Application web progressive (PWA) : Next.js 15 + Supabase.
Version 0.6 : Module 1 complet (dépenses) + début du Module 2 : barre d'onglets, baux et locataires, loyers dus générés automatiquement.

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
| `components/BarreOnglets.tsx` | Barre d'onglets du bas (Dépenses · Baux ; Loyers en v0.7) |
| `app/baux/page.tsx` | Les 21 logements par immeuble avec leur bail courant, taux d'occupation, alertes d'avis TAL |
| `app/baux/nouveau/page.tsx` | Nouveau bail : logement, colocataires, durée (12 mois / autre / indéterminée), loyer, extras, mode de paiement |
| `app/baux/[id]/page.tsx` | Fiche du bail : locataires (appeler / texto), conditions, fenêtre TAL, loyers dus et leur état |
| `lib/exportBaux.ts` | Dossier prêteur par immeuble : etat_des_loyers.xlsx (liens vers les baux, totaux mensuel et annuel) + dossier baux/ |
| `lib/dates.ts` | Dates AAAA-MM-JJ sans décalage de fuseau, fin de bail, tri naturel des numéros |
| `app/login/page.tsx` | Connexion courriel + mot de passe (comptes créés dans Supabase) |
| `app/page.tsx` | Liste filtrée (filtres gardés dans l'URL), totaux par catégorie, export CSV, bouton « + » |
| `lib/periodes.ts` | Calcul des périodes (mois, trimestre, année, dates précises) |
| `lib/exportDossier.ts` | Dossier comptable ZIP : depenses.xlsx (liens vers les reçus, onglet par catégorie) + dossier recus/ |
| `lib/csv.ts` | Export CSV pour Excel en français (séparateur « ; », virgule décimale, UTF-8 avec BOM) |
| `app/nouvelle/page.tsx` | Nouvelle dépense (utilise le formulaire partagé) |
| `app/depense/[id]/page.tsx` | Détail : reçus (URL signées 10 min), plein écran, téléchargement, suppression douce |
| `app/depense/[id]/modifier/page.tsx` | Modifier une dépense ou compléter un brouillon |
| `components/FormulaireDepense.tsx` | Formulaire partagé saisie / modification |
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

## Liste, filtres et export (v0.3)

- Période par défaut : cette année. Autres choix : ce mois-ci, mois dernier, trimestre,
  année dernière, tout, dates précises.
- Filtres : un ou plusieurs immeubles, une catégorie (une catégorie principale inclut
  ses sous-catégories), statut (complètes / brouillons).
- Les filtres sont gardés dans l'adresse : un lien ou un signet conserve la sélection.
- Totaux : total de la sélection, part en capital, répartition par catégorie principale.
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

## Limites connues

- Pas de mode hors ligne : sans réseau, l'envoi échoue avec un message.
- Si l'enregistrement échoue après l'envoi de la photo, le fichier reste orphelin dans le bucket
  (sans conséquence, à nettoyer plus tard).

## Prochaines étapes

1. v0.7 : onglet Loyers — loyers du mois, « Reçu » en un geste, paiements partiels, retards.
2. v0.8 : chèques postdatés, prélèvements, chèques sans provision, reçu pour comptant.
3. v0.9 : renouvellements TAL (envoi, réponse, preuve) et logements vacants.
4. v1.0 : rapport annuel par immeuble (revenus + dépenses), format T776 / TP-128.
