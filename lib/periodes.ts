// Périodes de filtrage, calculées en date locale (AAAA-MM-JJ).

export type CodePeriode = "mois" | "mois-dernier" | "trimestre" | "annee" | "annee-derniere" | "tout" | "perso";

export const PERIODES: { code: CodePeriode; libelle: string }[] = [
  { code: "mois", libelle: "Ce mois-ci" },
  { code: "mois-dernier", libelle: "Mois dernier" },
  { code: "trimestre", libelle: "Ce trimestre" },
  { code: "annee", libelle: "Cette année" },
  { code: "annee-derniere", libelle: "Année dernière" },
  { code: "tout", libelle: "Tout" },
  { code: "perso", libelle: "Dates précises…" },
];

function iso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Bornes incluses [debut, fin] ; null = pas de borne. */
export function bornesPeriode(code: CodePeriode, debutPerso?: string, finPerso?: string): { debut: string | null; fin: string | null } {
  const auj = new Date();
  const a = auj.getFullYear();
  const m = auj.getMonth();
  switch (code) {
    case "mois":
      return { debut: iso(new Date(a, m, 1)), fin: iso(new Date(a, m + 1, 0)) };
    case "mois-dernier":
      return { debut: iso(new Date(a, m - 1, 1)), fin: iso(new Date(a, m, 0)) };
    case "trimestre": {
      const t = Math.floor(m / 3) * 3;
      return { debut: iso(new Date(a, t, 1)), fin: iso(new Date(a, t + 3, 0)) };
    }
    case "annee":
      return { debut: `${a}-01-01`, fin: `${a}-12-31` };
    case "annee-derniere":
      return { debut: `${a - 1}-01-01`, fin: `${a - 1}-12-31` };
    case "perso":
      return { debut: debutPerso || null, fin: finPerso || null };
    default:
      return { debut: null, fin: null };
  }
}
