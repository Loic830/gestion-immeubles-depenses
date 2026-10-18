"use client";

import { useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { preparerFichier, type FichierPrepare } from "@/lib/image";
import { versCents, formatCents, centsVersSaisie } from "@/lib/argent";
import { finApresMois, triNumero, dateLisible } from "@/lib/dates";

// Formulaire partagé : Nouveau bail et Modifier le bail.
// Il valide la saisie et prépare le paramètre « p » des fonctions creer_bail,
// creer_bail_en_remplacement et modifier_bail (mêmes champs).

type Immeuble = { id: string; nom: string };
type Logement = { id: string; immeuble_id: string; numero: string };
type LocataireExistant = { id: string; prenom: string; nom: string };
/** existantId + modifiable : locataire déjà sur le bail, coordonnées corrigeables.
 *  existantId seul : locataire connu choisi dans la liste. */
export type LocataireForm = { cle: string; existantId: string; modifiable?: boolean; prenom: string; nom: string; telephone: string; courriel: string };
export type ExtraForm = { cle: string; libelle: string; montantSaisi: string; credit?: boolean }; // credit = déduit chaque mois
export type Duree = "12" | "autre" | "indeterminee";
export type Mode = "interac" | "cheque" | "prelevement" | "comptant";

export type ValeursBail = {
  logementId: string;
  locataires: LocataireForm[];
  dateDebut: string;
  duree: Duree;
  dateFinAutre: string;
  loyerSaisi: string;
  jourEcheance: string;
  mode: Mode;
  extras: ExtraForm[];
  inclusions: string;
  notes: string;
};

export type BailSaisi = {
  logement_id: string;
  date_debut: string;
  date_fin: string | null;
  loyer_cents: number;
  jour_echeance: number;
  mode_paiement: Mode;
  inclusions: string | null;
  notes: string | null;
  locataires: Record<string, string | null>[];
  extras: { libelle: string; montant_cents: number }[];
};

const MODES: { code: Mode; libelle: string }[] = [
  { code: "interac", libelle: "Virement Interac" },
  { code: "cheque", libelle: "Chèques postdatés" },
  { code: "prelevement", libelle: "Prélèvement" },
  { code: "comptant", libelle: "Comptant" },
];

export const nouveauLocataire = (): LocataireForm => ({ cle: crypto.randomUUID(), existantId: "", prenom: "", nom: "", telephone: "", courriel: "" });

/** Extras de la base (cents, négatif = crédit) → lignes du formulaire */
export function extrasVersForm(liste: { libelle: string; montant_cents: number }[]): ExtraForm[] {
  return liste.map((e) => ({
    cle: crypto.randomUUID(), libelle: e.libelle,
    montantSaisi: centsVersSaisie(Math.abs(e.montant_cents)), credit: e.montant_cents < 0,
  }));
}

/** Durée d'un bail existant : 12 mois si la fin tombe à 12 mois moins un jour */
export function dureeDe(debut: string, fin: string | null): Duree {
  if (!fin) return "indeterminee";
  return finApresMois(debut, 12) === fin ? "12" : "autre";
}

type Props = {
  initial: ValeursBail;
  titreLoyer?: string;
  aideLoyer?: string;
  avecPhotos: boolean;
  texteBouton: string;
  envoi: string | null;
  setErreur: (m: string | null) => void;
  onEnregistrer: (p: BailSaisi, pages: FichierPrepare[]) => void;
};

export default function FormulaireBail({ initial, titreLoyer, aideLoyer, avecPhotos, texteBouton, envoi, setErreur, onEnregistrer }: Props) {
  const [immeubles, setImmeubles] = useState<Immeuble[]>([]);
  const [logements, setLogements] = useState<Logement[]>([]);
  const [existants, setExistants] = useState<LocataireExistant[]>([]);

  const [logementId, setLogementId] = useState(initial.logementId);
  const [locataires, setLocataires] = useState<LocataireForm[]>(initial.locataires);
  const [dateDebut, setDateDebut] = useState(initial.dateDebut);
  const [duree, setDuree] = useState<Duree>(initial.duree);
  const [dateFinAutre, setDateFinAutre] = useState(initial.dateFinAutre);
  const [loyerSaisi, setLoyerSaisi] = useState(initial.loyerSaisi);
  const [jourEcheance, setJourEcheance] = useState(initial.jourEcheance);
  const [mode, setMode] = useState<Mode>(initial.mode);
  const [extras, setExtras] = useState<ExtraForm[]>(initial.extras);
  const [inclusions, setInclusions] = useState(initial.inclusions);
  const [notes, setNotes] = useState(initial.notes);

  const [pages, setPages] = useState<FichierPrepare[]>([]);
  const [traitement, setTraitement] = useState(false);
  const champPhoto = useRef<HTMLInputElement>(null);
  const champFichier = useRef<HTMLInputElement>(null);

  useEffect(() => {
    (async () => {
      const [im, lo, loc] = await Promise.all([
        supabase.from("immeubles").select("id, nom").is("deleted_at", null).order("nom"),
        supabase.from("logements").select("id, immeuble_id, numero").is("deleted_at", null).eq("actif", true),
        supabase.from("locataires").select("id, prenom, nom").is("deleted_at", null).order("nom"),
      ]);
      setImmeubles((im.data ?? []) as Immeuble[]);
      setLogements(((lo.data ?? []) as Logement[]).sort((a, b) => triNumero(a.numero, b.numero)));
      setExistants((loc.data ?? []) as LocataireExistant[]);
    })();
  }, []);

  const dateFin = duree === "12" ? (dateDebut ? finApresMois(dateDebut, 12) : "") : duree === "autre" ? dateFinAutre : "";
  const loyerCents = versCents(loyerSaisi);
  const signe = (e: ExtraForm) => (e.credit ? -1 : 1);
  const extrasCents = extras.reduce((s, e) => s + signe(e) * (versCents(e.montantSaisi) ?? 0), 0);

  async function ajouterPages(liste: FileList | null) {
    if (!liste || liste.length === 0) return;
    setErreur(null);
    setTraitement(true);
    try {
      const prepares: FichierPrepare[] = [];
      for (const f of Array.from(liste)) prepares.push(await preparerFichier(f));
      setPages((avant) => [...avant, ...prepares]);
    } catch (e) {
      setErreur(e instanceof Error ? e.message : "Erreur pendant le traitement de la photo.");
    } finally {
      setTraitement(false);
      if (champPhoto.current) champPhoto.current.value = "";
      if (champFichier.current) champFichier.current.value = "";
    }
  }

  function retirerPage(i: number) {
    setPages((avant) => {
      const copie = [...avant];
      const [retiree] = copie.splice(i, 1);
      if (retiree?.apercuUrl) URL.revokeObjectURL(retiree.apercuUrl);
      return copie;
    });
  }

  function majLocataire(cle: string, patch: Partial<LocataireForm>) {
    setLocataires((avant) => avant.map((l) => (l.cle === cle ? { ...l, ...patch } : l)));
  }
  function majExtra(cle: string, patch: Partial<ExtraForm>) {
    setExtras((avant) => avant.map((e) => (e.cle === cle ? { ...e, ...patch } : e)));
  }

  function enregistrer() {
    setErreur(null);
    if (!logementId) return setErreur("Choisis le logement.");
    if (!dateDebut) return setErreur("Entre la date de début.");
    if (duree === "autre" && !dateFinAutre) return setErreur("Entre la date de fin.");
    if (dateFin && dateFin < dateDebut) return setErreur("La date de fin est avant la date de début.");
    if (loyerCents === null) return setErreur("Entre le loyer mensuel (ex. 950,00).");
    const locs = locataires.filter((l) => l.existantId || l.prenom.trim() || l.nom.trim());
    if (locs.length === 0) return setErreur("Ajoute au moins un locataire.");
    if (locs.some((l) => (!l.existantId || l.modifiable) && (!l.prenom.trim() || !l.nom.trim()))) {
      return setErreur("Chaque locataire a besoin d'un prénom et d'un nom.");
    }
    const ext = extras.filter((e) => e.libelle.trim() || e.montantSaisi.trim());
    if (ext.some((e) => !e.libelle.trim() || !versCents(e.montantSaisi))) return setErreur("Chaque extra ou crédit a besoin d'un libellé et d'un montant.");
    if (loyerCents + extrasCents < 0) return setErreur("Les crédits dépassent le loyer : le total dû chaque mois ne peut pas être négatif.");

    onEnregistrer({
      logement_id: logementId,
      date_debut: dateDebut,
      date_fin: dateFin || null,
      loyer_cents: loyerCents,
      jour_echeance: Number(jourEcheance) || 1,
      mode_paiement: mode,
      inclusions: inclusions || null,
      notes: notes || null,
      locataires: locs.map((l) => l.existantId && !l.modifiable
        ? { id: l.existantId }
        : {
            ...(l.existantId ? { id: l.existantId } : {}),
            prenom: l.prenom, nom: l.nom, telephone: l.telephone || null, courriel: l.courriel || null,
          }),
      extras: ext.map((e) => ({ libelle: e.libelle, montant_cents: signe(e) * (versCents(e.montantSaisi) ?? 0) })),
    }, pages);
  }

  const logement = logements.find((l) => l.id === logementId);
  const immeubleDuLogement = immeubles.find((i) => i.id === logement?.immeuble_id);

  return (
    <>
      {/* Logement */}
      <section className="carte">
        <label htmlFor="logement">Logement</label>
        <select id="logement" value={logementId} onChange={(e) => setLogementId(e.target.value)}>
          <option value="">— Choisir —</option>
          {immeubles.map((im) => (
            <optgroup key={im.id} label={im.nom}>
              {logements.filter((l) => l.immeuble_id === im.id).map((l) => (
                <option key={l.id} value={l.id}>{im.nom} · {l.numero}</option>
              ))}
            </optgroup>
          ))}
        </select>
        {logement && <p className="aide">{immeubleDuLogement?.nom} · logement {logement.numero}</p>}
      </section>

      {/* Locataires */}
      <section className="carte">
        <strong>Locataires</strong>
        {locataires.map((l, i) => (
          <div key={l.cle} className={i > 0 ? "bloc-locataire" : ""} style={i === 0 ? { marginTop: 8 } : undefined}>
            <div className="entete" style={{ margin: "0 0 6px" }}>
              <span className="aide" style={{ margin: 0 }}>{i === 0 ? "Locataire principal" : `Colocataire ${i}`}</span>
              {locataires.length > 1 && (
                <button type="button" className="lien-retirer" onClick={() => setLocataires((a) => a.filter((x) => x.cle !== l.cle))}>Retirer</button>
              )}
            </div>
            {existants.length > 0 && !l.modifiable && (
              <select value={l.existantId} onChange={(e) => majLocataire(l.cle, { existantId: e.target.value })} aria-label="Locataire déjà connu">
                <option value="">Nouveau locataire</option>
                {existants.map((x) => <option key={x.id} value={x.id}>{x.prenom} {x.nom}</option>)}
              </select>
            )}
            {(!l.existantId || l.modifiable) && (
              <>
                <div className="rangee" style={{ marginTop: 8 }}>
                  <input placeholder="Prénom" autoComplete="off" value={l.prenom} aria-label="Prénom" onChange={(e) => majLocataire(l.cle, { prenom: e.target.value })} />
                  <input placeholder="Nom" autoComplete="off" value={l.nom} aria-label="Nom" onChange={(e) => majLocataire(l.cle, { nom: e.target.value })} />
                </div>
                <div className="rangee" style={{ marginTop: 8 }}>
                  <input placeholder="Téléphone" type="tel" inputMode="tel" autoComplete="off" value={l.telephone} aria-label="Téléphone" onChange={(e) => majLocataire(l.cle, { telephone: e.target.value })} />
                  <input placeholder="Courriel" type="email" autoComplete="off" value={l.courriel} aria-label="Courriel" onChange={(e) => majLocataire(l.cle, { courriel: e.target.value })} />
                </div>
              </>
            )}
            {i > 0 && (
              <button type="button" className="lien-filtres" style={{ marginTop: 6 }}
                      onClick={() => setLocataires((a) => [l, ...a.filter((x) => x.cle !== l.cle)])}>
                Mettre comme locataire principal
              </button>
            )}
          </div>
        ))}
        <button type="button" className="lien-filtres" onClick={() => setLocataires((a) => [...a, nouveauLocataire()])}>+ Ajouter un colocataire</button>
      </section>

      {/* Durée */}
      <section className="carte">
        <label htmlFor="debut">Début du bail</label>
        <input id="debut" type="date" value={dateDebut} onChange={(e) => setDateDebut(e.target.value)} />

        <label>Durée</label>
        <div className="choix">
          <button type="button" className={duree === "12" ? "actif" : ""} onClick={() => setDuree("12")}>12 mois</button>
          <button type="button" className={duree === "autre" ? "actif" : ""} onClick={() => setDuree("autre")}>Autre</button>
          <button type="button" className={duree === "indeterminee" ? "actif" : ""} onClick={() => setDuree("indeterminee")}>Indéterminée</button>
        </div>
        {duree === "autre" && (
          <>
            <label htmlFor="fin">Fin du bail</label>
            <input id="fin" type="date" value={dateFinAutre} onChange={(e) => setDateFinAutre(e.target.value)} />
          </>
        )}
        {duree === "12" && dateFin && <p className="aide">Fin le {dateLisible(dateFin)}.</p>}
        {duree === "indeterminee" && <p className="aide">Les loyers dus se prolongent automatiquement chaque mois.</p>}
      </section>

      {/* Loyer */}
      <section className="carte">
        <label htmlFor="loyer">{titreLoyer ?? "Loyer mensuel"}</label>
        <input id="loyer" className="montant-total" inputMode="decimal" placeholder="0,00" value={loyerSaisi} onChange={(e) => setLoyerSaisi(e.target.value)} />
        {aideLoyer && <p className="aide">{aideLoyer}</p>}

        <label>Extras et crédits chaque mois</label>
        {extras.map((e) => (
          <div className="rangee" key={e.cle} style={{ marginBottom: 8, alignItems: "center" }}>
            <input placeholder={e.credit ? "ex. Tonte de pelouse" : "ex. Stationnement"} value={e.libelle}
                   aria-label={e.credit ? "Raison du crédit" : "Libellé de l'extra"}
                   onChange={(ev) => majExtra(e.cle, { libelle: ev.target.value })} />
            <div style={{ position: "relative" }}>
              <span aria-hidden="true" style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", fontWeight: 700,
                                                color: e.credit ? "var(--succes)" : "var(--discret)" }}>{e.credit ? "−" : "+"}</span>
              <input placeholder="Montant" inputMode="decimal" value={e.montantSaisi} style={{ paddingLeft: 28, width: "100%" }}
                     aria-label={e.credit ? "Montant du crédit (déduit)" : "Montant de l'extra"}
                     onChange={(ev) => majExtra(e.cle, { montantSaisi: ev.target.value })} />
            </div>
            <button type="button" className="lien-retirer" style={{ flex: "0 0 auto" }} onClick={() => setExtras((a) => a.filter((x) => x.cle !== e.cle))} aria-label="Retirer l'extra">×</button>
          </div>
        ))}
        <button type="button" className="lien-filtres" style={{ marginTop: 0 }}
                onClick={() => setExtras((a) => [...a, { cle: crypto.randomUUID(), libelle: "", montantSaisi: "" }])}>
          + Ajouter un extra
        </button>
        <button type="button" className="lien-filtres" style={{ marginTop: 0 }}
                onClick={() => setExtras((a) => [...a, { cle: crypto.randomUUID(), libelle: "", montantSaisi: "", credit: true }])}>
          − Ajouter un crédit (ex. tonte de pelouse)
        </button>
        {loyerCents !== null && (
          <p className="aide"><strong>Total dû chaque mois : {formatCents(loyerCents + extrasCents)}</strong></p>
        )}

        <label>Mode de paiement</label>
        <div className="choix-2">
          {MODES.map((m) => (
            <button key={m.code} type="button" className={mode === m.code ? "actif" : ""} onClick={() => setMode(m.code)}>{m.libelle}</button>
          ))}
        </div>

        <label htmlFor="jour">Jour du mois où le loyer est dû</label>
        <input id="jour" inputMode="numeric" value={jourEcheance} onChange={(e) => setJourEcheance(e.target.value.replace(/\D/g, "").slice(0, 2))} />
      </section>

      {/* Copie du bail */}
      {avecPhotos && (
        <section className="carte">
          <strong>Bail signé</strong>
          <p className="aide">Facultatif : photographie chaque page du bail, ou joins le PDF. Tu pourras aussi le faire plus tard depuis la fiche.</p>
          <div className="rangee">
            <button type="button" className="bouton principal" onClick={() => champPhoto.current?.click()} disabled={traitement}>
              {traitement ? "Traitement…" : pages.length ? "+ Page" : "Photo du bail"}
            </button>
            <button type="button" className="bouton" onClick={() => champFichier.current?.click()} disabled={traitement}>
              Fichier ou PDF
            </button>
          </div>
          <input ref={champPhoto} type="file" accept="image/*" capture="environment" hidden onChange={(e) => ajouterPages(e.target.files)} />
          <input ref={champFichier} type="file" accept="image/*,application/pdf" multiple hidden onChange={(e) => ajouterPages(e.target.files)} />
          {pages.length > 0 && (
            <div className="photos">
              {pages.map((p, i) => (
                <div className="vignette" key={i}>
                  {p.apercuUrl ? <img src={p.apercuUrl} alt={`Bail, page ${i + 1}`} /> : "PDF"}
                  <button type="button" onClick={() => retirerPage(i)} aria-label="Retirer">×</button>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* Détails */}
      <section className="carte">
        <label htmlFor="inclusions">Inclusions (dans le loyer)</label>
        <input id="inclusions" placeholder="ex. chauffage, eau chaude, électroménagers" value={inclusions} onChange={(e) => setInclusions(e.target.value)} />
        <label htmlFor="notes">Notes</label>
        <textarea id="notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
      </section>

      <div className="barre-actions">
        <div className="contenu">
          <button className="bouton principal" onClick={enregistrer} disabled={envoi !== null || traitement}>
            {envoi ?? texteBouton}
          </button>
        </div>
      </div>
    </>
  );
}
