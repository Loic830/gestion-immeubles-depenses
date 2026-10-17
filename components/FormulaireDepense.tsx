"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { supabase, BUCKET_RECUS } from "@/lib/supabase";
import { useSession } from "@/lib/useSession";
import { preparerFichier, cleStockage, type FichierPrepare } from "@/lib/image";
import { versCents, formatCents, centsVersSaisie, decomposerTaxes } from "@/lib/argent";
import { repartirEgalement, repartirSelonPoids } from "@/lib/repartition";
import ChoixFournisseur, { normaliser, type FournisseurOption } from "@/components/ChoixFournisseur";

type Immeuble = { id: string; nom: string; nb_logements: number | null };
type Logement = { id: string; immeuble_id: string; numero: string };
type Categorie = { id: string; nom: string; parent_id: string | null; nature_defaut: "courante" | "capital"; ordre: number };
type Fournisseur = { id: string; nom: string; categorie_defaut_id: string | null };
type ModePaiement = { id: string; nom: string };
type PieceExistante = { id: string; mime_type: string; apercuUrl: string | null };
/** Une ligne de ventilation en mode « répartie » */
type LigneForm = { cle: string; immeubleId: string; logementId: string; categorieId: string; montantSaisi: string };

type DepenseExistante = {
  id: string;
  statut: "brouillon" | "complete";
  date_facture: string;
  no_facture: string | null;
  sous_total_cents: number | null;
  tps_cents: number;
  tvq_cents: number;
  total_cents: number | null;
  notes: string | null;
  mode_paiement_id: string | null;
  fournisseur: { nom: string } | null;
  lignes: { immeuble_id: string; logement_id: string | null; categorie_id: string | null; montant_cents: number | null }[];
  pieces: { id: string; storage_key: string; miniature_key: string | null; mime_type: string }[];
};

const CLE_DERNIER_IMMEUBLE = "dernier-immeuble";

function aujourdHui() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function lireStockageLocal(cle: string): string | null {
  try { return localStorage.getItem(cle); } catch { return null; }
}
function ecrireStockageLocal(cle: string, valeur: string) {
  try { localStorage.setItem(cle, valeur); } catch { /* navigation privée : sans importance */ }
}

/** Formulaire de saisie. Sans depenseId : nouvelle dépense. Avec : modification / complétion d'un brouillon. */
export default function FormulaireDepense({ depenseId }: { depenseId?: string }) {
  const router = useRouter();
  const { session, pret } = useSession();
  const modeModification = Boolean(depenseId);

  // Listes de référence
  const [immeubles, setImmeubles] = useState<Immeuble[]>([]);
  const [logements, setLogements] = useState<Logement[]>([]);
  const [categories, setCategories] = useState<Categorie[]>([]);
  const [fournisseurs, setFournisseurs] = useState<Fournisseur[]>([]);
  const [modes, setModes] = useState<ModePaiement[]>([]);

  // Formulaire
  const [fichiers, setFichiers] = useState<FichierPrepare[]>([]);
  const [piecesExistantes, setPiecesExistantes] = useState<PieceExistante[]>([]);
  const [totalSaisi, setTotalSaisi] = useState("");
  const [immeubleId, setImmeubleId] = useState<string>("");
  const [fournisseurNom, setFournisseurNom] = useState("");
  const [usageFournisseurs, setUsageFournisseurs] = useState<Map<string, { n: number; dernier: string }>>(new Map());
  const optionsFournisseurs = useMemo<FournisseurOption[]>(
    () => fournisseurs.map((f) => ({
      id: f.id, nom: f.nom,
      utilisations: usageFournisseurs.get(f.id)?.n ?? 0,
      dernier: usageFournisseurs.get(f.id)?.dernier ?? null,
    })),
    [fournisseurs, usageFournisseurs],
  );
  const [categorieId, setCategorieId] = useState("");
  const [categorieTouchee, setCategorieTouchee] = useState(false);
  const [dateFacture, setDateFacture] = useState(aujourdHui());
  const [logementId, setLogementId] = useState("");
  const [sousTotalSaisi, setSousTotalSaisi] = useState("");
  const [tpsSaisie, setTpsSaisie] = useState("");
  const [tvqSaisie, setTvqSaisie] = useState("");
  const [modeId, setModeId] = useState("");
  const [noFacture, setNoFacture] = useState("");
  const [notes, setNotes] = useState("");

  // État
  const [statutInitial, setStatutInitial] = useState<"brouillon" | "complete" | null>(null);
  const [repartie, setRepartie] = useState(false);
  const [lignesForm, setLignesForm] = useState<LigneForm[]>([]);
  const [chargement, setChargement] = useState(true);
  const [traitement, setTraitement] = useState(false);
  const [envoi, setEnvoi] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const [avertissementDoublon, setAvertissementDoublon] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);

  const champPhoto = useRef<HTMLInputElement>(null);
  const champFichier = useRef<HTMLInputElement>(null);

  // Chargement des listes (+ de la dépense en mode modification)
  useEffect(() => {
    if (!session) return;
    (async () => {
      const [im, lo, ca, fo, mo, us] = await Promise.all([
        supabase.from("immeubles").select("id, nom, nb_logements").is("deleted_at", null).eq("actif", true).order("nom"),
        supabase.from("logements").select("id, immeuble_id, numero").is("deleted_at", null).eq("actif", true).order("numero"),
        supabase.from("categories").select("id, nom, parent_id, nature_defaut, ordre").is("deleted_at", null).eq("actif", true).order("ordre"),
        supabase.from("fournisseurs").select("id, nom, categorie_defaut_id").is("deleted_at", null).order("nom"),
        supabase.from("modes_paiement").select("id, nom").eq("actif", true).order("nom"),
        // Historique : sert à classer les fournisseurs du menu (les plus utilisés en premier).
        supabase.from("depenses").select("fournisseur_id, date_facture").is("deleted_at", null)
          .not("fournisseur_id", "is", null).order("date_facture", { ascending: false }).limit(1000),
      ]);
      const premiereErreur = [im, lo, ca, fo, mo].find((r) => r.error)?.error;
      if (premiereErreur) { setErreur(premiereErreur.message); setChargement(false); return; }
      setImmeubles((im.data ?? []) as Immeuble[]);
      setLogements((lo.data ?? []) as Logement[]);
      setCategories((ca.data ?? []) as Categorie[]);
      setFournisseurs((fo.data ?? []) as Fournisseur[]);
      const usage = new Map<string, { n: number; dernier: string }>();
      for (const u of (us.data ?? []) as { fournisseur_id: string; date_facture: string }[]) {
        const x = usage.get(u.fournisseur_id);
        if (x) x.n++;
        else usage.set(u.fournisseur_id, { n: 1, dernier: u.date_facture });
      }
      setUsageFournisseurs(usage);
      setModes((mo.data ?? []) as ModePaiement[]);

      if (!depenseId) {
        const dernier = lireStockageLocal(CLE_DERNIER_IMMEUBLE);
        if (dernier && (im.data ?? []).some((i) => i.id === dernier)) setImmeubleId(dernier);
        setChargement(false);
        return;
      }

      const { data, error } = await supabase
        .from("depenses")
        .select(`id, statut, date_facture, no_facture, sous_total_cents, tps_cents, tvq_cents, total_cents, notes, mode_paiement_id,
                 fournisseur:fournisseurs(nom),
                 lignes:depense_lignes(immeuble_id, logement_id, categorie_id, montant_cents),
                 pieces:pieces_jointes(id, storage_key, miniature_key, mime_type)`)
        .eq("id", depenseId)
        .is("deleted_at", null)
        .single();
      if (error || !data) { setErreur("Dépense introuvable."); setChargement(false); return; }
      const d = data as unknown as DepenseExistante;

      setStatutInitial(d.statut);
      setTotalSaisi(centsVersSaisie(d.total_cents));
      setFournisseurNom(d.fournisseur?.nom ?? "");
      setDateFacture(d.date_facture);
      setNoFacture(d.no_facture ?? "");
      setNotes(d.notes ?? "");
      setModeId(d.mode_paiement_id ?? "");
      if (d.sous_total_cents !== null) {
        setSousTotalSaisi(centsVersSaisie(d.sous_total_cents));
        setTpsSaisie(centsVersSaisie(d.tps_cents));
        setTvqSaisie(centsVersSaisie(d.tvq_cents));
      }
      const premiere = d.lignes[0];
      if (premiere) {
        setImmeubleId(premiere.immeuble_id);
        setLogementId(premiere.logement_id ?? "");
        setCategorieId(premiere.categorie_id ?? "");
        setCategorieTouchee(Boolean(premiere.categorie_id));
      }
      if (d.lignes.length > 1) {
        setRepartie(true);
        setLignesForm(d.lignes.map((l) => ({
          cle: crypto.randomUUID(),
          immeubleId: l.immeuble_id,
          logementId: l.logement_id ?? "",
          categorieId: l.categorie_id ?? "",
          montantSaisi: centsVersSaisie(l.montant_cents),
        })));
      }

      // Aperçus des reçus déjà enregistrés (URL signées, valides 10 min)
      const chemins = d.pieces.map((p) => p.miniature_key ?? p.storage_key).filter((c) => !c.endsWith(".pdf"));
      const urls = chemins.length
        ? (await supabase.storage.from(BUCKET_RECUS).createSignedUrls(chemins, 600)).data ?? []
        : [];
      setPiecesExistantes(
        d.pieces.map((p) => ({
          id: p.id,
          mime_type: p.mime_type,
          apercuUrl: urls.find((u) => u.path === (p.miniature_key ?? p.storage_key))?.signedUrl ?? null,
        }))
      );
      setChargement(false);
    })();
  }, [session, depenseId]);

  // Catégorie habituelle du fournisseur
  useEffect(() => {
    if (categorieTouchee) return;
    const f = fournisseurs.find((x) => normaliser(x.nom) === normaliser(fournisseurNom));
    if (f?.categorie_defaut_id) setCategorieId(f.categorie_defaut_id);
  }, [fournisseurNom, fournisseurs, categorieTouchee]);

  const totalCents = versCents(totalSaisi);
  const categoriesPrincipales = useMemo(() => categories.filter((c) => !c.parent_id), [categories]);
  const categorieChoisie = categories.find((c) => c.id === categorieId);
  const logementsImmeuble = logements.filter((l) => l.immeuble_id === immeubleId);

  // Écart taxes : simple avertissement
  const sousTotal = versCents(sousTotalSaisi);
  const tps = versCents(tpsSaisie);
  const tvq = versCents(tvqSaisie);
  const ecartTaxes =
    totalCents !== null && sousTotal !== null
      ? totalCents - (sousTotal + (tps ?? 0) + (tvq ?? 0))
      : 0;

  // ---- Répartition entre immeubles ----
  const sommeLignes = lignesForm.reduce((s, l) => s + (versCents(l.montantSaisi) ?? 0), 0);
  const resteARepartir = totalCents === null ? null : totalCents - sommeLignes;

  function nouvelleLigne(patch: Partial<LigneForm> = {}): LigneForm {
    return { cle: crypto.randomUUID(), immeubleId: "", logementId: "", categorieId, montantSaisi: "", ...patch };
  }

  function activerRepartition() {
    setErreur(null);
    // Une ligne par immeuble, chacun présélectionné ; on retire au besoin les lignes inutiles.
    setLignesForm(
      immeubles.map((im) => nouvelleLigne({
        immeubleId: im.id,
        logementId: im.id === immeubleId ? logementId : "",
      }))
    );
    setRepartie(true);
  }

  function annulerRepartition() {
    const premiere = lignesForm[0];
    if (premiere) {
      setImmeubleId(premiere.immeubleId);
      setLogementId(premiere.logementId);
      if (premiere.categorieId) setCategorieId(premiere.categorieId);
    }
    setLignesForm([]);
    setRepartie(false);
  }

  function majLigne(cle: string, patch: Partial<LigneForm>) {
    setLignesForm((avant) => avant.map((l) => {
      if (l.cle === cle) return { ...l, ...patch };
      // Une catégorie choisie sur une ligne remplit aussi les lignes qui n'en ont pas encore
      if (patch.categorieId && !l.categorieId) return { ...l, categorieId: patch.categorieId };
      return l;
    }));
  }

  function appliquerParts(parts: number[]) {
    setLignesForm((avant) => avant.map((l, i) => ({ ...l, montantSaisi: centsVersSaisie(parts[i] ?? 0) })));
  }

  function repartirAPartsEgales() {
    if (totalCents === null) { setErreur("Entre d'abord le montant total."); return; }
    appliquerParts(repartirEgalement(totalCents, lignesForm.length));
  }

  function repartirSelonLogements() {
    if (totalCents === null) { setErreur("Entre d'abord le montant total."); return; }
    const poids = lignesForm.map((l) => immeubles.find((i) => i.id === l.immeubleId)?.nb_logements ?? 0);
    appliquerParts(repartirSelonPoids(totalCents, poids));
  }

  function lignesAEnvoyer() {
    if (!repartie) {
      return [{
        immeuble_id: immeubleId,
        logement_id: logementId || null,
        categorie_id: categorieId || null,
        montant_cents: totalCents,
        description: null,
      }];
    }
    return lignesForm.map((l) => ({
      immeuble_id: l.immeubleId,
      logement_id: l.logementId || null,
      categorie_id: l.categorieId || null,
      montant_cents: versCents(l.montantSaisi),
      description: null,
    }));
  }

  async function ajouterFichiers(liste: FileList | null) {
    if (!liste || liste.length === 0) return;
    setErreur(null);
    setTraitement(true);
    try {
      const prepares: FichierPrepare[] = [];
      for (const f of Array.from(liste)) prepares.push(await preparerFichier(f));
      setFichiers((avant) => [...avant, ...prepares]);

      // Reçu déjà téléversé ailleurs ?
      let requete = supabase
        .from("pieces_jointes")
        .select("created_at")
        .in("sha256", prepares.map((p) => p.sha256))
        .limit(1);
      if (depenseId) requete = requete.neq("depense_id", depenseId);
      const { data } = await requete;
      if (data && data.length > 0) {
        const quand = new Date(data[0].created_at).toLocaleDateString("fr-CA", { day: "numeric", month: "long" });
        setAvertissementDoublon(`Ce reçu semble déjà avoir été saisi le ${quand}. Vérifie avant d'enregistrer.`);
      }
    } catch (e) {
      setErreur(e instanceof Error ? e.message : "Erreur pendant le traitement de la photo.");
    } finally {
      setTraitement(false);
      if (champPhoto.current) champPhoto.current.value = "";
      if (champFichier.current) champFichier.current.value = "";
    }
  }

  function retirerFichier(index: number) {
    setFichiers((avant) => {
      const copie = [...avant];
      const [retire] = copie.splice(index, 1);
      if (retire?.apercuUrl) URL.revokeObjectURL(retire.apercuUrl);
      return copie;
    });
    setAvertissementDoublon(null);
  }

  function calculerTaxes() {
    if (totalCents === null) { setErreur("Entre d'abord le montant total."); return; }
    const t = decomposerTaxes(totalCents);
    setSousTotalSaisi(centsVersSaisie(t.sousTotal));
    setTpsSaisie(centsVersSaisie(t.tps));
    setTvqSaisie(centsVersSaisie(t.tvq));
  }

  async function televerser(): Promise<object[]> {
    const pieces: object[] = [];
    for (const f of fichiers) {
      const ext = f.mimeType === "application/pdf" ? "pdf" : "jpg";
      const { base, cle } = cleStockage(ext);
      const envoiPrincipal = await supabase.storage
        .from(BUCKET_RECUS)
        .upload(cle, f.principal, { contentType: f.mimeType, upsert: false });
      if (envoiPrincipal.error) throw new Error(`Envoi du reçu impossible : ${envoiPrincipal.error.message}`);

      let miniatureCle: string | null = null;
      if (f.miniature) {
        miniatureCle = `${base}_min.jpg`;
        const envoiMini = await supabase.storage
          .from(BUCKET_RECUS)
          .upload(miniatureCle, f.miniature, { contentType: "image/jpeg", upsert: false });
        if (envoiMini.error) miniatureCle = null; // pas bloquant
      }

      pieces.push({
        storage_key: cle,
        miniature_key: miniatureCle,
        mime_type: f.mimeType,
        taille_octets: f.principal.size,
        largeur: f.largeur,
        hauteur: f.hauteur,
        sha256: f.sha256,
        nom_original: f.nomOriginal,
      });
    }
    return pieces;
  }

  async function enregistrer(statut: "brouillon" | "complete") {
    setErreur(null);
    setConfirmation(null);

    if (!repartie && !immeubleId) { setErreur("Choisis l'immeuble."); return; }
    if (repartie && lignesForm.some((l) => !l.immeubleId)) { setErreur("Choisis l'immeuble de chaque ligne."); return; }
    if (statut === "complete") {
      if (totalCents === null) { setErreur("Entre le montant total (ex. 142,37)."); return; }
      if (!repartie && !categorieId) { setErreur("Choisis la catégorie, ou garde la dépense en brouillon."); return; }
      if (repartie) {
        if (lignesForm.some((l) => !l.categorieId)) { setErreur("Choisis la catégorie de chaque ligne."); return; }
        if (lignesForm.some((l) => versCents(l.montantSaisi) === null)) { setErreur("Entre le montant de chaque ligne."); return; }
        if (resteARepartir !== 0) {
          setErreur(`La répartition ne balance pas : il reste ${formatCents(resteARepartir)} à répartir.`);
          return;
        }
      }
    }
    if (!modeModification && statut === "brouillon" && fichiers.length === 0 && totalCents === null) {
      setErreur("Ajoute au moins une photo ou un montant.");
      return;
    }

    setEnvoi(true);
    try {
      const pieces = await televerser();
      const p = {
        ...(depenseId ? { id: depenseId } : {}),
        fournisseur_nom: fournisseurNom,
        mode_paiement_id: modeId || null,
        date_facture: dateFacture,
        no_facture: noFacture || null,
        sous_total_cents: sousTotal,
        tps_cents: tps ?? 0,
        tvq_cents: tvq ?? 0,
        total_cents: totalCents,
        statut,
        notes: notes || null,
        lignes: lignesAEnvoyer(),
        pieces,
      };
      const { error } = await supabase.rpc(depenseId ? "modifier_depense" : "enregistrer_depense", { p });
      if (error) throw new Error(error.message);

      if (!repartie) ecrireStockageLocal(CLE_DERNIER_IMMEUBLE, immeubleId);

      if (depenseId) {
        router.push(`/depense/${depenseId}`);
        return;
      }

      const nomImmeuble = repartie
        ? `réparti sur ${lignesForm.length} lignes`
        : immeubles.find((i) => i.id === immeubleId)?.nom ?? "";
      setConfirmation(
        statut === "complete"
          ? `${formatCents(totalCents)} · ${nomImmeuble} · ${categorieChoisie?.nom ?? ""}`
          : `Brouillon enregistré · ${nomImmeuble}`
      );
      // Un nouveau fournisseur doit apparaître tout de suite dans le menu pour la saisie suivante.
      const nom = fournisseurNom.trim();
      if (nom) {
        const deja = fournisseurs.find((f) => normaliser(f.nom) === normaliser(nom));
        if (deja) {
          setUsageFournisseurs((m) => {
            const copie = new Map(m);
            const x = copie.get(deja.id);
            copie.set(deja.id, { n: (x?.n ?? 0) + 1, dernier: dateFacture });
            return copie;
          });
        } else {
          const { data } = await supabase.from("fournisseurs").select("id, nom, categorie_defaut_id")
            .is("deleted_at", null).order("nom");
          if (data) {
            setFournisseurs(data as Fournisseur[]);
            const cree = (data as Fournisseur[]).find((f) => normaliser(f.nom) === normaliser(nom));
            if (cree) setUsageFournisseurs((m) => new Map(m).set(cree.id, { n: 1, dernier: dateFacture }));
          }
        }
      }
      reinitialiser();
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setErreur(msg.includes("depenses_no_facture_uniq")
        ? "Cette facture (même fournisseur et même numéro) existe déjà."
        : msg);
    } finally {
      setEnvoi(false);
    }
  }

  function reinitialiser() {
    fichiers.forEach((f) => f.apercuUrl && URL.revokeObjectURL(f.apercuUrl));
    setFichiers([]);
    setTotalSaisi("");
    setFournisseurNom("");
    setCategorieId("");
    setCategorieTouchee(false);
    setDateFacture(aujourdHui());
    setLogementId("");
    setRepartie(false);
    setLignesForm([]);
    setSousTotalSaisi(""); setTpsSaisie(""); setTvqSaisie("");
    setModeId(""); setNoFacture(""); setNotes("");
    setAvertissementDoublon(null);
  }

  const optionsCategories = (
    <>
      <option value="">— Choisir —</option>
      {categoriesPrincipales.map((p) => {
        const enfants = categories.filter((c) => c.parent_id === p.id);
        return enfants.length === 0 ? (
          <option key={p.id} value={p.id}>{p.nom}</option>
        ) : (
          <optgroup key={p.id} label={p.nom}>
            <option value={p.id}>{p.nom} (général)</option>
            {enfants.map((c) => <option key={c.id} value={c.id}>{c.nom}</option>)}
          </optgroup>
        );
      })}
    </>
  );

  if (!pret || !session) return null;

  const titre = !modeModification
    ? "Nouvelle dépense"
    : statutInitial === "brouillon" ? "Compléter le brouillon" : "Modifier la dépense";
  const lienFermer = depenseId ? `/depense/${depenseId}` : "/";
  const nbPages = piecesExistantes.length + fichiers.length;

  return (
    <main className="page">
      <div className="entete">
        <h1>{titre}</h1>
        <Link href={lienFermer} className="bouton">{modeModification ? "Annuler" : "Fermer"}</Link>
      </div>

      {confirmation && (
        <div className="message succes">
          Enregistré : {confirmation}.{" "}
          <button className="bouton" style={{ padding: "4px 10px", marginLeft: 6 }} onClick={() => router.push("/")}>
            Voir la liste
          </button>
        </div>
      )}
      {erreur && <div className="message erreur">{erreur}</div>}
      {avertissementDoublon && <div className="message alerte">{avertissementDoublon}</div>}
      {chargement && modeModification && <p className="aide">Chargement…</p>}

      {/* 1. Reçu */}
      <section className="carte">
        <div className="rangee">
          <button className="bouton principal" onClick={() => champPhoto.current?.click()} disabled={traitement}>
            {traitement ? "Traitement…" : nbPages ? "+ Page" : "Prendre une photo"}
          </button>
          <button className="bouton" onClick={() => champFichier.current?.click()} disabled={traitement}>
            Fichier ou PDF
          </button>
        </div>
        <input ref={champPhoto} type="file" accept="image/*" capture="environment" hidden
               onChange={(e) => ajouterFichiers(e.target.files)} />
        <input ref={champFichier} type="file" accept="image/*,application/pdf" multiple hidden
               onChange={(e) => ajouterFichiers(e.target.files)} />
        {nbPages > 0 && (
          <div className="photos">
            {piecesExistantes.map((p, i) => (
              <div className="vignette" key={p.id}>
                {p.apercuUrl ? <img src={p.apercuUrl} alt={`Page ${i + 1}`} /> : "PDF"}
              </div>
            ))}
            {fichiers.map((f, i) => (
              <div className="vignette" key={`nouveau-${i}`}>
                {f.apercuUrl ? <img src={f.apercuUrl} alt={`Nouvelle page ${i + 1}`} /> : "PDF"}
                <button onClick={() => retirerFichier(i)} aria-label="Retirer">×</button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 2. Essentiel */}
      <section className="carte">
        <label htmlFor="total">Montant total (taxes incluses)</label>
        <input id="total" className="montant-total" inputMode="decimal" placeholder="0,00"
               value={totalSaisi} onChange={(e) => setTotalSaisi(e.target.value)} />
        {totalSaisi !== "" && totalCents === null && <p className="aide">Format attendu : 142,37</p>}

        {!repartie && (
          <>
            <label>Immeuble</label>
            <div className="choix">
              {immeubles.map((im) => (
                <button key={im.id} type="button" className={im.id === immeubleId ? "actif" : ""}
                        onClick={() => { setImmeubleId(im.id); setLogementId(""); }}>
                  {im.nom}
                </button>
              ))}
            </div>
            <button type="button" className="lien-filtres" onClick={activerRepartition}>
              + Répartir entre plusieurs immeubles
            </button>
          </>
        )}

        <label htmlFor="fournisseur">Fournisseur</label>
        <ChoixFournisseur options={optionsFournisseurs} valeur={fournisseurNom} onChange={setFournisseurNom} />

        {!repartie && (
          <>
            <label htmlFor="categorie">Catégorie</label>
            <select id="categorie" value={categorieId}
                    onChange={(e) => { setCategorieId(e.target.value); setCategorieTouchee(true); }}>
              {optionsCategories}
            </select>
            {categorieChoisie?.nature_defaut === "capital" && (
              <p className="aide">Dépense en capital : amortissable, elle ne se déduit pas en entier cette année.</p>
            )}
          </>
        )}

        <label htmlFor="date">Date de la facture</label>
        <input id="date" type="date" value={dateFacture} onChange={(e) => setDateFacture(e.target.value)} />
      </section>

      {/* 2b. Répartition entre immeubles */}
      {repartie && (
        <section className="carte">
          <div className="entete" style={{ marginBottom: 8 }}>
            <strong>Répartition</strong>
            <button type="button" className="bouton" style={{ padding: "6px 12px" }} onClick={annulerRepartition}>
              Un seul immeuble
            </button>
          </div>

          <div className="rangee">
            <button type="button" className="bouton" onClick={repartirAPartsEgales}>Parts égales</button>
            <button type="button" className="bouton" onClick={repartirSelonLogements}>Selon nb de logements</button>
          </div>

          {lignesForm.map((l, i) => {
            const cat = categories.find((c) => c.id === l.categorieId);
            return (
              <div className="ligne-repartition" key={l.cle}>
                <div className="entete" style={{ margin: "0 0 6px" }}>
                  <span className="aide" style={{ margin: 0 }}>Ligne {i + 1}</span>
                  {lignesForm.length > 2 && (
                    <button type="button" className="lien-retirer"
                            onClick={() => setLignesForm((avant) => avant.filter((x) => x.cle !== l.cle))}>
                      Retirer
                    </button>
                  )}
                </div>
                <div className="rangee">
                  <select value={l.immeubleId} aria-label={`Immeuble, ligne ${i + 1}`}
                          onChange={(e) => majLigne(l.cle, { immeubleId: e.target.value, logementId: "" })}>
                    <option value="">Immeuble…</option>
                    {immeubles.map((im) => <option key={im.id} value={im.id}>{im.nom}</option>)}
                  </select>
                  <input inputMode="decimal" placeholder="Montant" value={l.montantSaisi}
                         aria-label={`Montant, ligne ${i + 1}`}
                         onChange={(e) => majLigne(l.cle, { montantSaisi: e.target.value })} />
                </div>
                <div className="rangee" style={{ marginTop: 8 }}>
                  <select value={l.categorieId} aria-label={`Catégorie, ligne ${i + 1}`}
                          onChange={(e) => majLigne(l.cle, { categorieId: e.target.value })}>
                    {optionsCategories}
                  </select>
                  <select value={l.logementId} aria-label={`Logement, ligne ${i + 1}`} disabled={!l.immeubleId}
                          onChange={(e) => majLigne(l.cle, { logementId: e.target.value })}>
                    <option value="">Tout l&apos;immeuble</option>
                    {logements.filter((x) => x.immeuble_id === l.immeubleId)
                      .map((x) => <option key={x.id} value={x.id}>{x.numero}</option>)}
                  </select>
                </div>
                {cat?.nature_defaut === "capital" && <p className="aide">Dépense en capital (amortissable).</p>}
              </div>
            );
          })}

          <button type="button" className="bouton plein" style={{ marginTop: 12 }}
                  onClick={() => setLignesForm((avant) => [...avant, nouvelleLigne()])}>
            + Ajouter une ligne
          </button>

          {resteARepartir !== null && (
            <p className="aide" style={{ color: resteARepartir === 0 ? "var(--succes)" : "var(--alerte)", fontWeight: 600 }}>
              {resteARepartir === 0
                ? "La répartition balance avec le total."
                : resteARepartir > 0
                  ? `Reste à répartir : ${formatCents(resteARepartir)}`
                  : `Répartition trop élevée de ${formatCents(-resteARepartir)}`}
            </p>
          )}
        </section>
      )}

      {/* 3. Détails facultatifs */}
      <section className="carte">
        <details open={modeModification && Boolean(logementId || noFacture || notes || modeId || sousTotalSaisi)}>
          <summary>Plus de détails</summary>

          {!repartie && (
            <>
              <label htmlFor="logement">Logement</label>
              <select id="logement" value={logementId} onChange={(e) => setLogementId(e.target.value)} disabled={!immeubleId}>
                <option value="">{immeubleId ? "Tout l'immeuble" : "Choisis d'abord l'immeuble"}</option>
                {logementsImmeuble.map((l) => <option key={l.id} value={l.id}>{l.numero}</option>)}
              </select>
            </>
          )}

          <label>Taxes</label>
          <button type="button" className="bouton plein" onClick={calculerTaxes}>Calculer TPS/TVQ à partir du total</button>
          <div className="rangee" style={{ marginTop: 8 }}>
            <input inputMode="decimal" placeholder="Avant taxes" value={sousTotalSaisi} onChange={(e) => setSousTotalSaisi(e.target.value)} />
            <input inputMode="decimal" placeholder="TPS" value={tpsSaisie} onChange={(e) => setTpsSaisie(e.target.value)} />
            <input inputMode="decimal" placeholder="TVQ" value={tvqSaisie} onChange={(e) => setTvqSaisie(e.target.value)} />
          </div>
          {ecartTaxes !== 0 && (
            <p className="aide" style={{ color: "var(--alerte)" }}>
              Avant taxes + TPS + TVQ diffère du total de {formatCents(Math.abs(ecartTaxes))}.
            </p>
          )}

          <label htmlFor="mode">Mode de paiement</label>
          <select id="mode" value={modeId} onChange={(e) => setModeId(e.target.value)}>
            <option value="">—</option>
            {modes.map((m) => <option key={m.id} value={m.id}>{m.nom}</option>)}
          </select>

          <label htmlFor="nofacture">Numéro de facture</label>
          <input id="nofacture" value={noFacture} onChange={(e) => setNoFacture(e.target.value)} />

          <label htmlFor="notes">Notes</label>
          <textarea id="notes" placeholder="ex. chauffe-eau app. 3" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </details>
      </section>

      <div className="barre-actions">
        <div className="contenu">
          {/* Une dépense complète ne redevient pas brouillon depuis cet écran */}
          {statutInitial !== "complete" && (
            <button className="bouton" disabled={envoi || traitement || chargement} onClick={() => enregistrer("brouillon")}>
              {modeModification ? "Garder en brouillon" : "Photo seulement"}
            </button>
          )}
          <button className="bouton principal" disabled={envoi || traitement || chargement} onClick={() => enregistrer("complete")}>
            {envoi ? "Envoi…" : "Enregistrer"}
          </button>
        </div>
      </div>
    </main>
  );
}
