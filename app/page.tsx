"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { useSession } from "@/lib/useSession";
import { formatCents } from "@/lib/argent";

type Ligne = {
  ligne_id: string;
  depense_id: string;
  date_facture: string;
  statut: "brouillon" | "complete";
  fournisseur: string | null;
  immeuble: string;
  logement: string | null;
  categorie: string | null;
  montant_cents: number | null;
  total_cents: number | null;
};

export default function Accueil() {
  const { session, pret } = useSession();
  const [lignes, setLignes] = useState<Ligne[]>([]);
  const [chargement, setChargement] = useState(true);
  const [erreur, setErreur] = useState<string | null>(null);

  useEffect(() => {
    if (!session) return;
    (async () => {
      const { data, error } = await supabase
        .from("v_depenses_detail")
        .select("ligne_id, depense_id, date_facture, statut, fournisseur, immeuble, logement, categorie, montant_cents, total_cents")
        .order("date_facture", { ascending: false })
        .limit(50);
      if (error) setErreur(error.message);
      else setLignes((data ?? []) as Ligne[]);
      setChargement(false);
    })();
  }, [session]);

  if (!pret || !session) return null;

  const debutMois = new Date();
  debutMois.setDate(1);
  const cleMois = debutMois.toISOString().slice(0, 7);
  const totalMois = lignes
    .filter((l) => l.date_facture.startsWith(cleMois))
    .reduce((s, l) => s + (l.montant_cents ?? 0), 0);
  const aCompleter = new Set(lignes.filter((l) => l.statut === "brouillon").map((l) => l.depense_id)).size;

  return (
    <main className="page">
      <div className="entete">
        <h1>Dépenses</h1>
        <button className="bouton" onClick={() => supabase.auth.signOut()}>Déconnexion</button>
      </div>

      <div className="carte total-periode">
        Ce mois-ci : <strong>{formatCents(totalMois)}</strong>
        {aCompleter > 0 && <> · <span className="pastille">{aCompleter} à compléter</span></>}
      </div>

      {erreur && <div className="message erreur">{erreur}</div>}

      <div className="carte">
        {chargement && <p className="aide">Chargement…</p>}
        {!chargement && lignes.length === 0 && (
          <p className="aide">Aucune dépense pour l&apos;instant. Touche « + » pour photographier ton premier reçu.</p>
        )}
        {lignes.map((l) => (
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
