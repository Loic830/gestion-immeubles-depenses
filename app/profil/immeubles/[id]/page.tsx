"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { useSession } from "@/lib/useSession";
import { aujourdhuiIso, dateLisible, triNumero } from "@/lib/dates";
import { centsVersSaisie, formatCents, versCents } from "@/lib/argent";
import BarreOnglets from "@/components/BarreOnglets";

// Détail d'un immeuble : nom, adresse, achat, logements (numéros, ajout, désactivation), vente.
// Rien n'est supprimé : un logement se désactive, un immeuble vendu passe à actif = false
// et reste visible dans l'historique (loyers, dépenses, baux).

type Immeuble = {
  id: string;
  nom: string;
  adresse: string | null;
  actif: boolean;
  date_acquisition: string | null;
  // Colonnes ajoutées par supabase/010_profil_actifs.sql (absentes avant la migration)
  valeur_achat_cents?: number | null;
  date_vente?: string | null;
  prix_vente_cents?: number | null;
};
type Logement = { id: string; numero: string; actif: boolean };
type Message = { type: "succes" | "erreur" | "alerte"; texte: string } | null;

export default function PageDetailImmeuble() {
  const { session, pret } = useSession();
  const { id } = useParams<{ id: string }>();

  const [immeuble, setImmeuble] = useState<Immeuble | null>(null);
  const [migration010, setMigration010] = useState(true);
  const [logements, setLogements] = useState<Logement[]>([]);
  const [numeros, setNumeros] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<Message>(null);

  const [nom, setNom] = useState("");
  const [adresse, setAdresse] = useState("");
  const [dateAchat, setDateAchat] = useState("");
  const [valeurAchat, setValeurAchat] = useState("");
  const [nvNumero, setNvNumero] = useState("");

  const [vente, setVente] = useState(false);
  const [dateVente, setDateVente] = useState(aujourdhuiIso());
  const [prixVente, setPrixVente] = useState("");

  useEffect(() => {
    if (!session || !id) return;
    charger();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, id]);

  async function charger() {
    const [im, lg] = await Promise.all([
      supabase.from("immeubles").select("*").eq("id", id).single(),
      supabase.from("logements").select("id, numero, actif").eq("immeuble_id", id).is("deleted_at", null),
    ]);
    if (im.error || !im.data) {
      setMsg({ type: "erreur", texte: "Immeuble introuvable." });
      return;
    }
    const i = im.data as Immeuble;
    setImmeuble(i);
    setMigration010("date_vente" in i);
    setNom(i.nom);
    setAdresse(i.adresse ?? "");
    setDateAchat(i.date_acquisition ?? "");
    setValeurAchat(centsVersSaisie(i.valeur_achat_cents ?? null));
    const liste = ((lg.data ?? []) as Logement[]).sort((a, b) => triNumero(a.numero, b.numero));
    setLogements(liste);
    setNumeros(Object.fromEntries(liste.map((l) => [l.id, l.numero])));
  }

  /** Garde nb_logements (utilisé pour la répartition au prorata) égal au nombre de logements actifs. */
  async function synchroniserNb() {
    const { count } = await supabase.from("logements").select("id", { count: "exact", head: true })
      .eq("immeuble_id", id).is("deleted_at", null).eq("actif", true);
    if (count !== null) await supabase.from("immeubles").update({ nb_logements: count }).eq("id", id);
  }

  async function enregistrerImmeuble(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    if (!nom.trim()) return setMsg({ type: "erreur", texte: "Le nom est obligatoire." });
    const maj: Record<string, unknown> = {
      nom: nom.trim(),
      adresse: adresse.trim() || null,
      date_acquisition: dateAchat || null,
    };
    if (migration010) {
      const v = valeurAchat.trim() ? versCents(valeurAchat) : null;
      if (valeurAchat.trim() && v === null) return setMsg({ type: "erreur", texte: "Valeur d'achat invalide." });
      maj.valeur_achat_cents = v;
    }
    const { error } = await supabase.from("immeubles").update(maj).eq("id", id);
    if (error) {
      return setMsg({ type: "erreur", texte: error.code === "23505" ? "Un autre immeuble porte déjà ce nom." : error.message });
    }
    setMsg({ type: "succes", texte: "Immeuble enregistré." });
    await charger();
  }

  async function enregistrerNumeros() {
    setMsg(null);
    const changes = logements.filter((l) => (numeros[l.id] ?? "").trim() !== l.numero);
    if (changes.length === 0) return setMsg({ type: "alerte", texte: "Aucun numéro modifié." });
    if (changes.some((l) => !(numeros[l.id] ?? "").trim())) {
      return setMsg({ type: "erreur", texte: "Un numéro ne peut pas être vide." });
    }
    for (const l of changes) {
      const { error } = await supabase.from("logements").update({ numero: numeros[l.id].trim() }).eq("id", l.id);
      if (error) {
        await charger();
        return setMsg({
          type: "erreur",
          texte: error.code === "23505"
            ? `Le numéro « ${numeros[l.id].trim()} » existe déjà dans cet immeuble. Pour échanger deux numéros, passe d'abord par un numéro temporaire (ex. « 99 »).`
            : error.message,
        });
      }
    }
    setMsg({ type: "succes", texte: "Numéros enregistrés. Les baux, loyers et dépenses suivent automatiquement." });
    await charger();
  }

  async function ajouterLogement(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    const n = nvNumero.trim();
    if (!n) return;
    const { error } = await supabase.from("logements").insert({ immeuble_id: id, numero: n });
    if (error) {
      return setMsg({ type: "erreur", texte: error.code === "23505" ? `Le logement « ${n} » existe déjà.` : error.message });
    }
    setNvNumero("");
    await synchroniserNb();
    await charger();
  }

  async function basculerLogement(l: Logement) {
    setMsg(null);
    if (l.actif) {
      // Refuser si un bail est en cours ou à venir sur ce logement
      const { data } = await supabase.from("baux").select("date_fin, date_depart")
        .eq("logement_id", l.id).is("deleted_at", null);
      const auj = aujourdhuiIso();
      const enCours = ((data ?? []) as { date_fin: string | null; date_depart: string | null }[])
        .some((b) => { const fin = b.date_depart ?? b.date_fin; return fin === null || fin >= auj; });
      if (enCours) {
        return setMsg({ type: "erreur", texte: `Le logement ${l.numero} a un bail en cours ou à venir : termine-le d'abord dans Baux.` });
      }
      if (!window.confirm(`Désactiver le logement ${l.numero} ? Il n'apparaîtra plus dans les nouvelles saisies ; son historique est gardé.`)) return;
    }
    const { error } = await supabase.from("logements").update({ actif: !l.actif }).eq("id", l.id);
    if (error) return setMsg({ type: "erreur", texte: error.message });
    await synchroniserNb();
    await charger();
  }

  async function marquerVendu(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    const prix = prixVente.trim() ? versCents(prixVente) : null;
    if (prixVente.trim() && prix === null) return setMsg({ type: "erreur", texte: "Prix de vente invalide." });
    if (!dateVente) return setMsg({ type: "erreur", texte: "La date de vente est obligatoire." });
    if (!window.confirm(`Marquer ${immeuble?.nom} comme vendu le ${dateLisible(dateVente)} ? Il disparaîtra des nouvelles saisies, mais tout son historique reste.`)) return;
    const { error } = await supabase.from("immeubles")
      .update({ actif: false, date_vente: dateVente, prix_vente_cents: prix }).eq("id", id);
    if (error) return setMsg({ type: "erreur", texte: error.message });
    setVente(false);
    setMsg({ type: "succes", texte: "Immeuble marqué comme vendu." });
    await charger();
  }

  async function annulerVente() {
    if (!window.confirm("Annuler la vente (erreur de saisie) et remettre l'immeuble actif ?")) return;
    const { error } = await supabase.from("immeubles")
      .update({ actif: true, date_vente: null, prix_vente_cents: null }).eq("id", id);
    if (error) return setMsg({ type: "erreur", texte: error.message });
    setMsg({ type: "succes", texte: "Immeuble remis actif." });
    await charger();
  }

  if (!pret || !session) return null;

  const actifs = logements.filter((l) => l.actif);
  const inactifs = logements.filter((l) => !l.actif);

  return (
    <main className="page avec-onglets">
      <div className="entete">
        <h1>{immeuble?.nom ?? "Immeuble"}</h1>
        <Link href="/profil" className="bouton">‹ Profil</Link>
      </div>

      {msg && <div className={`message ${msg.type}`}>{msg.texte}</div>}
      {!migration010 && (
        <div className="message alerte">
          Exécuter supabase/010_profil_actifs.sql pour la valeur d&apos;achat et la vente.
        </div>
      )}

      {immeuble && !immeuble.actif && (
        <div className="carte">
          <strong>Vendu{immeuble.date_vente ? ` le ${dateLisible(immeuble.date_vente)}` : ""}</strong>
          {immeuble.prix_vente_cents != null && <p className="aide">Prix de vente : {formatCents(immeuble.prix_vente_cents)}</p>}
          <button className="bouton" style={{ marginTop: 8 }} onClick={annulerVente}>Annuler la vente</button>
        </div>
      )}

      <form className="carte" onSubmit={enregistrerImmeuble}>
        <label htmlFor="nom">Nom</label>
        <input id="nom" value={nom} onChange={(e) => setNom(e.target.value)} />
        <label htmlFor="adresse">Adresse</label>
        <input id="adresse" value={adresse} onChange={(e) => setAdresse(e.target.value)} autoComplete="street-address" />
        <div className="rangee">
          <div>
            <label htmlFor="date-achat">Date d&apos;achat</label>
            <input id="date-achat" type="date" value={dateAchat} onChange={(e) => setDateAchat(e.target.value)} />
          </div>
          <div>
            <label htmlFor="valeur">Valeur d&apos;achat ($)</label>
            <input id="valeur" inputMode="decimal" value={valeurAchat} disabled={!migration010}
                   onChange={(e) => setValeurAchat(e.target.value)} placeholder="640 000,00" />
          </div>
        </div>
        <div style={{ marginTop: 16 }}>
          <button className="bouton principal plein">Enregistrer</button>
        </div>
      </form>

      <Link href={`/frais-fixes?i=${id}`} className="carte ligne-actif" style={{ display: "flex" }}>
        <div className="infos">
          <div className="titre">Frais fixes</div>
          <div className="sous">Hypothèques, assurances et taxes de cet immeuble</div>
        </div>
        <span aria-hidden="true">›</span>
      </Link>

      <h2 className="immeuble-titre">Logements ({actifs.length})</h2>
      <div className="carte">
        {actifs.map((l) => (
          <div key={l.id} className="ligne-logement">
            <input aria-label={`Numéro du logement ${l.numero}`} value={numeros[l.id] ?? ""}
                   onChange={(e) => setNumeros({ ...numeros, [l.id]: e.target.value })} />
            <button type="button" className="bouton" onClick={() => basculerLogement(l)}>Désactiver</button>
          </div>
        ))}
        {actifs.length > 0 && (
          <button type="button" className="bouton plein" style={{ marginTop: 4 }} onClick={enregistrerNumeros}>
            Enregistrer les numéros
          </button>
        )}
        <form onSubmit={ajouterLogement} className="ligne-logement" style={{ marginTop: 16, marginBottom: 0 }}>
          <input aria-label="Numéro du nouveau logement" value={nvNumero}
                 onChange={(e) => setNvNumero(e.target.value)} placeholder="Nouveau numéro" />
          <button className="bouton">+ Ajouter</button>
        </form>
      </div>

      {inactifs.length > 0 && (
        <details className="carte">
          <summary>Logements désactivés ({inactifs.length})</summary>
          {inactifs.map((l) => (
            <div key={l.id} className="ligne-logement" style={{ marginTop: 8 }}>
              <span>Logement {l.numero}</span>
              <button type="button" className="bouton" onClick={() => basculerLogement(l)}>Réactiver</button>
            </div>
          ))}
        </details>
      )}

      {immeuble?.actif && migration010 && (
        <div style={{ marginTop: 24 }}>
          {!vente ? (
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
              <p className="aide">L&apos;immeuble est archivé, jamais supprimé : loyers, dépenses et baux restent dans l&apos;historique.</p>
              <div className="rangee" style={{ marginTop: 12 }}>
                <button type="button" className="bouton" onClick={() => setVente(false)}>Annuler</button>
                <button className="bouton principal">Confirmer la vente</button>
              </div>
            </form>
          )}
        </div>
      )}

      <BarreOnglets />
    </main>
  );
}
