"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { useSession } from "@/lib/useSession";
import { aujourdhuiIso, dateLisible } from "@/lib/dates";
import { formatCents, versCents } from "@/lib/argent";
import { nomVehicule, type FicheVehicule } from "@/lib/vehicule";
import BarreOnglets from "@/components/BarreOnglets";
import FormulaireVehicule from "@/components/FormulaireVehicule";

// Détail d'un véhicule (Profil > Actifs > Véhicules, v0.9.0) : marque, modèle, couleur, année ;
// « Marquer comme vendu » (date, prix ; il reste dans l'historique et les exports des années passées) ;
// « Supprimer ce véhicule » (suppression douce de ses trajets, frais et relevés : RPC supprimer_vehicule).

type Message = { type: "succes" | "erreur" | "alerte"; texte: string } | null;

export default function PageDetailVehicule() {
  const { session, pret } = useSession();
  const router = useRouter();
  const { id } = useParams<{ id: string }>();

  const [vehicule, setVehicule] = useState<FicheVehicule | null>(null);
  const [migration014, setMigration014] = useState(true);
  const [msg, setMsg] = useState<Message>(null);
  const [cle, setCle] = useState(0); // recrée le formulaire après un enregistrement

  const [vente, setVente] = useState(false);
  const [dateVente, setDateVente] = useState(aujourdhuiIso());
  const [prixVente, setPrixVente] = useState("");

  const [suppression, setSuppression] = useState<{ trajets: number; frais: number; releves: number } | null>(null);
  const [envoi, setEnvoi] = useState(false);

  useEffect(() => {
    if (!session || !id) return;
    charger();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, id]);

  async function charger() {
    const { data, error } = await supabase.from("vehicules").select("*").eq("id", id).is("deleted_at", null).single();
    if (error || !data) return setMsg({ type: "erreur", texte: "Véhicule introuvable." });
    setMigration014("marque" in data);
    setVehicule({ marque: null, modele: null, couleur: null, annee: null, date_vente: null, prix_vente_cents: null, ...data } as FicheVehicule);
    setCle((c) => c + 1);
  }

  async function marquerVendu(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    const prix = prixVente.trim() ? versCents(prixVente) : null;
    if (prixVente.trim() && prix === null) return setMsg({ type: "erreur", texte: "Prix de vente invalide." });
    if (!dateVente) return setMsg({ type: "erreur", texte: "La date de vente est obligatoire." });
    if (!window.confirm(`Marquer ${nomVehicule(vehicule ?? {})} comme vendu le ${dateLisible(dateVente)} ? Ses trajets et frais restent dans l'historique.`)) return;
    const { error } = await supabase.from("vehicules")
      .update({ actif: false, date_vente: dateVente, prix_vente_cents: prix }).eq("id", id);
    if (error) return setMsg({ type: "erreur", texte: error.message });
    setVente(false);
    setMsg({ type: "succes", texte: "Véhicule marqué comme vendu. Inscris le compteur à la date de vente dans l'onglet Véhicules." });
    await charger();
  }

  async function annulerVente() {
    if (!window.confirm("Annuler la vente (erreur de saisie) et remettre le véhicule en usage ?")) return;
    const { error } = await supabase.from("vehicules")
      .update({ actif: true, date_vente: null, prix_vente_cents: null }).eq("id", id);
    if (error) return setMsg({ type: "erreur", texte: error.message });
    setMsg({ type: "succes", texte: "Véhicule remis en usage." });
    await charger();
  }

  async function preparerSuppression() {
    setMsg(null);
    const compter = (table: string) => supabase.from(table).select("id", { count: "exact", head: true })
      .eq("vehicule_id", id).is("deleted_at", null);
    const [t, f, r] = await Promise.all([compter("deplacements"), compter("frais_vehicule"), compter("releves_odometre")]);
    setSuppression({ trajets: t.count ?? 0, frais: f.count ?? 0, releves: r.count ?? 0 });
  }

  async function supprimer() {
    setEnvoi(true);
    const { error } = await supabase.rpc("supprimer_vehicule", { p_id: id });
    setEnvoi(false);
    if (error) {
      return setMsg({
        type: "erreur",
        texte: error.message.includes("supprimer_vehicule") ? "Exécuter supabase/014_vehicules_actifs.sql pour supprimer un véhicule." : error.message,
      });
    }
    router.replace("/profil");
  }

  if (!pret || !session) return null;
  const nom = vehicule ? nomVehicule(vehicule) : "Véhicule";

  return (
    <main className="page avec-onglets">
      <div className="entete">
        <h1>{nom}</h1>
        <Link href="/profil" className="bouton">‹ Profil</Link>
      </div>

      {msg && <div className={`message ${msg.type}`}>{msg.texte}</div>}
      {!migration014 && (
        <div className="message alerte">Exécuter supabase/014_vehicules_actifs.sql pour la marque, le modèle, la vente et la suppression.</div>
      )}

      {vehicule && !vehicule.actif && (
        <div className="carte">
          <strong>Vendu{vehicule.date_vente ? ` le ${dateLisible(vehicule.date_vente)}` : ""}</strong>
          {vehicule.prix_vente_cents != null && <p className="aide">Prix de vente : {formatCents(vehicule.prix_vente_cents)}</p>}
          <button className="bouton" style={{ marginTop: 8 }} onClick={annulerVente}>Annuler la vente</button>
        </div>
      )}

      {vehicule && (
        <div className="carte">
          <FormulaireVehicule
            key={cle}
            vehicule={vehicule}
            libelle="Enregistrer"
            onEnregistre={async () => { setMsg({ type: "succes", texte: "Véhicule enregistré." }); await charger(); }}
          />
        </div>
      )}

      {vehicule && migration014 && (
        <div style={{ marginTop: 24 }}>
          {vehicule.actif && (!vente ? (
            <button className="bouton plein lien-danger" onClick={() => setVente(true)}>Marquer comme vendu</button>
          ) : (
            <form className="carte" onSubmit={marquerVendu}>
              <div className="rangee">
                <div>
                  <label htmlFor="date-vente">Date de vente</label>
                  <input id="date-vente" type="date" value={dateVente} onChange={(e) => setDateVente(e.target.value)} />
                </div>
                <div>
                  <label htmlFor="prix">Prix de vente ($)</label>
                  <input id="prix" inputMode="decimal" value={prixVente} onChange={(e) => setPrixVente(e.target.value)} />
                </div>
              </div>
              <p className="aide">Le véhicule n&apos;est plus proposé pour les nouveaux trajets ; ses années passées restent dans les exports.</p>
              <div className="rangee" style={{ marginTop: 12 }}>
                <button type="button" className="bouton" onClick={() => setVente(false)}>Annuler</button>
                <button className="bouton principal">Confirmer la vente</button>
              </div>
            </form>
          ))}

          {!suppression ? (
            <button className="bouton plein lien-danger" onClick={preparerSuppression}>Supprimer ce véhicule</button>
          ) : (
            <div className="carte bordure-danger">
              <strong>Supprimer {nom} de partout ?</strong>
              <p className="aide">
                Seront retirés : {suppression.trajets} trajet(s), {suppression.frais} frais et {suppression.releves} relevé(s) du compteur,
                ainsi que ses notifications. Ils ne compteront plus dans les exports, même pour les années passées.
              </p>
              <p className="aide">Si le véhicule a été vendu, utilise plutôt « Marquer comme vendu » : son historique reste pour l&apos;impôt.</p>
              <div className="rangee" style={{ marginTop: 12 }}>
                <button type="button" className="bouton" onClick={() => setSuppression(null)}>Annuler</button>
                <button type="button" className="bouton principal danger" onClick={supprimer} disabled={envoi}>
                  {envoi ? "Suppression…" : "Oui, supprimer"}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      <BarreOnglets />
    </main>
  );
}
