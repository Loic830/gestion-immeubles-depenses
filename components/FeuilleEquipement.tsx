"use client";

import { useState } from "react";
import { supabase } from "@/lib/supabase";
import { centsVersSaisie, versCents } from "@/lib/argent";
import { aujourdhuiIso, dateLisible } from "@/lib/dates";
import { datePrevue, nomEquipement, prochainEntretien, TYPES_EQUIPEMENT, typeEquipement, type Equipement } from "@/lib/entretien";

// Feuille « Équipement » (v0.9.16) : ajouter, modifier ou remplacer un équipement
// (chauffe-eau, fournaise, toiture…) d'un immeuble ou d'un de ses logements.
// Remplacer = RPC remplacer_equipement : l'ancien garde sa date de retrait (historique),
// le nouveau est créé au même endroit, installé à la date choisie.

export type LogementEq = { id: string; numero: string; immeuble_id: string };
export type ImmeubleEq = { id: string; nom: string };

type Props = {
  immeubles: ImmeubleEq[];
  logements: LogementEq[];
  equipement?: Equipement;              // modifier
  immeubleId?: string;                  // ajout : immeuble proposé
  onFermer: () => void;
  onEnregistre: (texte: string) => void;
};

const nombre = (v: string) => (v.trim() === "" ? null : Number(v.trim()));

export default function FeuilleEquipement({ immeubles, logements, equipement, immeubleId, onFermer, onEnregistre }: Props) {
  const e0 = equipement;
  const [remplacement, setRemplacement] = useState(false);

  const [immeuble, setImmeuble] = useState(e0?.immeuble_id ?? immeubleId ?? immeubles[0]?.id ?? "");
  const [logement, setLogement] = useState(e0?.logement_id ?? "");
  const [type, setType] = useState(e0?.type ?? "chauffe_eau");
  const [nom, setNom] = useState(e0?.nom ?? "");
  const [installation, setInstallation] = useState(e0?.date_installation ?? "");
  const [duree, setDuree] = useState(e0 ? (e0.duree_vie_ans?.toString() ?? "") : String(typeEquipement("chauffe_eau")?.dureeVie ?? ""));
  const [datePrevueMain, setDatePrevueMain] = useState(e0?.date_remplacement ?? "");
  const [entretienMois, setEntretienMois] = useState(e0?.entretien_mois?.toString() ?? "");
  const [entretienQuoi, setEntretienQuoi] = useState(e0?.entretien_quoi ?? "");
  const [dernierEntretien, setDernierEntretien] = useState(e0?.dernier_entretien ?? "");
  const [marque, setMarque] = useState(e0?.marque ?? "");
  const [modele, setModele] = useState(e0?.modele ?? "");
  const [noSerie, setNoSerie] = useState(e0?.no_serie ?? "");
  const [garantie, setGarantie] = useState(e0?.garantie_fin ?? "");
  const [cout, setCout] = useState(centsVersSaisie(e0?.cout_cents ?? null));
  const [fournisseur, setFournisseur] = useState(e0?.fournisseur ?? "");
  const [notes, setNotes] = useState(e0?.notes ?? "");

  const [erreur, setErreur] = useState<string | null>(null);
  const [envoi, setEnvoi] = useState(false);

  const t = typeEquipement(type);
  const logementsImmeuble = logements.filter((l) => l.immeuble_id === immeuble);
  const dureeNb = nombre(duree);
  const prevueCalculee = datePrevue({ date_remplacement: null, date_installation: installation || null, duree_vie_ans: dureeNb });
  const prochain = prochainEntretien({ entretien_mois: nombre(entretienMois), dernier_entretien: dernierEntretien || null, date_installation: installation || null });

  function changerType(code: string) {
    // La durée de vie suit le type tant qu'elle n'a pas été changée à la main
    const ancien = typeEquipement(type)?.dureeVie;
    if (duree === "" || duree === String(ancien ?? "")) setDuree(String(typeEquipement(code)?.dureeVie ?? ""));
    setType(code);
  }

  /** Passe la feuille en « Remplacé » : nouvel équipement prérempli, installé aujourd'hui. */
  function commencerRemplacement() {
    setRemplacement(true);
    setErreur(null);
    setInstallation(aujourdhuiIso());
    setDuree(String(e0?.duree_vie_ans ?? t?.dureeVie ?? ""));
    setDatePrevueMain("");
    setDernierEntretien("");
    setNoSerie("");
    setGarantie("");
    setCout("");
    setNotes("");
  }

  function valeurs() {
    const coutCents = cout.trim() ? versCents(cout) : null;
    if (cout.trim() && coutCents === null) throw new Error("Coût invalide (ex. 1 250,00).");
    if (dureeNb !== null && (!Number.isInteger(dureeNb) || dureeNb < 1 || dureeNb > 100)) throw new Error("Durée de vie : un nombre d'années, de 1 à 100.");
    const mois = nombre(entretienMois);
    if (mois !== null && (!Number.isInteger(mois) || mois < 1 || mois > 120)) throw new Error("Entretien : un nombre de mois, de 1 à 120.");
    if (type === "autre" && !nom.trim()) throw new Error("Pour « Autre », écris ce que c'est (ex. Asphalte du stationnement).");
    return {
      immeuble_id: immeuble,
      logement_id: logement || null,
      type,
      nom: nom.trim() || null,
      marque: marque.trim() || null,
      modele: modele.trim() || null,
      no_serie: noSerie.trim() || null,
      date_installation: installation || null,
      duree_vie_ans: dureeNb,
      date_remplacement: datePrevueMain || null,
      garantie_fin: garantie || null,
      cout_cents: coutCents,
      fournisseur: fournisseur.trim() || null,
      entretien_mois: mois,
      entretien_quoi: mois ? entretienQuoi.trim() || null : null,
      dernier_entretien: mois ? dernierEntretien || null : null,
      notes: notes.trim() || null,
    };
  }

  async function enregistrer(ev: React.FormEvent) {
    ev.preventDefault();
    setErreur(null);
    if (!immeuble) return setErreur("Choisis l'immeuble.");
    let v;
    try {
      v = valeurs();
    } catch (e) {
      return setErreur(e instanceof Error ? e.message : String(e));
    }
    setEnvoi(true);
    let error;
    if (remplacement && e0) {
      if (!installation) { setEnvoi(false); return setErreur("Entre la date du remplacement."); }
      ({ error } = await supabase.rpc("remplacer_equipement", { p_id: e0.id, p: v }));
    } else if (e0) {
      ({ error } = await supabase.from("equipements").update(v).eq("id", e0.id));
    } else {
      ({ error } = await supabase.from("equipements").insert(v));
    }
    setEnvoi(false);
    if (error) return setErreur(error.message);
    onEnregistre(remplacement ? `${nomEquipement(v)} remplacé. L'ancien reste dans l'historique.` : e0 ? "Équipement modifié." : "Équipement ajouté.");
  }

  async function entretienFait() {
    if (!e0) return;
    const { error } = await supabase.from("equipements").update({ dernier_entretien: aujourdhuiIso() }).eq("id", e0.id);
    if (error) return setErreur(error.message);
    onEnregistre(`Entretien noté aujourd'hui. Prochain : ${dateLisible(prochainEntretien({ ...e0, dernier_entretien: aujourdhuiIso() }))}.`);
  }

  async function retirer() {
    if (!e0 || !window.confirm("Retirer cet équipement ? (erreur de saisie)")) return;
    const { error } = await supabase.from("equipements").update({ deleted_at: new Date().toISOString() }).eq("id", e0.id);
    if (error) return setErreur(error.message);
    onEnregistre("Équipement retiré.");
  }

  const nomImmeuble = immeubles.find((i) => i.id === immeuble)?.nom ?? "";
  const retire = !!e0?.date_retrait;
  const titre = remplacement ? `Remplacer : ${nomEquipement(e0!)}` : e0 ? nomEquipement(e0) : "Nouvel équipement";

  return (
    <div className="voile" onClick={onFermer}>
      <form className="feuille" onClick={(e) => e.stopPropagation()} onSubmit={enregistrer} role="dialog" aria-label="Équipement">
        <div className="entete" style={{ marginBottom: 4 }}>
          <strong>{titre}{nomImmeuble ? ` · ${nomImmeuble}` : ""}</strong>
          <button type="button" className="lien-retirer" style={{ color: "var(--discret)" }} onClick={onFermer}>Fermer</button>
        </div>
        {erreur && <div className="message erreur" style={{ marginTop: 8 }}>{erreur}</div>}
        {retire && (
          <p className="aide">Remplacé le {dateLisible(e0!.date_retrait)} : cette fiche reste pour l&apos;historique, sans alerte.</p>
        )}
        {remplacement && (
          <p className="aide">
            L&apos;ancien {nomEquipement(e0!).toLocaleLowerCase("fr-CA")} reste dans l&apos;historique (retiré à la date du remplacement).
            Entre le nouveau.
          </p>
        )}

        {!e0 && (
          <>
            <label htmlFor="eq-immeuble">Immeuble</label>
            <select id="eq-immeuble" value={immeuble} onChange={(e) => { setImmeuble(e.target.value); setLogement(""); }}>
              {immeubles.map((i) => <option key={i.id} value={i.id}>{i.nom}</option>)}
            </select>
          </>
        )}
        {!remplacement && (
          <>
            <label htmlFor="eq-ou">Où</label>
            <select id="eq-ou" value={logement} onChange={(e) => setLogement(e.target.value)}>
              <option value="">Parties communes (tout l&apos;immeuble)</option>
              {logementsImmeuble.map((l) => <option key={l.id} value={l.id}>Logement {l.numero}</option>)}
            </select>

            <label htmlFor="eq-type">Équipement</label>
            <select id="eq-type" value={type} onChange={(e) => changerType(e.target.value)}>
              {TYPES_EQUIPEMENT.map((x) => <option key={x.code} value={x.code}>{x.nom}</option>)}
            </select>
          </>
        )}

        <label htmlFor="eq-nom">{type === "autre" ? "C'est quoi ?" : "Précision (facultatif)"}</label>
        <input id="eq-nom" value={nom} onChange={(e) => setNom(e.target.value)}
               placeholder={type === "autre" ? "ex. Asphalte du stationnement" : "ex. 60 gallons, au sous-sol"} />

        <div className="rangee">
          <div>
            <label htmlFor="eq-install">{remplacement ? "Date du remplacement" : "Installé le"}</label>
            <input id="eq-install" type="date" value={installation} onChange={(e) => setInstallation(e.target.value)} />
          </div>
          <div>
            <label htmlFor="eq-duree">Durée de vie (ans)</label>
            <input id="eq-duree" inputMode="numeric" value={duree} onChange={(e) => setDuree(e.target.value)} placeholder="10" />
          </div>
        </div>
        {!installation && <p className="aide">Pas sûr de la date ? Mets l&apos;année approximative (ex. 1er janvier 2015), ou seulement une date de remplacement prévue.</p>}

        <label htmlFor="eq-prevue">À remplacer vers</label>
        <input id="eq-prevue" type="date" value={datePrevueMain} onChange={(e) => setDatePrevueMain(e.target.value)} />
        <p className="aide">
          {datePrevueMain
            ? <>Date inscrite à la main. <button type="button" className="lien-filtres" style={{ padding: 0 }} onClick={() => setDatePrevueMain("")}>Revenir au calcul</button></>
            : prevueCalculee
              ? `Calculé : ${dateLisible(prevueCalculee)} (installation + ${dureeNb} ans). Laisse vide pour garder le calcul.`
              : "Laisse vide : la date se calcule avec l'installation et la durée de vie."}
          {" "}Alerte 6 mois et 2 mois avant, puis une fois si la date est passée.
        </p>

        <details className="details-equipement" open={!!entretienMois}>
          <summary>Entretien régulier (facultatif)</summary>
          {t?.entretien && !entretienMois && (
            <button type="button" className="bouton plein" style={{ marginTop: 8 }}
                    onClick={() => { setEntretienMois(String(t.entretien!.mois)); setEntretienQuoi(t.entretien!.quoi); }}>
              Suggestion : {t.entretien.quoi.toLocaleLowerCase("fr-CA")} aux {t.entretien.mois} mois
            </button>
          )}
          <div className="rangee">
            <div>
              <label htmlFor="eq-ent-quoi">Quoi faire</label>
              <input id="eq-ent-quoi" value={entretienQuoi} onChange={(e) => setEntretienQuoi(e.target.value)} placeholder="ex. Vidanger" />
            </div>
            <div>
              <label htmlFor="eq-ent-mois">Aux combien de mois</label>
              <input id="eq-ent-mois" inputMode="numeric" value={entretienMois} onChange={(e) => setEntretienMois(e.target.value)} placeholder="12" />
            </div>
          </div>
          {entretienMois && !remplacement && (
            <>
              <label htmlFor="eq-ent-dernier">Dernier entretien</label>
              <input id="eq-ent-dernier" type="date" value={dernierEntretien} onChange={(e) => setDernierEntretien(e.target.value)} />
            </>
          )}
          {prochain && <p className="aide">Prochain entretien : {dateLisible(prochain)} (alerte 14 jours avant).</p>}
        </details>

        <details className="details-equipement">
          <summary>Marque, garantie, coût (facultatif)</summary>
          <div className="rangee">
            <div>
              <label htmlFor="eq-marque">Marque</label>
              <input id="eq-marque" value={marque} onChange={(e) => setMarque(e.target.value)} placeholder="ex. Giant" />
            </div>
            <div>
              <label htmlFor="eq-modele">Modèle</label>
              <input id="eq-modele" value={modele} onChange={(e) => setModele(e.target.value)} />
            </div>
          </div>
          <label htmlFor="eq-serie">No de série</label>
          <input id="eq-serie" value={noSerie} onChange={(e) => setNoSerie(e.target.value)} />
          <div className="rangee">
            <div>
              <label htmlFor="eq-garantie">Garantie jusqu&apos;au</label>
              <input id="eq-garantie" type="date" value={garantie} onChange={(e) => setGarantie(e.target.value)} />
            </div>
            <div>
              <label htmlFor="eq-cout">Coût ($)</label>
              <input id="eq-cout" inputMode="decimal" value={cout} onChange={(e) => setCout(e.target.value)} placeholder="0,00" />
            </div>
          </div>
          <label htmlFor="eq-fournisseur">Installé par</label>
          <input id="eq-fournisseur" value={fournisseur} onChange={(e) => setFournisseur(e.target.value)} placeholder="ex. Plomberie Alma" />
          <label htmlFor="eq-notes">Notes</label>
          <input id="eq-notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </details>

        <button className="bouton principal plein" style={{ marginTop: 16 }} disabled={envoi}>
          {envoi ? "Enregistrement…" : remplacement ? "Enregistrer le remplacement" : "Enregistrer"}
        </button>
        {e0 && !remplacement && !retire && (
          <>
            {e0.entretien_mois && (
              <button type="button" className="bouton plein" style={{ marginTop: 8 }} onClick={entretienFait}>
                Entretien fait aujourd&apos;hui
              </button>
            )}
            <button type="button" className="bouton plein" style={{ marginTop: 8 }} onClick={commencerRemplacement}>
              Remplacé (nouvel équipement)
            </button>
          </>
        )}
        {remplacement && (
          <button type="button" className="bouton plein" style={{ marginTop: 8 }} onClick={onFermer}>Annuler</button>
        )}
        {e0 && !remplacement && (
          <button type="button" className="bouton plein lien-danger" style={{ marginTop: 8 }} onClick={retirer}>Retirer (erreur de saisie)</button>
        )}
      </form>
    </div>
  );
}
