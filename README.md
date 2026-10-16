# Gestion des immeubles — Module 1 (saisie des dépenses)

Application web progressive (PWA) : Next.js 15 + Supabase.
Version 0.2 : connexion, saisie rapide avec photo du reçu, liste, écran de détail (reçu plein écran, téléchargement), modification, complétion des brouillons, suppression.

## 1. Base de données

Dans Supabase > SQL Editor, exécuter dans l'ordre :

1. `supabase/001_module1_schema.sql` (déjà fait)
2. `supabase/002_enregistrer_depense.sql` — fonction qui enregistre l'en-tête, les lignes
   et les pièces jointes dans **une seule transaction** (obligatoire : la vérification
   « somme des lignes = total » s'exécute en fin de transaction).
3. `supabase/003_modifier_depense.sql` — même principe pour la modification
   (v0.2 : écran Modifier / Compléter).

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
| `app/login/page.tsx` | Connexion courriel + mot de passe (comptes créés dans Supabase) |
| `app/page.tsx` | Liste des 50 dernières lignes, total du mois, compteur de brouillons, bouton « + » |
| `app/nouvelle/page.tsx` | Nouvelle dépense (utilise le formulaire partagé) |
| `app/depense/[id]/page.tsx` | Détail : reçus (URL signées 10 min), plein écran, téléchargement, suppression douce |
| `app/depense/[id]/modifier/page.tsx` | Modifier une dépense ou compléter un brouillon |
| `components/FormulaireDepense.tsx` | Formulaire partagé saisie / modification |
| `lib/image.ts` | Compression (2000 px, JPEG 0,8), miniature 400 px, retrait EXIF/GPS, SHA-256 |
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

## Limites connues

- Une seule ligne par dépense dans l'interface (la répartition entre immeubles existe en base,
  pas encore à l'écran).
- Pas encore de filtres ni d'export CSV.
- Pas de mode hors ligne : sans réseau, l'envoi échoue avec un message.
- Si l'enregistrement échoue après l'envoi de la photo, le fichier reste orphelin dans le bucket
  (sans conséquence, à nettoyer plus tard).

## Prochaines étapes

1. Filtres (période, immeuble, catégorie) et export CSV à partir de `v_depenses_detail`.
2. Répartition d'une facture entre plusieurs immeubles.
3. File d'attente hors ligne (IndexedDB + service worker).
