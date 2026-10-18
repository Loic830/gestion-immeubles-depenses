import { supabase } from "./supabase";

// Centre de notifications (v0.8.9).
//
// RÈGLE pour toute nouvelle notification : titre (l'action à faire) + description
// (ce que l'utilisateur doit faire). Chaque type est ajouté ici, dans CATALOGUE :
// il apparaît alors automatiquement dans Profil > « Tester les notifications possibles »
// et dans les préférences du tiroir. Le calcul quotidien est dans la fonction SQL
// alertes_du_jour() (supabase/013_notifications.sql) : garder les mêmes codes.

/** Ce que vise une notification, pour les préférences (ex. pas d'alerte pour le véhicule X). */
export type Portee = "immeuble" | "vehicule";

export type TypeNotification = {
  code: string;
  nom: string;          // libellé dans les préférences et la page de test
  quand: string;        // à quel moment elle est envoyée
  portee: Portee;
  exemple: { titre: string; description: string };
};

export const CATALOGUE: TypeNotification[] = [
  {
    code: "hypotheque_renouvellement",
    nom: "Renouvellement hypothécaire",
    quand: "120, 60 et 30 jours avant la fin du terme d'un prêt",
    portee: "immeuble",
    exemple: {
      titre: "Renouveler l'hypothèque · {immeuble}",
      description: "Le terme du prêt « Prêt hypothécaire » (Desjardins) se termine le 15 février 2027, dans 120 jours. "
        + "Communiquez avec le prêteur pour comparer les taux, puis entrez le nouveau terme dans Frais fixes > Renouveler le terme.",
    },
  },
  {
    code: "assurance_renouvellement",
    nom: "Renouvellement d'assurance",
    quand: "30 et 7 jours avant le renouvellement d'une police",
    portee: "immeuble",
    exemple: {
      titre: "Renouveler l'assurance · {immeuble}",
      description: "La police Promutuel no A-123 arrive à échéance le 1er décembre 2026, dans 30 jours. "
        + "Vérifiez la nouvelle prime, puis touchez Renouveler dans Frais fixes > Assurances.",
    },
  },
  {
    code: "taxes_echeance",
    nom: "Versement de taxes",
    quand: "14 et 3 jours avant l'échéance, puis une fois si elle est passée",
    portee: "immeuble",
    exemple: {
      titre: "Payer les taxes · {immeuble}",
      description: "Versement de taxes foncières 2026 de 1 234,56 $ dû le 1er novembre 2026, dans 14 jours. "
        + "Payez-le, puis touchez Payé dans Frais fixes > Taxes.",
    },
  },
  {
    code: "avis_tal",
    nom: "Avis de renouvellement de bail (TAL)",
    quand: "à l'ouverture de la période d'envoi, puis 14 jours avant sa fin",
    portee: "immeuble",
    exemple: {
      titre: "Envoyer l'avis de renouvellement · {immeuble} 6",
      description: "Le bail de Julie Tremblay se termine le 30 juin 2027. L'avis de modification (hausse de loyer ou autre "
        + "changement) doit être envoyé au plus tard le 31 mars 2027, dans 45 jours. "
        + "Préparez-le, puis inscrivez la date d'envoi sur la fiche du bail (onglet Baux).",
    },
  },
  {
    code: "loyer_retard",
    nom: "Loyer en retard",
    quand: "quand un loyer n'est pas reçu 5 jours après l'échéance",
    portee: "immeuble",
    exemple: {
      titre: "Loyer en retard · {immeuble} 6",
      description: "Le loyer d'octobre 2026 n'est pas reçu (reste 850,00 $, 5 jours de retard). "
        + "Appelez Julie Tremblay ou inscrivez le paiement dans l'onglet Loyers.",
    },
  },
  {
    code: "vehicule_compteur",
    nom: "Compteur du véhicule",
    quand: "du 24 décembre au 10 janvier, s'il n'y a pas de relevé autour du 1er janvier",
    portee: "vehicule",
    exemple: {
      titre: "Entrer le compteur · {vehicule}",
      description: "Inscrivez le kilométrage du compteur autour du 1er janvier 2027 (onglet Véhicule > Compteur). "
        + "Il sert à calculer la part déductible de 2026 et de 2027.",
    },
  },
];

export function typeNotification(code: string): TypeNotification | undefined {
  return CATALOGUE.find((t) => t.code === code);
}

export type Notification = {
  id: string;
  type: string;
  cible_id: string | null;
  titre: string;
  description: string;
  est_test: boolean;
  lue_le: string | null;
  created_at: string;
};

export type Exclusion = { id: string; type: string; cible_id: string | null };

/** Une cible (immeuble ou véhicule) que les préférences peuvent exclure. */
export type Cible = { id: string; nom: string };

/** Exclue si le type entier l'est, ou cette cible précise. */
export function estExclue(exclusions: Exclusion[], type: string, cibleId: string | null): boolean {
  return exclusions.some((x) => x.type === type && (x.cible_id === null || x.cible_id === cibleId));
}

/** « 2026-10-12T14:03:00Z » → « 12 octobre 2026 » (date locale du téléphone) */
export function dateReception(horodatage: string): string {
  return new Date(horodatage).toLocaleDateString("fr-CA", { day: "numeric", month: "long", year: "numeric" });
}

/** Prévient la cloche qu'il faut recompter les non lues (après un test, une lecture…). */
export const EVENEMENT_MAJ = "notifications-maj";
export function signalerMaj() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(EVENEMENT_MAJ));
}

export async function compterNonLues(): Promise<number> {
  const { count } = await supabase.from("notifications").select("id", { count: "exact", head: true })
    .is("deleted_at", null).is("lue_le", null);
  return count ?? 0;
}

/** Calcule les alertes du jour (au plus une fois l'heure par téléphone ; le calcul
 *  principal est fait chaque matin par Vercel Cron). Sans effet si 013 manque. */
export async function genererSiBesoin() {
  const CLE = "so-max-notifications-generees";
  try {
    const derniere = Number(localStorage.getItem(CLE) ?? 0);
    if (Date.now() - derniere < 60 * 60 * 1000) return;
    localStorage.setItem(CLE, String(Date.now()));
  } catch {
    // stockage indisponible : on calcule quand même
  }
  await supabase.rpc("generer_notifications");
}

/** Demande au serveur d'envoyer au téléphone les notifications pas encore poussées
 *  de la personne connectée (sans effet si Web Push n'est pas configuré). */
export async function pousserMesNotifications(): Promise<{ ok: boolean; message?: string }> {
  const { data } = await supabase.auth.getSession();
  const jeton = data.session?.access_token;
  if (!jeton) return { ok: false, message: "Session expirée." };
  try {
    const r = await fetch("/api/notifications/envoyer", { method: "POST", headers: { Authorization: `Bearer ${jeton}` } });
    const corps = await r.json().catch(() => ({}));
    return { ok: r.ok, message: corps.message };
  } catch {
    return { ok: false, message: "Envoi au téléphone impossible (réseau)." };
  }
}
