"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { useSession } from "@/lib/useSession";
import { formatCents } from "@/lib/argent";
import { PERIODES, bornesPeriode, type CodePeriode } from "@/lib/periodes";
import { genererCsv, montantCsv, telechargerFichier } from "@/lib/csv";
import { exporterDossier } from "@/lib/exportDossier";

type Ligne = {
  ligne_id: string;
  depense_id: string;
  date_facture: string;
  statut: "brouillon" | "complete";
  fournisseur: string | null;
  immeuble_id: string;
  immeuble: string;
  logement: string | null;
  categorie_id: string | null;
  categorie: string | null;
  categorie_parent: string | null;
  code_fiscal: string | null;
  nature: "courante" | "capital";
  montant_cents: number | null;
  sous_total_cents: number | null;
  tps_cents: number;
  tvq_cents: number;
  total_cents: number | null;
  mode_paiement: string | null;
  no_facture: string | null;
  description: string | null;
  notes: string | null;
  nb_pieces: number;
};

type Immeuble = { id: string; nom: string };
type Categorie = { id: string; nom: string; parent_id: string | null; ordre: number };

const LIMITE = 1000; // plafond par défaut de Supabase par requête

export default function Accueil() {
  // useSearchParams exige une frontière Suspense avec Next.js 15
  return (
    <Suspense fallback={null}>
      <ListeDepenses />
    </Suspense>
  );
}

function ListeDepenses() {
  const router = useRouter();
  const params = useSearchParams();
  const { session, pret } = useSession();

  // Filtres, lus dans l'URL (un lien garde ses filtres)
  const periode = (params.get("p") as CodePeriode) || "annee";
  const du = params.get("du") ?? "";
  const au = params.get("au") ?? "";
  const immeublesChoisis = useMemo(() => (params.get("im") ?? "").split(",").filter(Boolean), [params]);
  const categorieChoisie = params.get("cat") ?? "";
  const statutChoisi = params.get("st") ?? "";

  const [immeubles, setImmeubles] = useState<Immeuble[]>([]);
  const [categories, setCategories] = useState<Categorie[]>([]);
  const [lignes, setLignes] = useState<Ligne[]>([]);
  const [chargement, setChargement] = useState(true);
  const [erreur, setErreur] = useState<string | null>(null);
  const [filtresOuverts, setFiltresOuverts] = useState(false);
  const [exportEnCours, setExportEnCours] = useState<string | null>(null);
  const [exportResultat, setExportResultat] = useState<string | null>(null);

  function changerFiltre(modifs: Record<string, string>) {
    const p = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(modifs)) {
      if (v) p.set(k, v); else p.delete(k);
    }
    router.replace(`/?${p.toString()}`, { scroll: false });
  }

  function basculerImmeuble(id: string) {
    const actuels = new Set(immeublesChoisis);
    if (actuels.has(id)) actuels.delete(id); else actuels.add(id);
    changerFiltre({ im: Array.from(actuels).join(",") });
  }

  // Listes de référence pour les filtres
  useEffect(() => {
    if (!session) return;
    (async () => {
      const [im, ca] = await Promise.all([
        supabase.from("immeubles").select("id, nom").is("deleted_at", null).order("nom"),
        supabase.from("categories").select("id, nom, parent_id, ordre").is("deleted_at", null).order("ordre"),
      ]);
      setImmeubles((im.data ?? []) as Immeuble[]);
      setCategories((ca.data ?? []) as Categorie[]);
    })();
  }, [session]);

  // Données filtrées
  useEffect(() => {
    if (!session) return;
    (async () => {
      setChargement(true);
      setErreur(null);
      const { debut, fin } = bornesPeriode(periode, du, au);
      let q = supabase
        .from("v_depenses_detail")
        .select("*")
        .order("date_facture", { ascending: false })
        .limit(LIMITE);
      if (debut) q = q.gte("date_facture", debut);
      if (fin) q = q.lte("date_facture", fin);
      if (immeublesChoisis.length) q = q.in("immeuble_id", immeublesChoisis);
      if (categorieChoisie) {
        // Une catégorie principale inclut ses sous-catégories
        const ids = [categorieChoisie, ...categories.filter((c) => c.parent_id === categorieChoisie).map((c) => c.id)];
        q = q.in("categorie_id", ids);
      }
      if (statutChoisi) q = q.eq("statut", statutChoisi);
      const { data, error } = await q;
      if (error) setErreur(error.message);
      else setLignes((data ?? []) as Ligne[]);
      setChargement(false);
    })();
  }, [session, periode, du, au, immeublesChoisis, categorieChoisie, statutChoisi, categories]);

  // Totaux
  const total = lignes.reduce((s, l) => s + (l.montant_cents ?? 0), 0);
  const totalCapital = lignes.filter((l) => l.nature === "capital").reduce((s, l) => s + (l.montant_cents ?? 0), 0);
  const nbBrouillons = new Set(lignes.filter((l) => l.statut === "brouillon").map((l) => l.depense_id)).size;
  const parCategorie = useMemo(() => {
    const m = new Map<string, number>();
    for (const l of lignes) {
      const cle = l.categorie_parent ?? l.categorie ?? "À préciser";
      m.set(cle, (m.get(cle) ?? 0) + (l.montant_cents ?? 0));
    }
    return Array.from(m.entries()).sort((a, b) => b[1] - a[1]);
  }, [lignes]);

  const libellePeriode = PERIODES.find((p) => p.code === periode)?.libelle ?? "";
  const nbFiltres = (immeublesChoisis.length ? 1 : 0) + (categorieChoisie ? 1 : 0) + (statutChoisi ? 1 : 0);

  function exporter() {
    const entetes = [
      "Date", "Fournisseur", "Immeuble", "Logement", "Catégorie", "Catégorie principale", "Ligne T776",
      "Nature", "Montant", "Avant taxes", "TPS", "TVQ", "Total facture", "Paiement", "No facture",
      "Statut", "Description", "Notes", "Nb reçus",
    ];
    const rangs = lignes.map((l) => [
      l.date_facture, l.fournisseur, l.immeuble, l.logement, l.categorie, l.categorie_parent ?? l.categorie,
      l.code_fiscal, l.nature, montantCsv(l.montant_cents), montantCsv(l.sous_total_cents),
      montantCsv(l.tps_cents), montantCsv(l.tvq_cents), montantCsv(l.total_cents), l.mode_paiement,
      l.no_facture, l.statut, l.description, l.notes, l.nb_pieces,
    ]);
    const { debut, fin } = bornesPeriode(periode, du, au);
    const nom = `depenses_${debut ?? "debut"}_${fin ?? "aujourdhui"}.csv`;
    telechargerFichier(genererCsv(entetes, rangs), nom);
  }

  async function exporterAvecRecus() {
    setExportResultat(null);
    setErreur(null);
    const { debut, fin } = bornesPeriode(periode, du, au);
    try {
      const r = await exporterDossier(lignes, `dossier_depenses_${debut ?? "debut"}_${fin ?? "aujourdhui"}.zip`, setExportEnCours);
      setExportResultat(
        r.manquants
          ? `Dossier créé : ${r.nbRecus} reçus, ${r.manquants} introuvable(s) (voir RECUS_MANQUANTS.txt).`
          : `Dossier créé avec ${r.nbRecus} reçu(s). Décompresse le ZIP avant d'ouvrir le fichier Excel.`
      );
    } catch (e) {
      setErreur(`Export impossible : ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setExportEnCours(null);
    }
  }

  if (!pret || !session) return null;

  return (
    <main className="page">
      <div className="entete">
        <h1>Dépenses</h1>
        <button className="bouton" onClick={() => supabase.auth.signOut()}>Déconnexion</button>
      </div>

      {/* Filtres */}
      <section className="carte">
        <select value={periode} onChange={(e) => changerFiltre({ p: e.target.value, du: "", au: "" })} aria-label="Période">
          {PERIODES.map((p) => <option key={p.code} value={p.code}>{p.libelle}</option>)}
        </select>
        {periode === "perso" && (
          <div className="rangee" style={{ marginTop: 8 }}>
            <input type="date" value={du} onChange={(e) => changerFiltre({ du: e.target.value })} aria-label="Du" />
            <input type="date" value={au} onChange={(e) => changerFiltre({ au: e.target.value })} aria-label="Au" />
          </div>
        )}

        <button className="lien-filtres" onClick={() => setFiltresOuverts(!filtresOuverts)}>
          {filtresOuverts ? "▾" : "▸"} Filtres{nbFiltres ? ` (${nbFiltres})` : ""}
        </button>

        {filtresOuverts && (
          <>
            <label>Immeubles</label>
            <div className="choix">
              {immeubles.map((im) => (
                <button key={im.id} type="button" className={immeublesChoisis.includes(im.id) ? "actif" : ""}
                        onClick={() => basculerImmeuble(im.id)}>
                  {im.nom}
                </button>
              ))}
            </div>

            <label htmlFor="f-cat">Catégorie</label>
            <select id="f-cat" value={categorieChoisie} onChange={(e) => changerFiltre({ cat: e.target.value })}>
              <option value="">Toutes</option>
              {categories.filter((c) => !c.parent_id).map((p) => {
                const enfants = categories.filter((c) => c.parent_id === p.id);
                return enfants.length === 0 ? (
                  <option key={p.id} value={p.id}>{p.nom}</option>
                ) : (
                  <optgroup key={p.id} label={p.nom}>
                    <option value={p.id}>{p.nom} (tout)</option>
                    {enfants.map((c) => <option key={c.id} value={c.id}>{c.nom}</option>)}
                  </optgroup>
                );
              })}
            </select>

            <label htmlFor="f-st">Statut</label>
            <select id="f-st" value={statutChoisi} onChange={(e) => changerFiltre({ st: e.target.value })}>
              <option value="">Tous</option>
              <option value="complete">Complètes</option>
              <option value="brouillon">Brouillons à compléter</option>
            </select>

            {nbFiltres > 0 && (
              <button className="bouton plein" style={{ marginTop: 12 }}
                      onClick={() => changerFiltre({ im: "", cat: "", st: "" })}>
                Effacer les filtres
              </button>
            )}
          </>
        )}
      </section>

      {erreur && <div className="message erreur">{erreur}</div>}

      {/* Totaux */}
      <section className="carte">
        <div className="total-periode">
          {libellePeriode} : <strong>{formatCents(total)}</strong>
          {nbBrouillons > 0 && <> · <span className="pastille">{nbBrouillons} à compléter</span></>}
        </div>
        {totalCapital > 0 && (
          <p className="aide">Dont {formatCents(totalCapital)} en dépenses en capital (amortissables).</p>
        )}
        {parCategorie.length > 1 && (
          <div className="repartition">
            {parCategorie.map(([nom, cents]) => (
              <div className="repartition-ligne" key={nom}>
                <span>{nom}</span>
                <span className="repartition-barre">
                  <span style={{ width: `${total ? Math.max(2, (cents / total) * 100) : 0}%` }} />
                </span>
                <strong>{formatCents(cents)}</strong>
              </div>
            ))}
          </div>
        )}
        {lignes.length > 0 && (
          <>
            <button className="bouton principal plein" style={{ marginTop: 12 }}
                    onClick={exporterAvecRecus} disabled={exportEnCours !== null}>
              {exportEnCours ?? "Exporter Excel + reçus (ZIP)"}
            </button>
            <button className="bouton plein" style={{ marginTop: 8 }} onClick={exporter} disabled={exportEnCours !== null}>
              Exporter en CSV seulement
            </button>
          </>
        )}
        {exportResultat && <p className="aide" style={{ color: "var(--succes)" }}>{exportResultat}</p>}
        {lignes.length >= LIMITE && (
          <p className="aide">Affichage limité aux {LIMITE} lignes les plus récentes : resserre la période.</p>
        )}
      </section>

      {/* Liste */}
      <div className="carte">
        {chargement && <p className="aide">Chargement…</p>}
        {!chargement && lignes.length === 0 && (
          <p className="aide">Aucune dépense pour cette sélection. Touche « + » pour photographier un reçu.</p>
        )}
        {!chargement && lignes.map((l) => (
          <Link href={`/depense/${l.depense_id}`} className="liste-depense" key={l.ligne_id}>
            <div className="infos">
              <div className="titre">{l.fournisseur ?? "Fournisseur à préciser"}</div>
              <div className="sous">
                {l.date_facture} · {l.immeuble}{l.logement ? ` #${l.logement}` : ""}
                {l.categorie ? ` · ${l.categorie}` : ""}
              </div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div className="montant">{formatCents(l.montant_cents ?? l.total_cents)}</div>
              {l.statut === "brouillon" && <span className="pastille">Brouillon</span>}
            </div>
          </Link>
        ))}
      </div>

      <Link href="/nouvelle" className="fab" aria-label="Nouvelle dépense">+</Link>
    </main>
  );
}
