"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { supabase, BUCKET_RECUS } from "@/lib/supabase";
import { preparerFichier, type FichierPrepare } from "@/lib/image";
import { useSession } from "@/lib/useSession";
import { versCents, formatCents } from "@/lib/argent";
import { finApresMois, prochainPremierJuillet, triNumero, dateLisible, aujourdhuiIso } from "@/lib/dates";

type Immeuble = { id: string; nom: string };
type Logement = { id: string; immeuble_id: string; numero: string };
type LocataireExistant = { id: string; prenom: string; nom: string };
type LocataireForm = { cle: string; existantId: string; prenom: string; nom: string; telephone: string; courriel: string };
type ExtraForm = { cle: string; libelle: string; montantSaisi: string };
type Duree = "12" | "autre" | "indeterminee";
type Mode = "interac" | "cheque" | "prelevement" | "comptant";

const MODES: { code: Mode; libelle: string }[] = [
  { code: "interac", libelle: "Virement Interac" },
  { code: "cheque", libelle: "Chèques postdatés" },
  { code: "prelevement", libelle: "Prélèvement" },
  { code: "comptant", libelle: "Comptant" },
];

const nouveauLocataire = (): LocataireForm => ({ cle: crypto.randomUUID(), existantId: "", prenom: "", nom: "", telephone: "", courriel: "" });

export default function PageNouveauBail() {
  return (
    <Suspense fallback={null}>
      <NouveauBail />
    </Suspense>
  );
}

function NouveauBail() {
  const router = useRouter();
  const params = useSearchParams();
  const { session, pret } = useSession();

  const [immeubles, setImmeubles] = useState<Immeuble[]>([]);
  const [logements, setLogements] = useState<Logement[]>([]);
  const [existants, setExistants] = useState<LocataireExistant[]>([]);

  const [logementId, setLogementId] = useState(params.get("logement") ?? "");
  const [locataires, setLocataires] = useState<LocataireForm[]>([nouveauLocataire()]);
  // ?debut=AAAA-MM-JJ : arrivée depuis « Entrer le nouveau bail » (lendemain du départ)
  const [dateDebut, setDateDebut] = useState(
    /^\d{4}-\d{2}-\d{2}$/.test(params.get("debut") ?? "") ? (params.get("debut") as string) : prochainPremierJuillet()
  );
  const [duree, setDuree] = useState<Duree>("12");
  const [dateFinAutre, setDateFinAutre] = useState("");
  const [loyerSaisi, setLoyerSaisi] = useState("");
  const [jourEcheance, setJourEcheance] = useState("1");
  const [mode, setMode] = useState<Mode>("interac");
  const [extras, setExtras] = useState<ExtraForm[]>([]);
  const [inclusions, setInclusions] = useState("");
  const [notes, setNotes] = useState("");

  const [pages, setPages] = useState<FichierPrepare[]>([]);
  const [traitement, setTraitement] = useState(false);
  const champPhoto = useRef<HTMLInputElement>(null);
  const champFichier = useRef<HTMLInputElement>(null);

  const [envoi, setEnvoi] = useState<string | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);

  useEffect(() => {
    if (!session) return;
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
  }, [session]);

  const dateFin = duree === "12" ? (dateDebut ? finApresMois(dateDebut, 12) : "") : duree === "autre" ? dateFinAutre : "";
  const loyerCents = versCents(loyerSaisi);
  const extrasCents = extras.reduce((s, e) => s + (versCents(e.montantSaisi) ?? 0), 0);

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

  /** Envoie les pages du bail une fois le bail créé ; retourne le nombre d'échecs. */
  async function televerserPages(bailId: string): Promise<number> {
    let echecs = 0;
    for (let i = 0; i < pages.length; i++) {
      setEnvoi(`Envoi du bail ${i + 1} / ${pages.length}…`);
      const f = pages[i];
      const maintenant = new Date();
      const ext = f.mimeType === "application/pdf" ? "pdf" : "jpg";
      const cle = `baux/${maintenant.getFullYear()}/${String(maintenant.getMonth() + 1).padStart(2, "0")}/${crypto.randomUUID()}.${ext}`;
      const envoiFichier = await supabase.storage.from(BUCKET_RECUS).upload(cle, f.principal, { contentType: f.mimeType, upsert: false });
      if (envoiFichier.error) { echecs++; continue; }
      const { error } = await supabase.from("documents").insert({
        bail_id: bailId, type: "bail", storage_key: cle, mime_type: f.mimeType,
        date_document: aujourdhuiIso(), nom_original: f.nomOriginal,
      });
      if (error) echecs++;
    }
    return echecs;
  }

  function majLocataire(cle: string, patch: Partial<LocataireForm>) {
    setLocataires((avant) => avant.map((l) => (l.cle === cle ? { ...l, ...patch } : l)));
  }
  function majExtra(cle: string, patch: Partial<ExtraForm>) {
    setExtras((avant) => avant.map((e) => (e.cle === cle ? { ...e, ...patch } : e)));
  }

  async function enregistrer() {
    setErreur(null);
    if (!logementId) return setErreur("Choisis le logement.");
    if (!dateDebut) return setErreur("Entre la date de début.");
    if (duree === "autre" && !dateFinAutre) return setErreur("Entre la date de fin.");
    if (dateFin && dateFin < dateDebut) return setErreur("La date de fin est avant la date de début.");
    if (loyerCents === null) return setErreur("Entre le loyer mensuel (ex. 950,00).");
    const locs = locataires.filter((l) => l.existantId || l.prenom.trim() || l.nom.trim());
    if (locs.length === 0) return setErreur("Ajoute au moins un locataire.");
    if (locs.some((l) => !l.existantId && (!l.prenom.trim() || !l.nom.trim()))) return setErreur("Chaque nouveau locataire a besoin d'un prénom et d'un nom.");
    const ext = extras.filter((e) => e.libelle.trim() || e.montantSaisi.trim());
    if (ext.some((e) => !e.libelle.trim() || versCents(e.montantSaisi) === null)) return setErreur("Chaque extra a besoin d'un libellé et d'un montant.");

    setEnvoi("Enregistrement…");
    const { data, error } = await supabase.rpc("creer_bail", {
      p: {
        logement_id: logementId,
        date_debut: dateDebut,
        date_fin: dateFin || null,
        loyer_cents: loyerCents,
        jour_echeance: Number(jourEcheance) || 1,
        mode_paiement: mode,
        inclusions: inclusions || null,
        notes: notes || null,
        locataires: locs.map((l) => l.existantId
          ? { id: l.existantId }
          : { prenom: l.prenom, nom: l.nom, telephone: l.telephone || null, courriel: l.courriel || null }),
        extras: ext.map((e) => ({ libelle: e.libelle, montant_cents: versCents(e.montantSaisi) })),
      },
    });
    if (error) {
      setEnvoi(null);
      setErreur(error.message.includes("baux_sans_chevauchement")
        ? "Ce logement a déjà un bail sur ces dates. Vérifie les dates ou termine l'ancien bail."
        : error.message);
      return;
    }
    const bailId = data as string;
    if (pages.length) {
      const echecs = await televerserPages(bailId);
      if (echecs) window.alert(`Le bail est enregistré, mais ${echecs} page(s) n'ont pas pu être envoyées. Ajoute-les depuis la fiche du bail.`);
    }
    router.replace(`/baux/${bailId}`);
  }

  if (!pret || !session) return null;

  const logement = logements.find((l) => l.id === logementId);
  const immeubleDuLogement = immeubles.find((i) => i.id === logement?.immeuble_id);

  return (
    <main className="page">
      <div className="entete">
        <h1>Nouveau bail</h1>
        <Link href="/baux" className="bouton">Annuler</Link>
      </div>

      {erreur && <div className="message erreur">{erreur}</div>}

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
            {existants.length > 0 && (
              <select value={l.existantId} onChange={(e) => majLocataire(l.cle, { existantId: e.target.value })} aria-label="Locataire déjà connu">
                <option value="">Nouveau locataire</option>
                {existants.map((x) => <option key={x.id} value={x.id}>{x.prenom} {x.nom}</option>)}
              </select>
            )}
            {!l.existantId && (
              <>
                <div className="rangee" style={{ marginTop: 8 }}>
                  <input placeholder="Prénom" autoComplete="off" value={l.prenom} onChange={(e) => majLocataire(l.cle, { prenom: e.target.value })} />
                  <input placeholder="Nom" autoComplete="off" value={l.nom} onChange={(e) => majLocataire(l.cle, { nom: e.target.value })} />
                </div>
                <div className="rangee" style={{ marginTop: 8 }}>
                  <input placeholder="Téléphone" type="tel" inputMode="tel" autoComplete="off" value={l.telephone} onChange={(e) => majLocataire(l.cle, { telephone: e.target.value })} />
                  <input placeholder="Courriel" type="email" autoComplete="off" value={l.courriel} onChange={(e) => majLocataire(l.cle, { courriel: e.target.value })} />
                </div>
              </>
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
        <label htmlFor="loyer">Loyer mensuel</label>
        <input id="loyer" className="montant-total" inputMode="decimal" placeholder="0,00" value={loyerSaisi} onChange={(e) => setLoyerSaisi(e.target.value)} />

        <label>Extras facturés chaque mois</label>
        {extras.map((e) => (
          <div className="rangee" key={e.cle} style={{ marginBottom: 8, alignItems: "center" }}>
            <input placeholder="ex. Stationnement" value={e.libelle} onChange={(ev) => majExtra(e.cle, { libelle: ev.target.value })} />
            <input placeholder="Montant" inputMode="decimal" value={e.montantSaisi} onChange={(ev) => majExtra(e.cle, { montantSaisi: ev.target.value })} />
            <button type="button" className="lien-retirer" style={{ flex: "0 0 auto" }} onClick={() => setExtras((a) => a.filter((x) => x.cle !== e.cle))} aria-label="Retirer l'extra">×</button>
          </div>
        ))}
        <button type="button" className="lien-filtres" style={{ marginTop: 0 }}
                onClick={() => setExtras((a) => [...a, { cle: crypto.randomUUID(), libelle: "", montantSaisi: "" }])}>
          + Ajouter un extra
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
            {envoi ?? "Enregistrer le bail"}
          </button>
        </div>
      </div>
    </main>
  );
}
