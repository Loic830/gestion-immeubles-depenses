"use client";

import { useState } from "react";
import { supabase } from "@/lib/supabase";
import { nomVehicule, type FicheVehicule } from "@/lib/vehicule";

// Ajouter ou modifier un véhicule : marque, modèle, couleur, année (v0.9.0).
// Le nom affiché partout (onglet Véhicules, exports, notifications) = marque + modèle + couleur.

type Champs = Pick<FicheVehicule, "marque" | "modele" | "couleur" | "annee">;

export default function FormulaireVehicule({
  vehicule, onEnregistre, onAnnuler, libelle,
}: {
  vehicule?: (Champs & { id: string; nom: string }) | null;
  onEnregistre: (id: string) => void;
  onAnnuler?: () => void;
  libelle?: string;
}) {
  const [marque, setMarque] = useState(vehicule?.marque ?? "");
  const [modele, setModele] = useState(vehicule?.modele ?? "");
  const [couleur, setCouleur] = useState(vehicule?.couleur ?? "");
  const [annee, setAnnee] = useState(vehicule?.annee ? String(vehicule.annee) : "");
  const [erreur, setErreur] = useState<string | null>(null);
  const [envoi, setEnvoi] = useState(false);

  async function enregistrer(e: React.FormEvent) {
    e.preventDefault();
    if (!marque.trim() || !modele.trim()) return setErreur("La marque et le modèle sont obligatoires (ex. Ford, F-150).");
    const a = annee.trim() ? Number(annee.trim()) : null;
    if (a !== null && (!Number.isInteger(a) || a < 1950 || a > 2100)) return setErreur("Année invalide (ex. 2019).");
    setErreur(null);
    setEnvoi(true);
    const champs = {
      marque: marque.trim(), modele: modele.trim(), couleur: couleur.trim() || null, annee: a,
      nom: nomVehicule({ marque, modele, couleur }),
    };
    const r = vehicule
      ? await supabase.from("vehicules").update(champs).eq("id", vehicule.id).select("id").single()
      : await supabase.from("vehicules").insert(champs).select("id").single();
    setEnvoi(false);
    if (r.error || !r.data) {
      return setErreur(r.error?.message.includes("marque")
        ? "Exécuter supabase/014_vehicules_actifs.sql pour la marque, le modèle et la couleur."
        : `Enregistrement impossible : ${r.error?.message}`);
    }
    onEnregistre(r.data.id);
  }

  return (
    <form onSubmit={enregistrer}>
      {erreur && <div className="message erreur">{erreur}</div>}
      <div className="rangee">
        <div>
          <label htmlFor="v-marque">Marque</label>
          <input id="v-marque" placeholder="ex. Ford" value={marque} onChange={(e) => setMarque(e.target.value)} />
        </div>
        <div>
          <label htmlFor="v-modele">Modèle</label>
          <input id="v-modele" placeholder="ex. F-150" value={modele} onChange={(e) => setModele(e.target.value)} />
        </div>
      </div>
      <div className="rangee">
        <div>
          <label htmlFor="v-couleur">Couleur</label>
          <input id="v-couleur" placeholder="ex. Noir" value={couleur} onChange={(e) => setCouleur(e.target.value)} />
        </div>
        <div>
          <label htmlFor="v-annee">Année</label>
          <input id="v-annee" inputMode="numeric" placeholder="ex. 2019" value={annee} onChange={(e) => setAnnee(e.target.value)} />
        </div>
      </div>
      {(marque.trim() || modele.trim()) && (
        <p className="aide">Nom affiché : <strong>{nomVehicule({ marque, modele, couleur })}</strong></p>
      )}
      <div className="rangee" style={{ marginTop: 12 }}>
        {onAnnuler && <button type="button" className="bouton" onClick={onAnnuler}>Annuler</button>}
        <button className="bouton principal" disabled={envoi}>
          {envoi ? "Enregistrement…" : libelle ?? (vehicule ? "Enregistrer" : "Ajouter le véhicule")}
        </button>
      </div>
    </form>
  );
}
