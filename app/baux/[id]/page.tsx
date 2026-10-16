"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { supabase, BUCKET_RECUS } from "@/lib/supabase";
import { preparerFichier } from "@/lib/image";
import { useSession } from "@/lib/useSession";
import { formatCents } from "@/lib/argent";
import { aujourdhuiIso, dateLisible, moisLisible } from "@/lib/dates";

type Bail = {
  id: string;
  statut: "a_venir" | "actif" | "termine";
  logement: string;
  immeuble: string;
  date_debut: string;
  date_fin: string | null;
  loyer_cents: number;
  extras_cents: number;
  jour_echeance: number;
  mode_paiement: "interac" | "cheque" | "prelevement" | "comptant";
  inclusions: string | null;
  notes: string | null;
  avis_du: string | null;
  avis_au: string | null;
  date_avis_envoye: string | null;
  reponse: string | null;
};
type Locataire = { principal: boolean; locataire: { prenom: string; nom: string; telephone: string | null; courriel: string | null } };
type Extra = { id: string; libelle: string; montant_cents: number };
type DocumentBail = { id: string; storage_key: string; mime_type: string; date_document: string | null; created_at: string; url: string | null };
type Solde = { echeance_id: string; mois: string; montant_du_cents: number; recu_cents: number; en_main_cents: number; solde_cents: number; jours_retard: number };

const LIBELLE_MODE = { interac: "Virement Interac", cheque: "Chèques postdatés", prelevement: "Prélèvement automatique", comptant: "Comptant" };
const LIBELLE_STATUT = { a_venir: "À venir", actif: "Actif", termine: "Terminé" };

export default function DetailBail() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { session, pret } = useSession();

  const [bail, setBail] = useState<Bail | null>(null);
  const [locataires, setLocataires] = useState<Locataire[]>([]);
  const [extras, setExtras] = useState<Extra[]>([]);
  const [soldes, setSoldes] = useState<Solde[]>([]);
  const [erreur, setErreur] = useState<string | null>(null);
  const [suppression, setSuppression] = useState(false);
  const [documents, setDocuments] = useState<DocumentBail[]>([]);
  const [televersement, setTeleversement] = useState<string | null>(null);
  const champPhoto = useRef<HTMLInputElement>(null);
  const champFichier = useRef<HTMLInputElement>(null);

  const chargerDocuments = useCallback(async () => {
    if (!id) return;
    const { data } = await supabase
      .from("documents")
      .select("id, storage_key, mime_type, date_document, created_at")
      .eq("bail_id", id)
      .eq("type", "bail")
      .order("created_at");
    const liste = (data ?? []) as Omit<DocumentBail, "url">[];
    const urls = liste.length
      ? (await supabase.storage.from(BUCKET_RECUS).createSignedUrls(liste.map((d) => d.storage_key), 600)).data ?? []
      : [];
    setDocuments(liste.map((d) => ({ ...d, url: urls.find((u) => u.path === d.storage_key)?.signedUrl ?? null })));
  }, [id]);

  async function ajouterDocuments(fichiers: FileList | null) {
    if (!fichiers || fichiers.length === 0 || !id) return;
    setErreur(null);
    try {
      const liste = Array.from(fichiers);
      for (let i = 0; i < liste.length; i++) {
        setTeleversement(`Envoi ${i + 1} / ${liste.length}…`);
        const f = await preparerFichier(liste[i]);
        const maintenant = new Date();
        const ext = f.mimeType === "application/pdf" ? "pdf" : "jpg";
        const cle = `baux/${maintenant.getFullYear()}/${String(maintenant.getMonth() + 1).padStart(2, "0")}/${crypto.randomUUID()}.${ext}`;
        const envoi = await supabase.storage.from(BUCKET_RECUS).upload(cle, f.principal, { contentType: f.mimeType, upsert: false });
        if (envoi.error) throw new Error(`Envoi impossible : ${envoi.error.message}`);
        const { error } = await supabase.from("documents").insert({
          bail_id: id, type: "bail", storage_key: cle, mime_type: f.mimeType,
          date_document: aujourdhuiIso(), nom_original: f.nomOriginal,
        });
        if (error) throw new Error(error.message);
      }
      await chargerDocuments();
    } catch (e) {
      setErreur(e instanceof Error ? e.message : String(e));
    } finally {
      setTeleversement(null);
      if (champPhoto.current) champPhoto.current.value = "";
      if (champFichier.current) champFichier.current.value = "";
    }
  }

  useEffect(() => {
    if (!session || !id) return;
    (async () => {
      const [b, lo, ex, so] = await Promise.all([
        supabase.from("v_baux").select("*").eq("id", id).single(),
        supabase.from("bail_locataires").select("principal, locataire:locataires(prenom, nom, telephone, courriel)").eq("bail_id", id),
        supabase.from("bail_extras").select("id, libelle, montant_cents").eq("bail_id", id),
        supabase.from("v_soldes").select("echeance_id, mois, montant_du_cents, recu_cents, en_main_cents, solde_cents, jours_retard").eq("bail_id", id).order("mois"),
      ]);
      if (b.error || !b.data) { setErreur("Bail introuvable ou supprimé."); return; }
      setBail(b.data as Bail);
      setLocataires(((lo.data ?? []) as unknown as Locataire[]).sort((x, y) => Number(y.principal) - Number(x.principal)));
      setExtras((ex.data ?? []) as Extra[]);
      setSoldes((so.data ?? []) as Solde[]);
      await chargerDocuments();
    })();
  }, [session, id, chargerDocuments]);

  async function supprimer() {
    if (!bail) return;
    const recus = soldes.some((s) => s.recu_cents > 0 || s.en_main_cents > 0);
    const message = recus
      ? "Ce bail a déjà des paiements. Le supprimer les retire aussi des totaux. Continuer seulement s'il s'agit d'une erreur de saisie."
      : "Supprimer ce bail ? (À utiliser pour corriger une erreur de saisie.)";
    if (!window.confirm(message)) return;
    setSuppression(true);
    const { error } = await supabase.from("baux").update({ deleted_at: new Date().toISOString() }).eq("id", bail.id);
    setSuppression(false);
    if (error) return setErreur(error.message);
    router.replace("/baux");
  }

  if (!pret || !session) return null;

  const auj = aujourdhuiIso();
  const totalDu = soldes.reduce((s, x) => s + x.montant_du_cents, 0);
  const totalRecu = soldes.reduce((s, x) => s + x.recu_cents, 0);
  const enRetard = soldes.filter((s) => s.jours_retard > 0);

  return (
    <main className="page">
      <div className="entete">
        <h1>Bail</h1>
        <Link href="/baux" className="bouton">Retour</Link>
      </div>

      {erreur && <div className="message erreur">{erreur}</div>}
      {!bail && !erreur && <p className="aide">Chargement…</p>}

      {bail && (
        <>
          <section className="carte">
            <div className="detail-sous" style={{ marginTop: 0 }}>{bail.immeuble} · logement {bail.logement}</div>
            <div className="detail-total">{formatCents(bail.loyer_cents + bail.extras_cents)} <span className="aide">/ mois</span></div>
            <span className={`pastille ${bail.statut === "actif" ? "ok" : ""}`}>{LIBELLE_STATUT[bail.statut]}</span>
          </section>

          {enRetard.length > 0 && (
            <div className="message erreur">
              En retard : {formatCents(enRetard.reduce((s, x) => s + x.solde_cents, 0))}
              {" "}({enRetard.map((s) => moisLisible(s.mois)).join(", ")})
            </div>
          )}

          <section className="carte">
            <strong>Locataires</strong>
            {locataires.map((l, i) => (
              <div key={i} className={i > 0 ? "bloc-locataire" : ""} style={i === 0 ? { marginTop: 8 } : undefined}>
                <div style={{ fontWeight: 600 }}>
                  {l.locataire.prenom} {l.locataire.nom}
                  {l.principal && locataires.length > 1 && <span className="aide"> · principal</span>}
                </div>
                {l.locataire.courriel && <div className="aide" style={{ marginTop: 2 }}>{l.locataire.courriel}</div>}
                {l.locataire.telephone && (
                  <div className="liens-contact">
                    <a className="bouton" href={`tel:${l.locataire.telephone.replace(/[^\d+]/g, "")}`}>Appeler</a>
                    <a className="bouton" href={`sms:${l.locataire.telephone.replace(/[^\d+]/g, "")}`}>Texto</a>
                  </div>
                )}
              </div>
            ))}
          </section>

          <section className="carte">
            <dl className="champs">
              <dt>Début</dt><dd>{dateLisible(bail.date_debut)}</dd>
              <dt>Fin</dt><dd>{bail.date_fin ? dateLisible(bail.date_fin) : "Durée indéterminée"}</dd>
              <dt>Loyer</dt><dd>{formatCents(bail.loyer_cents)}</dd>
              {extras.map((e) => (<Fragment key={e.id}><dt>{e.libelle}</dt><dd>{formatCents(e.montant_cents)}</dd></Fragment>))}
              <dt>Paiement</dt><dd>{LIBELLE_MODE[bail.mode_paiement]}, le {bail.jour_echeance}{bail.jour_echeance === 1 ? "er" : ""} du mois</dd>
              {bail.inclusions && (<><dt>Inclusions</dt><dd>{bail.inclusions}</dd></>)}
              {bail.notes && (<><dt>Notes</dt><dd style={{ whiteSpace: "pre-wrap" }}>{bail.notes}</dd></>)}
            </dl>
          </section>

          <section className="carte">
            <strong>Bail signé</strong>
            <p className="aide">Photo ou PDF du bail, pour le dossier du prêteur et les renouvellements.</p>
            <div className="rangee">
              <button className="bouton principal" onClick={() => champPhoto.current?.click()} disabled={televersement !== null}>
                {televersement ?? (documents.length ? "+ Page" : "Photo du bail")}
              </button>
              <button className="bouton" onClick={() => champFichier.current?.click()} disabled={televersement !== null}>
                Fichier ou PDF
              </button>
            </div>
            <input ref={champPhoto} type="file" accept="image/*" capture="environment" hidden onChange={(e) => ajouterDocuments(e.target.files)} />
            <input ref={champFichier} type="file" accept="image/*,application/pdf" multiple hidden onChange={(e) => ajouterDocuments(e.target.files)} />
            {documents.length > 0 && (
              <div className="photos">
                {documents.map((d, i) => (
                  <button key={d.id} className="vignette" onClick={() => d.url && window.open(d.url, "_blank")}>
                    {d.mime_type === "application/pdf" || !d.url ? "PDF" : <img src={d.url} alt={`Bail, page ${i + 1}`} />}
                  </button>
                ))}
              </div>
            )}
            {documents.length > 0 && <p className="aide">{documents.length} page{documents.length > 1 ? "s" : ""} · toucher pour ouvrir.</p>}
          </section>

          {bail.avis_du && (
            <section className="carte">
              <strong>Renouvellement</strong>
              <p className="aide">
                Avis de modification à envoyer entre le {dateLisible(bail.avis_du)} et le {dateLisible(bail.avis_au)}.
                {bail.date_avis_envoye
                  ? ` Envoyé le ${dateLisible(bail.date_avis_envoye)}.`
                  : bail.avis_du <= auj && (bail.avis_au ?? "") >= auj
                    ? " La fenêtre est ouverte maintenant."
                    : (bail.avis_au ?? "") < auj ? " La fenêtre est passée : le bail se reconduit aux mêmes conditions." : ""}
              </p>
              <p className="aide">Le suivi complet des avis (envoi, réponse, preuve) arrive dans la version 0.9.</p>
            </section>
          )}

          <section className="carte">
            <div className="entete" style={{ marginBottom: 8 }}>
              <strong>Loyers dus</strong>
              <span className="aide" style={{ margin: 0 }}>{formatCents(totalRecu)} reçus sur {formatCents(totalDu)}</span>
            </div>
            {soldes.map((s) => (
              <div className="liste-depense" key={s.echeance_id}>
                <div className="infos">
                  <div className="titre" style={{ textTransform: "capitalize" }}>{moisLisible(s.mois)}</div>
                  {s.en_main_cents > 0 && <div className="sous">Chèque en main : {formatCents(s.en_main_cents)}</div>}
                </div>
                <div style={{ textAlign: "right" }}>
                  <div className="montant">{formatCents(s.montant_du_cents)}</div>
                  {s.solde_cents <= 0
                    ? <span className="pastille ok">Payé</span>
                    : s.jours_retard > 0
                      ? <span className="pastille vacant">Retard {s.jours_retard} j</span>
                      : s.recu_cents > 0 ? <span className="pastille">Partiel</span> : null}
                </div>
              </div>
            ))}
            <p className="aide">L&apos;enregistrement des loyers reçus arrive dans la version 0.7 (onglet Loyers).</p>
          </section>

          <button className="bouton plein lien-danger" onClick={supprimer} disabled={suppression}>
            {suppression ? "Suppression…" : "Supprimer ce bail (erreur de saisie)"}
          </button>
        </>
      )}
    </main>
  );
}
