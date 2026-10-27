import { supabase, BUCKET_RECUS } from "@/lib/supabase";
import { type FichierPrepare } from "@/lib/image";
import { aujourdhuiIso } from "@/lib/dates";

// Documents rattachés à un bail (table documents), v0.9.4.
// Le bail signé, l'enquête de crédit et les règlements d'immeuble se traitent de la même façon :
// photos ou PDF, rangés dans baux/AAAA/MM/ du bucket privé.

export type TypeDocumentBail = "bail" | "enquete_credit" | "reglements";

export const DOCUMENTS_BAIL: { type: TypeDocumentBail; titre: string; bouton: string; nomPage: string; aideNouveau: string; aideFiche: string }[] = [
  {
    type: "bail", titre: "Bail signé", bouton: "Photo du bail", nomPage: "Bail",
    aideNouveau: "Photographie chaque page du bail, ou joins le PDF. Tu pourras aussi le faire plus tard depuis la fiche.",
    aideFiche: "Photo ou PDF du bail, pour le dossier du prêteur et les renouvellements.",
  },
  {
    type: "enquete_credit", titre: "Enquête de crédit", bouton: "Photo de l'enquête", nomPage: "Enquête de crédit",
    aideNouveau: "Facultatif : photo ou PDF de l'enquête de crédit du locataire.",
    aideFiche: "Photo ou PDF de l'enquête de crédit. Reste dans l'app (pas dans le dossier du prêteur).",
  },
  {
    type: "reglements", titre: "Règlements d'immeuble", bouton: "Photo des règlements", nomPage: "Règlements",
    aideNouveau: "Facultatif : photo ou PDF des règlements d'immeuble signés par le locataire.",
    aideFiche: "Photo ou PDF des règlements d'immeuble signés par le locataire.",
  },
];

export type PagesParType = Record<TypeDocumentBail, FichierPrepare[]>;
export const aucunePage = (): PagesParType => ({ bail: [], enquete_credit: [], reglements: [] });

/** Envoie un fichier préparé et l'inscrit dans documents ; lance une erreur en cas d'échec. */
export async function televerserDocument(bailId: string, type: TypeDocumentBail, f: FichierPrepare): Promise<void> {
  await envoyer("baux", { bail_id: bailId, type }, f);
}

/** v0.9.18 : photo ou PDF d'un prêt hypothécaire (lettre du prêteur, tableau d'amortissement…). */
export async function televerserDocumentPret(hypothequeId: string, f: FichierPrepare): Promise<void> {
  await envoyer("prets", { hypotheque_id: hypothequeId, type: "pret" }, f);
}

async function envoyer(dossier: string, lien: Record<string, string>, f: FichierPrepare): Promise<void> {
  const maintenant = new Date();
  const ext = f.mimeType === "application/pdf" ? "pdf" : "jpg";
  const cle = `${dossier}/${maintenant.getFullYear()}/${String(maintenant.getMonth() + 1).padStart(2, "0")}/${crypto.randomUUID()}.${ext}`;
  const envoi = await supabase.storage.from(BUCKET_RECUS).upload(cle, f.principal, { contentType: f.mimeType, upsert: false });
  if (envoi.error) throw new Error(`Envoi impossible : ${envoi.error.message}`);
  const { error } = await supabase.from("documents").insert({
    ...lien, storage_key: cle, mime_type: f.mimeType,
    date_document: aujourdhuiIso(), nom_original: f.nomOriginal,
  });
  if (error) throw new Error(error.message);
}
