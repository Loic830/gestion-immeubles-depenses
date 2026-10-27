"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { formatCents } from "@/lib/argent";
import { nomVehicule, type FicheVehicule, type ImmeubleVeh } from "@/lib/vehicule";
import { chargerDepensesAnnee, exporterCsvDepenses } from "@/lib/exportDepenses";

// Profil > Rapport d'impôts (v0.9.0) : tous les exports pour le comptable, au même endroit, pour une année civile.
//   - Dépenses + reçus (ZIP) : depenses.xlsx (avec la part des immeubles des frais de véhicule) + recus/
//   - Dépenses en CSV seulement
//   - Dossier de chaque véhicule : vehicule_AAAA.xlsx (résumé, journal de bord, frais) + reçus
//   - v0.9.12 : revenus de loyers : loyers_AAAA.xlsx (reçus du locataire et de l'OMH, par immeuble et par mois)

type Vehicule = Pick<FicheVehicule, "id" | "nom" | "marque" | "modele" | "couleur" | "actif">;

export default function RapportImpots() {
  const anneeCourante = new Date().getFullYear();
  const [annee, setAnnee] = useState(anneeCourante);
  const [vehicules, setVehicules] = useState<Vehicule[]>([]);
  const [immeubles, setImmeubles] = useState<ImmeubleVeh[]>([]);
  const [enCours, setEnCours] = useState<{ bouton: string; etape: string } | null>(null);
  const [resultat, setResultat] = useState<{ type: "succes" | "erreur"; texte: string } | null>(null);

  useEffect(() => {
    (async () => {
      const [ve, im] = await Promise.all([
        supabase.from("vehicules").select("id, nom, marque, modele, couleur, actif").is("deleted_at", null).order("created_at"),
        supabase.from("immeubles").select("id, nom, nb_logements").is("deleted_at", null).eq("actif", true).order("nom"),
      ]);
      // Sans la migration 014 : seulement le nom
      const liste = ve.error
        ? (await supabase.from("vehicules").select("id, nom, actif").is("deleted_at", null).order("created_at")).data
        : ve.data;
      setVehicules(((liste ?? []) as Vehicule[]).sort((a, b) => Number(b.actif) - Number(a.actif)));
      setImmeubles((im.data ?? []) as ImmeubleVeh[]);
    })();
  }, []);

  async function lancer(bouton: string, travail: (etape: (t: string) => void) => Promise<string>) {
    setResultat(null);
    const etape = (t: string) => setEnCours({ bouton, etape: t });
    etape("Préparation…");
    try {
      setResultat({ type: "succes", texte: await travail(etape) });
    } catch (e) {
      setResultat({ type: "erreur", texte: `Export impossible : ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setEnCours(null);
    }
  }

  const exporterZip = () => lancer("zip", async (etape) => {
    etape("Lecture des dépenses…");
    const lignes = await chargerDepensesAnnee(annee);
    if (lignes.length === 0) return `Aucune dépense en ${annee}.`;
    const { exporterDossier } = await import("@/lib/exportDossier");
    const r = await exporterDossier(lignes, `dossier_depenses_${annee}-01-01_${annee}-12-31.zip`, etape, { annee, immeubleIds: [] });
    const vehicule = r.vehiculeCents ? ` Frais de véhicule inclus : ${formatCents(r.vehiculeCents)}.` : "";
    return r.manquants
      ? `Dossier créé : ${r.nbRecus} reçus, ${r.manquants} introuvable(s) (voir RECUS_MANQUANTS.txt).${vehicule}`
      : `Dossier créé avec ${r.nbRecus} reçu(s).${vehicule} Décompresse le ZIP avant d'ouvrir le fichier Excel.`;
  });

  const exporterCsv = () => lancer("csv", async (etape) => {
    etape("Lecture des dépenses…");
    const lignes = await chargerDepensesAnnee(annee);
    if (lignes.length === 0) return `Aucune dépense en ${annee}.`;
    exporterCsvDepenses(lignes, `depenses_${annee}-01-01_${annee}-12-31.csv`);
    return `Fichier CSV créé : ${lignes.length} ligne(s).`;
  });

  const exporterLoyers = () => lancer("loyers", async (etape) => {
    const { exporterLoyersAnnee } = await import("@/lib/exportLoyers");
    const r = await exporterLoyersAnnee(annee, etape);
    if (r.lignes === 0) return `Aucun loyer en ${annee}.`;
    return `Fichier créé : ${r.lignes} mois de loyer, ${formatCents(r.recu ?? 0)} reçus` +
      (r.omh ? `, dont ${formatCents(r.omh)} de l'OMH.` : ".");
  });

  const exporterVehicule = (v: Vehicule) => lancer(v.id, async (etape) => {
    const { exporterDossierVehicule } = await import("@/lib/exportVehicule");
    const r = await exporterDossierVehicule({ id: v.id, nom: nomVehicule(v) }, annee, immeubles, etape);
    return `Dossier ${nomVehicule(v)} ${annee} exporté : ${r.trajets} trajets, ${r.frais} frais${r.manquants ? `, ${r.manquants} reçu(s) manquant(s)` : ""}.`;
  });

  const libelle = (bouton: string, texte: string) => (enCours?.bouton === bouton ? enCours.etape : texte);

  return (
    <section className="carte">
      <div className="selecteur-mois">
        <button className="bouton" onClick={() => setAnnee(annee - 1)} aria-label="Année précédente">‹</button>
        <strong>{annee}</strong>
        <button className="bouton" onClick={() => setAnnee(annee + 1)} aria-label="Année suivante">›</button>
      </div>
      {annee !== anneeCourante && (
        <button className="lien-filtres" style={{ margin: "8px auto 0" }} onClick={() => setAnnee(anneeCourante)}>
          Revenir à l&apos;année courante
        </button>
      )}
      <p className="aide">Année civile complète : du 1er janvier au 31 décembre {annee}.</p>

      <strong style={{ display: "block", marginTop: 12 }}>Dépenses</strong>
      <button className="bouton principal plein" style={{ marginTop: 8 }} onClick={exporterZip} disabled={enCours !== null}>
        {libelle("zip", `Exporter les dépenses ${annee} + reçus (ZIP)`)}
      </button>
      <button className="bouton plein" style={{ marginTop: 8 }} onClick={exporterCsv} disabled={enCours !== null}>
        {libelle("csv", "Exporter en CSV seulement")}
      </button>
      <p className="aide">Le ZIP comprend aussi la part des immeubles des frais de véhicule (T776 ligne 9281).</p>

      <strong style={{ display: "block", marginTop: 16 }}>Loyers</strong>
      <button className="bouton plein" style={{ marginTop: 8 }} onClick={exporterLoyers} disabled={enCours !== null}>
        {libelle("loyers", `Revenus de loyers ${annee} (Excel)`)}
      </button>
      <p className="aide">Loyers dus et reçus par immeuble et par mois : part du locataire, supplément de l&apos;OMH et crédits.</p>

      {vehicules.length > 0 && (
        <>
          <strong style={{ display: "block", marginTop: 16 }}>Véhicules</strong>
          {vehicules.map((v) => (
            <button key={v.id} className="bouton plein" style={{ marginTop: 8 }} onClick={() => exporterVehicule(v)} disabled={enCours !== null}>
              {libelle(v.id, `Dossier véhicule ${annee} : ${nomVehicule(v)}${v.actif ? "" : " (vendu)"}`)}
            </button>
          ))}
          <p className="aide">Journal de bord, frais et reçus du véhicule, avec le pourcentage pour les immeubles.</p>
        </>
      )}

      {resultat && (
        <div className={`message ${resultat.type}`} style={{ marginTop: 12, marginBottom: 0 }}>{resultat.texte}</div>
      )}
    </section>
  );
}
