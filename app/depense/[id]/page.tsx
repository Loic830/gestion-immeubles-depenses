"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { supabase, BUCKET_RECUS } from "@/lib/supabase";
import { useSession } from "@/lib/useSession";
import { formatCents } from "@/lib/argent";

type Detail = {
  id: string;
  statut: "brouillon" | "complete";
  date_facture: string;
  date_paiement: string | null;
  no_facture: string | null;
  sous_total_cents: number | null;
  tps_cents: number;
  tvq_cents: number;
  total_cents: number | null;
  notes: string | null;
  created_at: string;
  fournisseur: { nom: string } | null;
  mode: { nom: string } | null;
  lignes: {
    id: string;
    montant_cents: number | null;
    nature: "courante" | "capital";
    description: string | null;
    immeuble: { nom: string } | null;
    logement: { numero: string } | null;
    categorie: { nom: string; code_fiscal: string | null } | null;
  }[];
  pieces: {
    id: string;
    storage_key: string;
    miniature_key: string | null;
    mime_type: string;
    nom_original: string | null;
  }[];
};

type Recu = {
  id: string;
  estPdf: boolean;
  apercu: string | null;      // miniature
  original: string | null;    // fichier complet, à afficher
  telechargement: string | null;
};

const DUREE_URL = 600; // secondes : les liens vers les reçus expirent après 10 minutes

export default function DetailDepense() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { session, pret } = useSession();

  const [d, setD] = useState<Detail | null>(null);
  const [recus, setRecus] = useState<Recu[]>([]);
  const [erreur, setErreur] = useState<string | null>(null);
  const [pleinEcran, setPleinEcran] = useState<Recu | null>(null);
  const [suppression, setSuppression] = useState(false);

  useEffect(() => {
    if (!session || !id) return;
    (async () => {
      const { data, error } = await supabase
        .from("depenses")
        .select(`id, statut, date_facture, date_paiement, no_facture, sous_total_cents, tps_cents, tvq_cents, total_cents, notes, created_at,
                 fournisseur:fournisseurs(nom),
                 mode:modes_paiement(nom),
                 lignes:depense_lignes(id, montant_cents, nature, description,
                                       immeuble:immeubles(nom), logement:logements(numero), categorie:categories(nom, code_fiscal)),
                 pieces:pieces_jointes(id, storage_key, miniature_key, mime_type, nom_original)`)
        .eq("id", id)
        .is("deleted_at", null)
        .single();
      if (error || !data) { setErreur("Dépense introuvable ou supprimée."); return; }
      const detail = data as unknown as Detail;
      setD(detail);

      // Liens signés vers les reçus (bucket privé)
      const stockage = supabase.storage.from(BUCKET_RECUS);
      const liste: Recu[] = [];
      for (const p of detail.pieces) {
        const estPdf = p.mime_type === "application/pdf";
        const [orig, mini, dl] = await Promise.all([
          stockage.createSignedUrl(p.storage_key, DUREE_URL),
          p.miniature_key ? stockage.createSignedUrl(p.miniature_key, DUREE_URL) : Promise.resolve({ data: null }),
          stockage.createSignedUrl(p.storage_key, DUREE_URL, { download: p.nom_original ?? true }),
        ]);
        liste.push({
          id: p.id,
          estPdf,
          original: orig.data?.signedUrl ?? null,
          apercu: mini.data?.signedUrl ?? (estPdf ? null : orig.data?.signedUrl ?? null),
          telechargement: dl.data?.signedUrl ?? null,
        });
      }
      setRecus(liste);
    })();
  }, [session, id]);

  async function supprimer() {
    if (!d) return;
    if (!window.confirm("Supprimer cette dépense ? Elle sera retirée de la liste et des totaux. Les reçus restent conservés.")) return;
    setSuppression(true);
    const { error } = await supabase.from("depenses").update({ deleted_at: new Date().toISOString() }).eq("id", d.id);
    setSuppression(false);
    if (error) { setErreur(error.message); return; }
    router.replace("/");
  }

  if (!pret || !session) return null;

  return (
    <main className="page">
      <div className="entete">
        <h1>Dépense</h1>
        <Link href="/" className="bouton">Retour</Link>
      </div>

      {erreur && <div className="message erreur">{erreur}</div>}
      {!d && !erreur && <p className="aide">Chargement…</p>}

      {d && (
        <>
          {d.statut === "brouillon" && (
            <div className="message alerte">Brouillon : il manque des informations pour que cette dépense compte dans les totaux fiscaux.</div>
          )}

          <section className="carte">
            <div className="detail-total">{formatCents(d.total_cents)}</div>
            <div className="detail-sous">{d.fournisseur?.nom ?? "Fournisseur à préciser"} · {d.date_facture}</div>
          </section>

          {recus.length > 0 && (
            <section className="carte">
              <div className="photos" style={{ marginTop: 0 }}>
                {recus.map((r, i) => (
                  <button key={r.id} className="vignette" onClick={() => (r.estPdf ? r.original && window.open(r.original, "_blank") : setPleinEcran(r))}>
                    {r.apercu ? <img src={r.apercu} alt={`Reçu, page ${i + 1}`} /> : "PDF"}
                  </button>
                ))}
              </div>
              <p className="aide">Touche un reçu pour l&apos;agrandir.</p>
            </section>
          )}

          <section className="carte">
            <dl className="champs">
              {d.lignes.map((l) => (
                <div key={l.id} className="champ-groupe">
                  <dt>Immeuble</dt>
                  <dd>{l.immeuble?.nom ?? "—"}{l.logement ? ` · logement ${l.logement.numero}` : " · tout l'immeuble"}</dd>
                  <dt>Catégorie</dt>
                  <dd>
                    {l.categorie?.nom ?? "À préciser"}
                    {l.categorie?.code_fiscal && <span className="aide"> (T776 : {l.categorie.code_fiscal})</span>}
                    {l.nature === "capital" && <span className="pastille" style={{ marginLeft: 6 }}>Capital</span>}
                  </dd>
                  {d.lignes.length > 1 && (<><dt>Montant</dt><dd>{formatCents(l.montant_cents)}</dd></>)}
                </div>
              ))}
              {d.sous_total_cents !== null && (
                <>
                  <dt>Avant taxes</dt><dd>{formatCents(d.sous_total_cents)}</dd>
                  <dt>TPS / TVQ</dt><dd>{formatCents(d.tps_cents)} / {formatCents(d.tvq_cents)}</dd>
                </>
              )}
              {d.mode && (<><dt>Paiement</dt><dd>{d.mode.nom}</dd></>)}
              {d.no_facture && (<><dt>No de facture</dt><dd>{d.no_facture}</dd></>)}
              {d.notes && (<><dt>Notes</dt><dd style={{ whiteSpace: "pre-wrap" }}>{d.notes}</dd></>)}
              <dt>Saisie le</dt><dd>{new Date(d.created_at).toLocaleString("fr-CA", { dateStyle: "medium", timeStyle: "short" })}</dd>
            </dl>
          </section>

          <button className="bouton plein lien-danger" onClick={supprimer} disabled={suppression}>
            {suppression ? "Suppression…" : "Supprimer la dépense"}
          </button>

          <div className="barre-actions">
            <div className="contenu">
              <Link href={`/depense/${d.id}/modifier`} className="bouton principal">
                {d.statut === "brouillon" ? "Compléter" : "Modifier"}
              </Link>
            </div>
          </div>
        </>
      )}

      {pleinEcran && (
        <div className="plein-ecran" onClick={() => setPleinEcran(null)}>
          {pleinEcran.original && <img src={pleinEcran.original} alt="Reçu" />}
          <div className="plein-ecran-actions" onClick={(e) => e.stopPropagation()}>
            {pleinEcran.original && <a className="bouton" href={pleinEcran.original} target="_blank" rel="noreferrer">Ouvrir (zoom)</a>}
            {pleinEcran.telechargement && <a className="bouton" href={pleinEcran.telechargement}>Télécharger</a>}
            <button className="bouton principal" onClick={() => setPleinEcran(null)}>Fermer</button>
          </div>
        </div>
      )}
    </main>
  );
}
