// Traitement des reçus sur le téléphone, AVANT l'envoi :
//  - redressement de l'orientation (le navigateur applique l'EXIF au décodage)
//  - redimensionnement (plus grand côté 2000 px) et compression JPEG 0,8
//  - suppression des métadonnées (GPS, etc.) : le ré-encodage canvas n'en garde aucune
//  - miniature 400 px pour la liste
//  - empreinte SHA-256 pour détecter un reçu déjà téléversé

export type FichierPrepare = {
  principal: Blob;
  miniature: Blob | null;
  mimeType: "image/jpeg" | "application/pdf";
  largeur: number | null;
  hauteur: number | null;
  sha256: string;
  nomOriginal: string;
  apercuUrl: string | null; // pour afficher la photo dans le formulaire
};

const COTE_MAX = 2000;
const COTE_MINIATURE = 400;
const PDF_MAX_OCTETS = 15 * 1024 * 1024;

export async function sha256Hex(data: Blob): Promise<string> {
  const buffer = await data.arrayBuffer();
  const hash = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function chargerImage(fichier: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(fichier);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Impossible de lire cette image. Essaie en JPEG ou reprends la photo."));
    };
    img.src = url;
  });
}

function redimensionner(img: HTMLImageElement, coteMax: number, qualite: number) {
  const ratio = Math.min(1, coteMax / Math.max(img.naturalWidth, img.naturalHeight));
  const largeur = Math.round(img.naturalWidth * ratio);
  const hauteur = Math.round(img.naturalHeight * ratio);
  const canvas = document.createElement("canvas");
  canvas.width = largeur;
  canvas.height = hauteur;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas non disponible sur cet appareil.");
  ctx.fillStyle = "#fff"; // fond blanc (PNG transparents)
  ctx.fillRect(0, 0, largeur, hauteur);
  ctx.drawImage(img, 0, 0, largeur, hauteur);
  return new Promise<{ blob: Blob; largeur: number; hauteur: number }>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve({ blob, largeur, hauteur }) : reject(new Error("Compression impossible."))),
      "image/jpeg",
      qualite
    );
  });
}

export async function preparerFichier(fichier: File): Promise<FichierPrepare> {
  if (fichier.type === "application/pdf") {
    if (fichier.size > PDF_MAX_OCTETS) throw new Error("PDF trop lourd (15 Mo maximum).");
    return {
      principal: fichier,
      miniature: null,
      mimeType: "application/pdf",
      largeur: null,
      hauteur: null,
      sha256: await sha256Hex(fichier),
      nomOriginal: fichier.name,
      apercuUrl: null,
    };
  }

  const img = await chargerImage(fichier);
  const principal = await redimensionner(img, COTE_MAX, 0.8);
  const miniature = await redimensionner(img, COTE_MINIATURE, 0.7);

  return {
    principal: principal.blob,
    miniature: miniature.blob,
    mimeType: "image/jpeg",
    largeur: principal.largeur,
    hauteur: principal.hauteur,
    // Empreinte du fichier ORIGINAL : la même photo donne toujours la même empreinte
    sha256: await sha256Hex(fichier),
    nomOriginal: fichier.name,
    apercuUrl: URL.createObjectURL(miniature.blob),
  };
}

/** Clé de stockage sans aucune donnée lisible : AAAA/MM/uuid.ext */
export function cleStockage(extension: string, suffixe = ""): { base: string; cle: string } {
  const maintenant = new Date();
  const annee = maintenant.getFullYear();
  const mois = String(maintenant.getMonth() + 1).padStart(2, "0");
  const base = `${annee}/${mois}/${crypto.randomUUID()}`;
  return { base, cle: `${base}${suffixe}.${extension}` };
}
