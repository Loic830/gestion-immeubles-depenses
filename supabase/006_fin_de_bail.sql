-- =====================================================================
-- 006 — Fin de bail anticipée (départ du locataire)
--
-- À exécuter une fois dans Supabase > SQL Editor (après 005).
--
-- Le bail n'est jamais supprimé : on inscrit sa date de départ réelle.
--   - Les mois déjà dus et les paiements restent dans l'historique.
--   - Les loyers dus APRÈS le départ (sans paiement) sont retirés.
--   - Un montant forfaitaire (indemnité de résiliation, entente) s'ajoute
--     au dernier mois : il apparaît dans l'onglet Loyers et se marque « Reçu ».
--   - Le logement redevient libre le lendemain du départ : un nouveau bail
--     peut commencer dès cette date.
-- =====================================================================

create table public.fins_bail (
  bail_id        uuid primary key references public.baux(id) on delete cascade,
  date_depart    date not null,
  forfait_cents  bigint not null default 0 check (forfait_cents >= 0),
  echeance_id    uuid references public.echeances(id) on delete set null, -- mois qui porte le forfait
  raison         text,
  saisi_par      uuid references auth.users(id) default auth.uid(),
  created_at     timestamptz not null default now()
);

alter table public.fins_bail enable row level security;
create policy acces_authentifie on public.fins_bail
  for all to authenticated using (true) with check (true);


-- ---------------------------------------------------------------------
-- terminer_bail : inscrit le départ, retire les loyers futurs, ajoute le forfait
-- Retourne le nombre de mois retirés.
-- ---------------------------------------------------------------------
create or replace function public.terminer_bail(
  p_bail uuid, p_date_depart date, p_forfait_cents bigint default 0, p_raison text default null
)
returns int
language plpgsql security invoker set search_path = public as $$
declare
  b          baux%rowtype;
  v_dernier  date := date_trunc('month', p_date_depart)::date;
  v_echeance uuid;
  v_forfait  bigint := coalesce(p_forfait_cents, 0);
  v_payes    int;
  v_nb       int;
begin
  select * into b from baux where id = p_bail and deleted_at is null for update;
  if not found then raise exception 'Bail introuvable.'; end if;
  if b.date_depart is not null then
    raise exception 'Ce bail est déjà terminé (départ le %).', to_char(b.date_depart, 'YYYY-MM-DD');
  end if;
  if p_date_depart is null or p_date_depart < b.date_debut then
    raise exception 'La date de départ ne peut pas être avant le début du bail.';
  end if;
  if b.date_fin is not null and p_date_depart > b.date_fin then
    raise exception 'La date de départ est après la fin du bail : il se termine déjà le %.', to_char(b.date_fin, 'YYYY-MM-DD');
  end if;
  if v_forfait < 0 then raise exception 'Le montant forfaitaire doit être positif.'; end if;

  -- Des paiements (ou chèques en main) existent après le départ : à régler d'abord
  select count(*) into v_payes
    from echeances e join paiements p on p.echeance_id = e.id and p.deleted_at is null
   where e.bail_id = p_bail and e.mois > v_dernier;
  if v_payes > 0 then
    raise exception 'Il y a % paiement(s) inscrit(s) après le départ. Annule-les dans l''onglet Loyers (ou rembourse les chèques), puis recommence.', v_payes;
  end if;

  update baux set date_depart = p_date_depart, updated_at = now() where id = p_bail;

  delete from echeances where bail_id = p_bail and mois > v_dernier;
  get diagnostics v_nb = row_count;

  -- Forfait ajouté au dernier mois (avec la raison dans la note du mois)
  select id into v_echeance from echeances where bail_id = p_bail and mois = v_dernier;
  if v_forfait > 0 and v_echeance is not null then
    update echeances
       set extras_cents = extras_cents + v_forfait,
           note = concat_ws(' · ', note, 'Montant forfaitaire de fin de bail : ' ||
                  replace(to_char(v_forfait / 100.0, 'FM9999990.00'), '.', ',') || ' $'),
           updated_at = now()
     where id = v_echeance;
  end if;

  -- Plus d'avis de renouvellement à suivre
  update renouvellements set reponse = 'depart' where bail_id = p_bail;

  insert into fins_bail (bail_id, date_depart, forfait_cents, echeance_id, raison)
  values (p_bail, p_date_depart, v_forfait, v_echeance, nullif(btrim(p_raison), ''));

  return v_nb;
end $$;


-- ---------------------------------------------------------------------
-- annuler_fin_bail : en cas d'erreur de saisie, remet le bail comme avant
-- (retire le forfait, régénère les loyers dus jusqu'à la fin prévue)
-- ---------------------------------------------------------------------
create or replace function public.annuler_fin_bail(p_bail uuid)
returns void
language plpgsql security invoker set search_path = public as $$
declare
  f fins_bail%rowtype;
begin
  select * into f from fins_bail where bail_id = p_bail for update;
  if not found then raise exception 'Ce bail n''a pas de fin anticipée à annuler.'; end if;

  if exists (
    select 1 from baux b2 join baux b on b.id = p_bail
     where b2.logement_id = b.logement_id and b2.id <> b.id and b2.deleted_at is null
       and daterange(b2.date_debut, coalesce(b2.date_depart, b2.date_fin), '[]')
        && daterange(b.date_debut, b.date_fin, '[]')
  ) then
    raise exception 'Un nouveau bail est déjà inscrit pour ce logement : impossible d''annuler la fin de ce bail.';
  end if;

  if f.forfait_cents > 0 and f.echeance_id is not null then
    update echeances
       set extras_cents = greatest(extras_cents - f.forfait_cents, 0),
           note = nullif(regexp_replace(coalesce(note, ''), '( · )?Montant forfaitaire de fin de bail : [^·]*\$', ''), ''),
           updated_at = now()
     where id = f.echeance_id;
  end if;

  update baux set date_depart = null, updated_at = now() where id = p_bail;
  update renouvellements set reponse = 'en_attente' where bail_id = p_bail and reponse = 'depart';
  delete from fins_bail where bail_id = p_bail;

  -- Recrée les mois retirés (échoue si un nouveau bail occupe déjà le logement :
  -- la contrainte de chevauchement bloque alors l'annulation, ce qui est voulu)
  perform generer_echeances(p_bail);
end $$;
