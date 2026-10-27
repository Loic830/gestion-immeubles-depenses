// Lectures longues (v0.9.11) : Supabase renvoie au plus 1000 lignes par requête, et une liste
// d'identifiants trop longue dépasse la taille permise de l'adresse. Avec 30 ans de baux,
// on lit donc par paquets de 1000 lignes et on découpe les listes d'identifiants en lots de 100.

const PAQUET = 1000;
const LOT = 100;

type Reponse<T> = PromiseLike<{ data: T[] | null; error: { message: string } | null }>;

/** Toutes les lignes d'une requête, par paquets de 1000 (la requête doit avoir un ordre stable) */
export async function toutesLesLignes<T>(requete: (debut: number, fin: number) => Reponse<T>): Promise<T[]> {
  const lignes: T[] = [];
  for (let debut = 0; ; debut += PAQUET) {
    const { data, error } = await requete(debut, debut + PAQUET - 1);
    if (error) throw new Error(error.message);
    lignes.push(...(data ?? []));
    if (!data || data.length < PAQUET) return lignes;
  }
}

/** Même requête pour chaque lot de 100 identifiants, résultats mis bout à bout */
export async function parLots<T>(ids: string[], requete: (lot: string[], debut: number, fin: number) => Reponse<T>): Promise<T[]> {
  const lignes: T[] = [];
  for (let i = 0; i < ids.length; i += LOT) {
    const lot = ids.slice(i, i + LOT);
    lignes.push(...(await toutesLesLignes<T>((debut, fin) => requete(lot, debut, fin))));
  }
  return lignes;
}
