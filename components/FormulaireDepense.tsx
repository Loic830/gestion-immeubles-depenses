"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { supabase, BUCKET_RECUS } from "@/lib/supabase";
import { useSession } from "@/lib/useSession";
import { preparerFichier, cleStockage, type FichierPrepare } from "@/lib/image";
import { versCents, formatCents, centsVersSaisie, decomposerTaxes } from "@/lib/argent";

type Immeuble = { id: string; nom: string };
type Logement = { id: string; immeuble_id: string; numero: string };
type Categorie = { id: string; nom: string; parent_id: string | null; nature_defaut: "courante" | "capital"; ordre: number };
type Fournisseur = { id: string; nom: string; categorie_defaut_id: string | null };
type ModePaiement = { id: string; nom: string };
type PieceExistante = { id: string; mime_type: string; apercuUrl: string | null };

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
  lignes: { immeuble_id: string; logement_id: string | null; categorie_id: string | null }[];
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
      const [im, lo, ca, fo, mo] = await Promise.all([
        supabase.from("immeubles").select("id, nom").is("deleted_at", null).eq("actif", true).order("nom"),
        supabase.from("logements").select("id, immeuble_id, numero").is("deleted_at", null).eq("actif", true).order("numero"),
        supabase.from("categories").select("id, nom, parent_id, nature_defaut, ordre").is("deleted_at", null).eq("actif", true).order("ordre"),
        supabase.from("fournisseurs").select("id, nom, categorie_defaut_id").is("deleted_at", null).order("nom"),
        supabase.from("modes_paiement").select("id, nom").eq("actif", true).order("nom"),
      ]);
      const premiereErreur = [im, lo, ca, fo, mo].find((r) => r.error)?.error;
      if (premiereErreur) { setErreur(premiereErreur.message); setChargement(false); return; }
      setImmeubles((im.data ?? []) as Immeuble[]);
      setLogements((lo.data ?? []) as Logement[]);
      setCategories((ca.data ?? []) as Categorie[]);
      setFournisseurs((fo.data ?? []) as Fournisseur[]);
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
                 lignes:depense_lignes(immeuble_id, logement_id, categorie_id),
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
      setRepartie(d.lignes.length > 1);

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
    const f = fournisseurs.find((x) => x.nom.toLowerCase() === fournisseurNom.trim().toLowerCase());
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

    if (repartie) { setErreur("Cette dépense est répartie entre plusieurs immeubles : la modification n'est pas encore possible ici."); return; }
    if (!immeubleId) { setErreur("Choisis l'immeuble."); return; }
    if (statut === "complete") {
      if (totalCents === null) { setErreur("Entre le montant total (ex. 142,37)."); return; }
      if (!categorieId) { setErreur("Choisis la catégorie, ou garde la dépense en brouillon."); return; }
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
        lignes: [{
          immeuble_id: immeubleId,
          logement_id: logementId || null,
          categorie_id: categorieId || null,
          montant_cents: totalCents,
          description: null,
        }],
        pieces,
      };
      const { error } = await supabase.rpc(depenseId ? "modifier_depense" : "enregistrer_depense", { p });
      if (error) throw new Error(error.message);

      ecrireStockageLocal(CLE_DERNIER_IMMEUBLE, immeubleId);

      if (depenseId) {
        router.push(`/depense/${depenseId}`);
        return;
      }

      const nomImmeuble = immeubles.find((i) => i.id === immeubleId)?.nom ?? "";
      setConfirmation(
        statut === "complete"
          ? `${formatCents(totalCents)} · ${nomImmeuble} · ${categorieChoisie?.nom ?? ""}`
          : `Brouillon enregistré · ${nomImmeuble}`
      );
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
    setSousTotalSaisi(""); setTpsSaisie(""); setTvqSaisie("");
    setModeId(""); setNoFacture(""); setNotes("");
    setAvertissementDoublon(null);
  }

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

        <label>Immeuble</label>
        <div className="choix">
          {immeubles.map((im) => (
            <button key={im.id} type="button" className={im.id === immeubleId ? "actif" : ""}
                    onClick={() => { setImmeubleId(im.id); setLogementId(""); }}>
              {im.nom}
            </button>
          ))}
        </div>

        <label htmlFor="fournisseur">Fournisseur</label>
        <input id="fournisseur" list="liste-fournisseurs" autoComplete="off" placeholder="ex. Rona, Hydro-Québec"
               value={fournisseurNom} onChange={(e) => setFournisseurNom(e.target.value)} />
        <datalist id="liste-fournisseurs">
          {fournisseurs.map((f) => <option key={f.id} value={f.nom} />)}
        </datalist>

        <label htmlFor="categorie">Catégorie</label>
        <select id="categorie" value={categorieId}
                onChange={(e) => { setCategorieId(e.target.value); setCategorieTouchee(true); }}>
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
        </select>
        {categorieChoisie?.nature_defaut === "capital" && (
          <p className="aide">Dépense en capital : amortissable, elle ne se déduit pas en entier cette année.</p>
        )}

        <label htmlFor="date">Date de la facture</label>
        <input id="date" type="date" value={dateFacture} onChange={(e) => setDateFacture(e.target.value)} />
      </section>

      {/* 3. Détails facultatifs */}
      <section className="carte">
        <details open={modeModification && Boolean(logementId || noFacture || notes || modeId || sousTotalSaisi)}>
          <summary>Plus de détails</summary>

          <label htmlFor="logement">Logement</label>
          <select id="logement" value={logementId} onChange={(e) => setLogementId(e.target.value)} disabled={!immeubleId}>
            <option value="">{immeubleId ? "Tout l'immeuble" : "Choisis d'abord l'immeuble"}</option>
            {logementsImmeuble.map((l) => <option key={l.id} value={l.id}>{l.numero}</option>)}
          </select>

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
