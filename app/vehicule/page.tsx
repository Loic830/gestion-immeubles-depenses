"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase, BUCKET_RECUS } from "@/lib/supabase";
import { useSession } from "@/lib/useSession";
import { formatCents, versCents } from "@/lib/argent";
import { aujourdhuiIso, dateLisible } from "@/lib/dates";
import { preparerFichier, type FichierPrepare } from "@/lib/image";
import { calculerResume, TYPES_FRAIS, MOTIFS, formatKm, type ImmeubleVeh } from "@/lib/vehicule";
import BarreOnglets from "@/components/BarreOnglets";
import ConstructeurTrajet, { type TrajetCompose } from "@/components/ConstructeurTrajet";

// Véhicule : journal de bord (km pour les immeubles), frais et relevés du compteur.
// La part déductible = frais × (km immeubles / km totaux), répartie entre les immeubles.

type Vehicule = { id: string; nom: string };
type Favori = { id: string; nom: string; km: number; immeuble_id: string | null; motif: string | null };
type Releve = { id: string; date_releve: string; km: number; note: string | null };
type Deplacement = { id: string; date_trajet: string; km: number; immeuble_id: string | null; motif: string; destination: string | null };
type Frais = {
  id: string; date_frais: string; type: string; montant_cents: number;
  fournisseur: string | null; notes: string | null; storage_key: string | null; mime_type: string | null;
};
type Onglet = "trajet" | "frais" | "compteur";

const CLE_VEHICULE = "vehicule-choisi";
const lire = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const ecrire = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* aperçu privé */ } };

function lireKm(t: string): number | null {
  const n = Number(t.replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 10) / 10 : null;
}

export default function PageVehicule() {
  const { session, pret } = useSession();
  const [vehicules, setVehicules] = useState<Vehicule[]>([]);
  const [vehiculeId, setVehiculeId] = useState("");
  const [immeubles, setImmeubles] = useState<ImmeubleVeh[]>([]);
  const [favoris, setFavoris] = useState<Favori[]>([]);
  const [releves, setReleves] = useState<Releve[]>([]);
  const [trajets, setTrajets] = useState<Deplacement[]>([]);
  const [frais, setFrais] = useState<Frais[]>([]);
  const [annee, setAnnee] = useState(new Date().getFullYear());
  const [onglet, setOnglet] = useState<Onglet>("trajet");
  const [chargement, setChargement] = useState(true);
  const [erreur, setErreur] = useState<string | null>(null);
  const [succes, setSucces] = useState<string | null>(null);
  const [envoi, setEnvoi] = useState(false);
  const [exportEtape, setExportEtape] = useState<string | null>(null);
  const [toutVoir, setToutVoir] = useState(false);

  // Nouveau véhicule
  const [nomVehicule, setNomVehicule] = useState("");

  // Trajet
  const [dateTrajet, setDateTrajet] = useState(aujourdhuiIso());
  const [immeubleTrajet, setImmeubleTrajet] = useState<string>("");
  const [kmTrajet, setKmTrajet] = useState("");
  const [motif, setMotif] = useState("");
  const [destination, setDestination] = useState("");
  const [garderFavori, setGarderFavori] = useState(false);
  const [composer, setComposer] = useState(false);
  const [etapesCompose, setEtapesCompose] = useState<string[] | null>(null);

  // Frais
  const [typeFrais, setTypeFrais] = useState("essence");
  const [montantFrais, setMontantFrais] = useState("");
  const [dateFrais, setDateFrais] = useState(aujourdhuiIso());
  const [fournisseur, setFournisseur] = useState("");
  const [notesFrais, setNotesFrais] = useState("");
  const [recu, setRecu] = useState<FichierPrepare | null>(null);
  const [traitement, setTraitement] = useState(false);
  const champPhoto = useRef<HTMLInputElement>(null);
  const champFichier = useRef<HTMLInputElement>(null);

  // Compteur
  const [dateReleve, setDateReleve] = useState(aujourdhuiIso());
  const [kmReleve, setKmReleve] = useState("");

  const chargerBase = useCallback(async () => {
    const [ve, im, fa] = await Promise.all([
      supabase.from("vehicules").select("id, nom").is("deleted_at", null).eq("actif", true).order("created_at"),
      supabase.from("immeubles").select("id, nom, nb_logements").is("deleted_at", null).eq("actif", true).order("nom"),
      supabase.from("trajets_favoris").select("id, nom, km, immeuble_id, motif").is("deleted_at", null).order("nom"),
    ]);
    const err = [ve, im, fa].find((r) => r.error)?.error;
    if (err) { setErreur(err.message); setChargement(false); return; }
    const liste = (ve.data ?? []) as Vehicule[];
    setVehicules(liste);
    setImmeubles((im.data ?? []) as ImmeubleVeh[]);
    setFavoris(((fa.data ?? []) as Favori[]).map((f) => ({ ...f, km: Number(f.km) })));
    const memo = lire(CLE_VEHICULE);
    setVehiculeId((actuel) => actuel || (liste.find((v) => v.id === memo)?.id ?? liste[0]?.id ?? ""));
    if (liste.length === 0) setChargement(false);
  }, []);

  const chargerVehicule = useCallback(async () => {
    if (!vehiculeId) return;
    const debut = `${annee}-01-01`;
    const fin = `${annee}-12-31`;
    const [re, de, fr] = await Promise.all([
      supabase.from("releves_odometre").select("id, date_releve, km, note").eq("vehicule_id", vehiculeId).is("deleted_at", null).order("date_releve"),
      supabase.from("deplacements").select("id, date_trajet, km, immeuble_id, motif, destination")
        .eq("vehicule_id", vehiculeId).is("deleted_at", null).gte("date_trajet", debut).lte("date_trajet", fin)
        .order("date_trajet", { ascending: false }).order("created_at", { ascending: false }),
      supabase.from("frais_vehicule").select("id, date_frais, type, montant_cents, fournisseur, notes, storage_key, mime_type")
        .eq("vehicule_id", vehiculeId).is("deleted_at", null).gte("date_frais", debut).lte("date_frais", fin)
        .order("date_frais", { ascending: false }),
    ]);
    const err = [re, de, fr].find((r) => r.error)?.error;
    if (err) setErreur(err.message);
    setReleves(((re.data ?? []) as Releve[]).map((r) => ({ ...r, km: Number(r.km) })));
    setTrajets(((de.data ?? []) as Deplacement[]).map((t) => ({ ...t, km: Number(t.km) })));
    setFrais((fr.data ?? []) as Frais[]);
    setChargement(false);
  }, [vehiculeId, annee]);

  useEffect(() => { if (session) chargerBase(); }, [session, chargerBase]);
  useEffect(() => { if (session && vehiculeId) chargerVehicule(); }, [session, vehiculeId, chargerVehicule]);

  const resume = useMemo(
    () => calculerResume(annee, releves, trajets, frais, immeubles),
    [annee, releves, trajets, frais, immeubles],
  );

  function confirmer(texte: string) {
    setSucces(texte);
    setTimeout(() => setSucces(null), 3500);
  }

  async function creerVehicule() {
    if (!nomVehicule.trim()) return setErreur("Donne un nom au véhicule (ex. Silverado 2019).");
    setErreur(null);
    const { data, error } = await supabase.from("vehicules").insert({ nom: nomVehicule.trim() }).select("id").single();
    if (error) return setErreur(error.message);
    setNomVehicule("");
    ecrire(CLE_VEHICULE, data.id);
    setVehiculeId(data.id);
    await chargerBase();
    setOnglet("compteur");
  }

  function choisirFavori(f: Favori) {
    setKmTrajet(String(f.km).replace(".", ","));
    setImmeubleTrajet(f.immeuble_id ?? "");
    setMotif(f.motif ?? motif);
    setDestination(f.nom);
    setGarderFavori(false);
    setEtapesCompose(null);
  }

  function utiliserCompose(t: TrajetCompose) {
    setKmTrajet(String(t.km).replace(".", ","));
    setDestination(t.nom);
    setImmeubleTrajet(t.immeubleId);
    setEtapesCompose(t.etapes);
    setGarderFavori(!favoris.some((f) => f.nom === t.nom));
    setComposer(false);
  }

  async function retirerFavori(f: Favori) {
    if (!window.confirm(`Retirer le trajet fréquent « ${f.nom} » ? (les trajets déjà inscrits restent)`)) return;
    await supabase.from("trajets_favoris").update({ deleted_at: new Date().toISOString() }).eq("id", f.id);
    setFavoris((l) => l.filter((x) => x.id !== f.id));
  }

  async function enregistrerTrajet() {
    const km = lireKm(kmTrajet);
    if (km === null) return setErreur("Entre les km du trajet aller-retour (ex. 12 ou 12,5).");
    if (!motif.trim()) return setErreur("Choisis ou écris le motif du déplacement (obligatoire pour l'impôt).");
    setErreur(null);
    setEnvoi(true);
    const { error } = await supabase.from("deplacements").insert({
      vehicule_id: vehiculeId, date_trajet: dateTrajet, km, immeuble_id: immeubleTrajet || null,
      motif: motif.trim(), destination: destination.trim() || null,
    });
    if (!error && garderFavori) {
      const nomFav = destination.trim() || (immeubles.find((i) => i.id === immeubleTrajet)?.nom ?? "Trajet");
      await supabase.from("trajets_favoris").insert({
        nom: nomFav, km, immeuble_id: immeubleTrajet || null, motif: motif.trim(), etapes: etapesCompose,
      });
      await chargerBase();
    }
    setEnvoi(false);
    if (error) return setErreur(error.message);
    setKmTrajet(""); setDestination(""); setGarderFavori(false); setEtapesCompose(null);
    if (dateTrajet.slice(0, 4) !== String(annee)) setAnnee(Number(dateTrajet.slice(0, 4)));
    else await chargerVehicule();
    confirmer(`Trajet de ${formatKm(km)} inscrit.`);
  }

  async function choisirRecu(liste: FileList | null) {
    if (!liste || liste.length === 0) return;
    setTraitement(true);
    try {
      if (recu?.apercuUrl) URL.revokeObjectURL(recu.apercuUrl);
      setRecu(await preparerFichier(liste[0]));
    } catch (e) {
      setErreur(e instanceof Error ? e.message : String(e));
    } finally {
      setTraitement(false);
      if (champPhoto.current) champPhoto.current.value = "";
      if (champFichier.current) champFichier.current.value = "";
    }
  }

  async function enregistrerFrais() {
    const cents = versCents(montantFrais);
    if (cents === null || cents <= 0) return setErreur("Entre le montant total du reçu (ex. 85,40).");
    setErreur(null);
    setEnvoi(true);
    try {
      let storage_key: string | null = null;
      if (recu) {
        const d = new Date();
        const ext = recu.mimeType === "application/pdf" ? "pdf" : "jpg";
        storage_key = `vehicule/${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${crypto.randomUUID()}.${ext}`;
        const up = await supabase.storage.from(BUCKET_RECUS).upload(storage_key, recu.principal, { contentType: recu.mimeType, upsert: false });
        if (up.error) throw new Error(`Envoi du reçu impossible : ${up.error.message}`);
      }
      const { error } = await supabase.from("frais_vehicule").insert({
        vehicule_id: vehiculeId, date_frais: dateFrais, type: typeFrais, montant_cents: cents,
        fournisseur: fournisseur.trim() || null, notes: notesFrais.trim() || null,
        storage_key, mime_type: recu?.mimeType ?? null,
      });
      if (error) throw new Error(error.message);
      if (recu?.apercuUrl) URL.revokeObjectURL(recu.apercuUrl);
      setRecu(null); setMontantFrais(""); setFournisseur(""); setNotesFrais("");
      if (dateFrais.slice(0, 4) !== String(annee)) setAnnee(Number(dateFrais.slice(0, 4)));
      else await chargerVehicule();
      confirmer(`${TYPES_FRAIS.find((t) => t.code === typeFrais)?.libelle} : ${formatCents(cents)} inscrit.`);
    } catch (e) {
      setErreur(e instanceof Error ? e.message : String(e));
    } finally {
      setEnvoi(false);
    }
  }

  async function enregistrerReleve() {
    const km = Number(kmReleve.replace(/\s/g, ""));
    if (!Number.isInteger(km) || km < 0) return setErreur("Entre le kilométrage du compteur, sans décimale (ex. 128450).");
    const precedent = [...releves].filter((r) => r.date_releve < dateReleve).pop();
    if (precedent && km < precedent.km && !window.confirm(
      `Ce relevé (${km.toLocaleString("fr-CA")} km) est plus bas que celui du ${dateLisible(precedent.date_releve)} (${precedent.km.toLocaleString("fr-CA")} km). Continuer ?`,
    )) return;
    setErreur(null);
    setEnvoi(true);
    const { error } = await supabase.from("releves_odometre").insert({ vehicule_id: vehiculeId, date_releve: dateReleve, km });
    setEnvoi(false);
    if (error) {
      return setErreur(error.message.includes("releves_odometre_jour") ? "Il y a déjà un relevé à cette date. Retire-le d'abord." : error.message);
    }
    setKmReleve("");
    await chargerVehicule();
    confirmer("Relevé du compteur inscrit.");
  }

  async function retirer(table: "deplacements" | "frais_vehicule" | "releves_odometre", id: string, texte: string) {
    if (!window.confirm(`Retirer ${texte} ? (erreur de saisie)`)) return;
    const { error } = await supabase.from(table).update({ deleted_at: new Date().toISOString() }).eq("id", id);
    if (error) return setErreur(error.message);
    await chargerVehicule();
  }

  async function ouvrirRecu(f: Frais) {
    if (!f.storage_key) return;
    const { data } = await supabase.storage.from(BUCKET_RECUS).createSignedUrl(f.storage_key, 600);
    if (data?.signedUrl) window.open(data.signedUrl, "_blank");
  }

  async function exporter() {
    const v = vehicules.find((x) => x.id === vehiculeId);
    if (!v) return;
    setErreur(null);
    try {
      const r = await exporterDossierVehiculeDiffere(v, annee, immeubles, setExportEtape);
      confirmer(`Dossier ${annee} exporté : ${r.trajets} trajets, ${r.frais} frais${r.manquants ? `, ${r.manquants} reçu(s) manquant(s)` : ""}.`);
    } catch (e) {
      setErreur(e instanceof Error ? e.message : String(e));
    } finally {
      setExportEtape(null);
    }
  }

  if (!pret || !session) return null;

  const nomImmeuble = (id: string | null) => (id ? immeubles.find((i) => i.id === id)?.nom ?? "" : "Plusieurs immeubles");
  const libelleType = (c: string) => TYPES_FRAIS.find((t) => t.code === c)?.libelle ?? c;
  const anneeCourante = new Date().getFullYear();
  const releveDebutManquant = resume.kmDebut === null;
  const trajetsAffiches = toutVoir ? trajets : trajets.slice(0, 15);

  return (
    <main className="page avec-onglets">
      <div className="entete">
        <h1>Véhicule</h1>
        {vehicules.length > 1 && (
          <select value={vehiculeId} aria-label="Véhicule" style={{ width: "auto" }}
                  onChange={(e) => { setVehiculeId(e.target.value); ecrire(CLE_VEHICULE, e.target.value); }}>
            {vehicules.map((v) => <option key={v.id} value={v.id}>{v.nom}</option>)}
          </select>
        )}
      </div>

      {erreur && <div className="message erreur">{erreur}</div>}
      {succes && <div className="message succes">{succes}</div>}
      {chargement && <p className="aide">Chargement…</p>}

      {!chargement && vehicules.length === 0 && (
        <section className="carte">
          <strong>Ajouter ton véhicule</strong>
          <p className="aide">
            Pour déduire les frais de véhicule au prorata : inscris chaque déplacement pour les immeubles,
            les frais (essence, entretien, assurance…) et le compteur au début et à la fin de l&apos;année.
          </p>
          <label htmlFor="nom-vehicule">Nom du véhicule</label>
          <input id="nom-vehicule" placeholder="ex. Silverado 2019" value={nomVehicule} onChange={(e) => setNomVehicule(e.target.value)} />
          <button className="bouton principal plein" style={{ marginTop: 12 }} onClick={creerVehicule}>Ajouter</button>
        </section>
      )}

      {vehiculeId && !chargement && (
        <>
          {/* Année + résumé */}
          <section className="carte">
            <div className="selecteur-mois">
              <button className="bouton" onClick={() => setAnnee(annee - 1)} aria-label="Année précédente">‹</button>
              <strong>{annee}</strong>
              <button className="bouton" onClick={() => setAnnee(annee + 1)} aria-label="Année suivante" disabled={annee >= anneeCourante}>›</button>
            </div>

            <div className="total-periode" style={{ marginTop: 12 }}>
              Usage pour les immeubles :{" "}
              <strong>{resume.pourcentage === null ? "—" : `${(resume.pourcentage * 100).toLocaleString("fr-CA", { maximumFractionDigits: 1 })} %`}</strong>
            </div>
            {resume.pourcentage !== null && (
              <div className="repartition-barre" style={{ marginTop: 8 }}><span style={{ width: `${resume.pourcentage * 100}%` }} /></div>
            )}
            <dl className="champs" style={{ marginTop: 12 }}>
              <dt>Km immeubles</dt><dd>{formatKm(resume.kmImmeubles)}</dd>
              <dt>Km totaux</dt><dd>{resume.kmTotal === null ? "Relevés à compléter" : formatKm(resume.kmTotal)}{resume.provisoire && resume.kmTotal !== null ? " (à ce jour)" : ""}</dd>
              <dt>Frais (100 %)</dt><dd>{formatCents(resume.fraisTotal)}</dd>
              <dt>Part déductible</dt><dd>{resume.deductible === null ? "—" : formatCents(resume.deductible)}</dd>
            </dl>
            {resume.deductible !== null && resume.deductible > 0 && (
              <p className="aide">
                {resume.parImmeuble.filter((p) => p.deductible > 0).map((p) => `${p.nom} ${formatCents(p.deductible)}`).join(" · ")}
              </p>
            )}
            {releveDebutManquant && (
              <div className="message alerte" style={{ marginTop: 10, marginBottom: 0 }}>
                Inscris le compteur du 1er janvier {annee} (ou de la date d&apos;achat) dans « Compteur » : sans lui, le pourcentage ne peut pas se calculer.
              </div>
            )}
            {!releveDebutManquant && resume.provisoire && annee < anneeCourante && (
              <div className="message alerte" style={{ marginTop: 10, marginBottom: 0 }}>Il manque le relevé du compteur au 31 décembre {annee}.</div>
            )}
            {resume.incoherent && (
              <div className="message erreur" style={{ marginTop: 10, marginBottom: 0 }}>
                Le journal compte plus de km que le compteur : vérifie les relevés ou un trajet en double.
              </div>
            )}
            <button className="bouton plein" style={{ marginTop: 12 }} onClick={exporter} disabled={exportEtape !== null}>
              {exportEtape ?? `Exporter ${annee} pour le comptable (Excel + reçus)`}
            </button>
          </section>

          {/* Saisie */}
          <div className="choix" style={{ marginBottom: 12 }}>
            <button type="button" className={onglet === "trajet" ? "actif" : ""} onClick={() => setOnglet("trajet")}>Trajet</button>
            <button type="button" className={onglet === "frais" ? "actif" : ""} onClick={() => setOnglet("frais")}>Frais</button>
            <button type="button" className={onglet === "compteur" ? "actif" : ""} onClick={() => setOnglet("compteur")}>Compteur</button>
          </div>

          {onglet === "trajet" && (
            <section className="carte">
              {composer ? (
                <ConstructeurTrajet
                  onUtiliser={utiliserCompose}
                  onFavoriCree={async () => { setComposer(false); await chargerBase(); confirmer("Trajet fréquent ajouté."); }}
                  onFermer={() => setComposer(false)}
                />
              ) : (
                <button type="button" className="bouton plein" style={{ marginBottom: 12 }} onClick={() => setComposer(true)}>
                  Composer un trajet (Maison → Gauthier → Rona…)
                </button>
              )}
              {!composer && favoris.length > 0 && (
                <>
                  <strong>Trajets fréquents</strong>
                  <div className="puces">
                    {favoris.map((f) => (
                      <span key={f.id} className="puce">
                        <button type="button" onClick={() => choisirFavori(f)}>{f.nom} · {formatKm(f.km)}</button>
                        <button type="button" className="puce-retirer" aria-label={`Retirer ${f.nom}`} onClick={() => retirerFavori(f)}>×</button>
                      </span>
                    ))}
                  </div>
                </>
              )}
              <label>Immeuble</label>
              <div className="choix-2">
                {immeubles.map((im) => (
                  <button key={im.id} type="button" className={immeubleTrajet === im.id ? "actif" : ""} onClick={() => setImmeubleTrajet(im.id)}>{im.nom}</button>
                ))}
                <button type="button" className={immeubleTrajet === "" ? "actif" : ""} onClick={() => setImmeubleTrajet("")}>Plusieurs</button>
              </div>
              <div className="rangee" style={{ marginTop: 8 }}>
                <div>
                  <label htmlFor="km-trajet">Km aller-retour</label>
                  <input id="km-trajet" inputMode="decimal" className="montant-total" placeholder="0" value={kmTrajet} onChange={(e) => setKmTrajet(e.target.value)} />
                </div>
                <div>
                  <label htmlFor="date-trajet">Date</label>
                  <input id="date-trajet" type="date" value={dateTrajet} onChange={(e) => setDateTrajet(e.target.value)} />
                </div>
              </div>
              <label>Motif</label>
              <div className="puces">
                {MOTIFS.map((m) => (
                  <span key={m} className={`puce${motif === m ? " actif" : ""}`}>
                    <button type="button" onClick={() => setMotif(m)}>{m}</button>
                  </span>
                ))}
              </div>
              <input aria-label="Motif" placeholder="ou écrire un autre motif" value={motif} onChange={(e) => setMotif(e.target.value)} style={{ marginTop: 8 }} />
              <label htmlFor="destination">Destination / détail (facultatif)</label>
              <input id="destination" placeholder="ex. Maison → Gauthier → BMR" value={destination} onChange={(e) => setDestination(e.target.value)} />
              <label className="case">
                <input type="checkbox" checked={garderFavori} onChange={(e) => setGarderFavori(e.target.checked)} />
                Garder comme trajet fréquent
              </label>
              <button className="bouton principal plein" style={{ marginTop: 12 }} onClick={enregistrerTrajet} disabled={envoi}>
                {envoi ? "Enregistrement…" : "Inscrire le trajet"}
              </button>
            </section>
          )}

          {onglet === "frais" && (
            <section className="carte">
              <label>Type de frais</label>
              <select value={typeFrais} onChange={(e) => setTypeFrais(e.target.value)}>
                {TYPES_FRAIS.map((t) => <option key={t.code} value={t.code}>{t.libelle}</option>)}
              </select>
              <div className="rangee" style={{ marginTop: 8 }}>
                <div>
                  <label htmlFor="montant-frais">Montant total (100 %)</label>
                  <input id="montant-frais" inputMode="decimal" className="montant-total" placeholder="0,00" value={montantFrais} onChange={(e) => setMontantFrais(e.target.value)} />
                </div>
                <div>
                  <label htmlFor="date-frais">Date</label>
                  <input id="date-frais" type="date" value={dateFrais} onChange={(e) => setDateFrais(e.target.value)} />
                </div>
              </div>
              <label htmlFor="fournisseur-frais">Fournisseur (facultatif)</label>
              <input id="fournisseur-frais" placeholder="ex. Esso, Garage Tremblay, SAAQ" value={fournisseur} onChange={(e) => setFournisseur(e.target.value)} />
              <label htmlFor="notes-frais">Notes (facultatif)</label>
              <input id="notes-frais" placeholder="ex. changement d'huile, pneus d'hiver" value={notesFrais} onChange={(e) => setNotesFrais(e.target.value)} />
              <label>Reçu</label>
              <div className="rangee">
                <button type="button" className="bouton" onClick={() => champPhoto.current?.click()} disabled={traitement}>
                  {traitement ? "Traitement…" : recu ? "Reprendre la photo" : "Photo du reçu"}
                </button>
                <button type="button" className="bouton" onClick={() => champFichier.current?.click()} disabled={traitement}>Fichier ou PDF</button>
              </div>
              <input ref={champPhoto} type="file" accept="image/*" capture="environment" hidden onChange={(e) => choisirRecu(e.target.files)} />
              <input ref={champFichier} type="file" accept="image/*,application/pdf" hidden onChange={(e) => choisirRecu(e.target.files)} />
              {recu && (
                <div className="photos">
                  <div className="vignette">
                    {recu.apercuUrl ? <img src={recu.apercuUrl} alt="Reçu" /> : "PDF"}
                    <button type="button" aria-label="Retirer le reçu" onClick={() => { if (recu.apercuUrl) URL.revokeObjectURL(recu.apercuUrl); setRecu(null); }}>×</button>
                  </div>
                </div>
              )}
              <p className="aide">Entre le montant complet : l&apos;app calcule la part des immeubles selon tes km.</p>
              <button className="bouton principal plein" style={{ marginTop: 8 }} onClick={enregistrerFrais} disabled={envoi || traitement}>
                {envoi ? "Enregistrement…" : "Inscrire les frais"}
              </button>
            </section>
          )}

          {onglet === "compteur" && (
            <section className="carte">
              <p className="aide" style={{ marginTop: 0 }}>
                Inscris le compteur le 1er janvier et le 31 décembre (ou à l&apos;achat et à la vente du véhicule).
                Un relevé de temps en temps pendant l&apos;année aide à suivre le pourcentage.
              </p>
              <div className="rangee">
                <div>
                  <label htmlFor="km-releve">Compteur (km)</label>
                  <input id="km-releve" inputMode="numeric" className="montant-total" placeholder="ex. 128450" value={kmReleve} onChange={(e) => setKmReleve(e.target.value)} />
                </div>
                <div>
                  <label htmlFor="date-releve">Date</label>
                  <input id="date-releve" type="date" value={dateReleve} onChange={(e) => setDateReleve(e.target.value)} />
                </div>
              </div>
              <button className="bouton principal plein" style={{ marginTop: 12 }} onClick={enregistrerReleve} disabled={envoi}>
                {envoi ? "Enregistrement…" : "Inscrire le relevé"}
              </button>
              {releves.length > 0 && (
                <div style={{ marginTop: 12 }}>
                  {[...releves].reverse().map((r) => (
                    <div className="paiement-ligne" key={r.id}>
                      <span>{dateLisible(r.date_releve)} · <strong>{r.km.toLocaleString("fr-CA")} km</strong></span>
                      <button className="lien-retirer" onClick={() => retirer("releves_odometre", r.id, "ce relevé")}>Retirer</button>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}

          {/* Listes de l'année */}
          {onglet === "trajet" && (
            <section className="carte">
              <div className="entete" style={{ marginBottom: 4 }}>
                <strong>Trajets {annee}</strong>
                <span className="aide" style={{ margin: 0 }}>{trajets.length} · {formatKm(resume.kmImmeubles)}</span>
              </div>
              {trajets.length === 0 && <p className="aide">Aucun trajet inscrit pour {annee}.</p>}
              {trajetsAffiches.map((t) => (
                <div className="liste-depense" key={t.id}>
                  <div className="infos">
                    <div className="titre">{nomImmeuble(t.immeuble_id)} · {t.motif}</div>
                    <div className="sous">{dateLisible(t.date_trajet)}{t.destination ? ` · ${t.destination}` : ""}</div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div className="montant">{formatKm(t.km)}</div>
                    <button className="lien-retirer" onClick={() => retirer("deplacements", t.id, "ce trajet")}>Retirer</button>
                  </div>
                </div>
              ))}
              {trajets.length > 15 && !toutVoir && (
                <button className="lien-filtres" style={{ margin: "8px auto 0" }} onClick={() => setToutVoir(true)}>Voir les {trajets.length} trajets</button>
              )}
            </section>
          )}

          {onglet === "frais" && (
            <section className="carte">
              <div className="entete" style={{ marginBottom: 4 }}>
                <strong>Frais {annee}</strong>
                <span className="aide" style={{ margin: 0 }}>{formatCents(resume.fraisTotal)}</span>
              </div>
              {frais.length === 0 && <p className="aide">Aucun frais inscrit pour {annee}.</p>}
              {frais.map((f) => (
                <div className="liste-depense" key={f.id}>
                  <div className="infos">
                    <div className="titre">{libelleType(f.type)}{f.fournisseur ? ` · ${f.fournisseur}` : ""}</div>
                    <div className="sous">
                      {dateLisible(f.date_frais)}{f.notes ? ` · ${f.notes}` : ""}
                      {f.storage_key && <> · <button className="lien-ligne" style={{ display: "inline", width: "auto", color: "var(--accent)", textDecoration: "underline" }} onClick={() => ouvrirRecu(f)}>reçu</button></>}
                    </div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div className="montant">{formatCents(f.montant_cents)}</div>
                    <button className="lien-retirer" onClick={() => retirer("frais_vehicule", f.id, "ces frais")}>Retirer</button>
                  </div>
                </div>
              ))}
            </section>
          )}

          <details className="carte">
            <summary><strong>Ce qui est déductible</strong></summary>
            <p className="aide">
              Avec des immeubles sur au moins deux sites, les frais de véhicule pour percevoir les loyers, superviser
              des travaux ou gérer les immeubles sont déductibles au prorata des km. Les trajets personnels et
              maison-travail ne comptent pas. Garde le journal de bord et les reçus (6 ans).
            </p>
            <p className="aide">
              L&apos;amortissement du véhicule (DPA, catégorie 10 ou 10.1) n&apos;est pas calculé ici : ton comptable l&apos;ajoute
              à partir du coût d&apos;achat. Il ne peut pas créer ni augmenter une perte de location.
            </p>
            {vehicules.length > 0 && (
              <div className="bloc-locataire">
                <label htmlFor="autre-vehicule">Ajouter un autre véhicule</label>
                <div className="rangee">
                  <input id="autre-vehicule" placeholder="Nom du véhicule" value={nomVehicule} onChange={(e) => setNomVehicule(e.target.value)} />
                  <button className="bouton" style={{ flex: "0 0 auto" }} onClick={creerVehicule}>Ajouter</button>
                </div>
              </div>
            )}
          </details>
        </>
      )}

      <BarreOnglets />
    </main>
  );
}

// ExcelJS et JSZip ne sont chargés qu'au clic
async function exporterDossierVehiculeDiffere(...args: Parameters<typeof import("@/lib/exportVehicule").exporterDossierVehicule>) {
  const { exporterDossierVehicule } = await import("@/lib/exportVehicule");
  return exporterDossierVehicule(...args);
}
