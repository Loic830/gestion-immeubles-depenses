"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { parLots } from "@/lib/paquets";
import { useSession } from "@/lib/useSession";
import { formatCents } from "@/lib/argent";
import { dateLisible } from "@/lib/dates";
import { LIBELLE_ORIGINE, type OrigineBail } from "@/lib/baux";

// Historique de tous les baux d'un logement, du plus récent au plus ancien.

type Logement = { id: string; numero: string; immeuble: { nom: string } | null };
type Bail = {
  id: string;
  statut: "a_venir" | "actif" | "termine";
  date_debut: string;
  date_fin: string | null;
  date_depart: string | null;
  loyer_cents: number;
  extras_cents: number;
  locataires: string | null;
  origine: OrigineBail;
};
type Mois = { bail_id: string; montant_du_cents: number; recu_cents: number };

const LIBELLE_STATUT = { a_venir: "À venir", actif: "En cours", termine: "Terminé" };

export default function HistoriqueLogement() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { session, pret } = useSession();
  const [logement, setLogement] = useState<Logement | null>(null);
  const [baux, setBaux] = useState<Bail[]>([]);
  const [mois, setMois] = useState<Mois[]>([]);
  const [chargement, setChargement] = useState(true);
  const [erreur, setErreur] = useState<string | null>(null);

  useEffect(() => {
    if (!session || !id) return;
    (async () => {
      const [lo, ba] = await Promise.all([
        supabase.from("logements").select("id, numero, immeuble:immeubles(nom)").eq("id", id).single(),
        supabase.from("v_baux")
          .select("id, statut, date_debut, date_fin, date_depart, loyer_cents, extras_cents, locataires, origine")
          .eq("logement_id", id).order("date_debut", { ascending: false }),
      ]);
      if (lo.error || !lo.data) { setErreur("Logement introuvable."); setChargement(false); return; }
      setLogement(lo.data as unknown as Logement);
      const liste = (ba.data ?? []) as Bail[];
      setBaux(liste);
      if (liste.length) {
        // Par lots et par paquets (v0.9.11) : 30 ans de baux dépassent la limite de 1000 lignes
        const data = await parLots<Mois>(liste.map((b) => b.id), (lot, debut, fin) => supabase.from("v_soldes")
          .select("bail_id, montant_du_cents, recu_cents").in("bail_id", lot).order("bail_id").order("mois").range(debut, fin))
          .catch(() => [] as Mois[]);
        setMois(data);
      }
      setChargement(false);
    })();
  }, [session, id]);

  if (!pret || !session) return null;

  const enCours = baux.some((b) => b.statut !== "termine");

  return (
    <main className="page">
      <div className="entete">
        <h1>Historique</h1>
        <button className="bouton" onClick={() => router.back()}>Retour</button>
      </div>

      {erreur && <div className="message erreur">{erreur}</div>}
      {logement && (
        <p className="detail-sous" style={{ marginTop: 0 }}>
          {logement.immeuble?.nom} · logement {logement.numero} · {baux.length} {baux.length > 1 ? "baux" : "bail"}
        </p>
      )}
      {chargement && <p className="aide">Chargement…</p>}

      {!chargement && logement && (
        <section className="carte" style={{ paddingTop: 4, paddingBottom: 4 }}>
          {baux.length === 0 && <p className="aide">Aucun bail inscrit pour ce logement.</p>}
          {baux.map((b) => {
            const sesMois = mois.filter((m) => m.bail_id === b.id);
            const du = sesMois.reduce((s, m) => s + m.montant_du_cents, 0);
            const recu = sesMois.reduce((s, m) => s + m.recu_cents, 0);
            const fin = b.date_depart
              ? `départ ${dateLisible(b.date_depart)}`
              : b.date_fin ? dateLisible(b.date_fin) : "durée indéterminée";
            return (
              <Link key={b.id} href={`/baux/${b.id}`} className="liste-depense">
                <div className="infos">
                  <div className="titre">{b.locataires ?? "Locataire à préciser"}</div>
                  <div className="sous">{dateLisible(b.date_debut)} → {fin}{b.origine !== "nouveau" ? ` · ${LIBELLE_ORIGINE[b.origine]}` : ""}</div>
                  <div className="sous">
                    {formatCents(b.loyer_cents + b.extras_cents)} / mois · reçu {formatCents(recu)} sur {formatCents(du)}
                  </div>
                </div>
                <span className={`pastille ${b.statut === "actif" ? "ok" : b.statut === "termine" ? "gris" : ""}`}>{LIBELLE_STATUT[b.statut]}</span>
              </Link>
            );
          })}
        </section>
      )}

      {!chargement && logement && (
        <Link href={`/baux/nouveau?logement=${logement.id}`} className={`bouton plein${enCours ? "" : " principal"}`} style={{ textAlign: "center" }}>
          + Nouveau bail pour ce logement
        </Link>
      )}
    </main>
  );
}
