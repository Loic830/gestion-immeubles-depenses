-- =====================================================================
-- 005 — Changement de loyer en cours de bail + crédits au locataire
--
-- À exécuter une fois dans Supabase > SQL Editor (après 004).
--
-- 1. Changement de loyer : un nouveau loyer s'applique à partir d'un mois
--    donné jusqu'à la fin du bail. Les mois précédents, les paiements déjà
--    reçus et la date de fin ne changent pas. Chaque changement est gardé
--    dans l'historique (ancien loyer, nouveau loyer, raison, qui, quand).
-- 2. Crédit au locataire : un paiement de mode « credit » avec une raison
--    obligatoire (ex. porte achetée par le locataire). Le loyer reste dû au
--    complet (revenu brut intact pour l'impôt) ; le crédit compte comme reçu.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Crédit : nouveau mode de règlement d'un loyer
--    (pas utilisé ailleurs dans ce script : une valeur d'enum ajoutée
--    n'est utilisable qu'après la fin de la transaction)
-- ---------------------------------------------------------------------
alter type public.mode_loyer add value if not exists 'credit';

-- Raison obligatoire pour un crédit (vérifiée par texte pour éviter
-- d'utiliser la nouvelle valeur d'enum dans la même transaction)
alter table public.paiements
  add constraint paiements_credit_raison
  check (mode::text <> 'credit' or nullif(btrim(notes), '') is not null);


-- ---------------------------------------------------------------------
-- 2. Historique des changements de loyer
-- ---------------------------------------------------------------------
create table public.changements_loyer (
  id                  uuid primary key default gen_random_uuid(),
  bail_id             uuid not null references public.baux(id) on delete cascade,
  date_effet          date not null check (date_effet = date_trunc('month', date_effet)::date),
  ancien_loyer_cents  bigint not null check (ancien_loyer_cents >= 0),
  nouveau_loyer_cents bigint not null check (nouveau_loyer_cents >= 0),
  raison              text,
  saisi_par           uuid references auth.users(id) default auth.uid(),
  created_at          timestamptz not null default now()
);
create index changements_loyer_bail_idx on public.changements_loyer (bail_id, date_effet);

alter table public.changements_loyer enable row level security;
create policy acces_authentifie on public.changements_loyer
  for all to authenticated using (true) with check (true);


-- ---------------------------------------------------------------------
-- 3. changer_loyer : applique le nouveau loyer aux mois >= date d'effet
--    Retourne le nombre de mois modifiés.
-- ---------------------------------------------------------------------
create or replace function public.changer_loyer(
  p_bail uuid, p_date_effet date, p_nouveau_cents bigint, p_raison text default null
)
returns int
language plpgsql security invoker set search_path = public as $$
declare
  b        baux%rowtype;
  v_mois   date := date_trunc('month', p_date_effet)::date;
  v_fin    date;
  v_ancien bigint;
  v_nb     int;
begin
  select * into b from baux where id = p_bail and deleted_at is null for update;
  if not found then raise exception 'Bail introuvable.'; end if;
  if p_nouveau_cents is null or p_nouveau_cents < 0 then
    raise exception 'Le nouveau loyer doit être un montant positif.';
  end if;
  if v_mois < date_trunc('month', b.date_debut)::date then
    raise exception 'Le nouveau loyer ne peut pas commencer avant le début du bail.';
  end if;
  v_fin := coalesce(b.date_depart, b.date_fin);
  if v_fin is not null and v_mois > date_trunc('month', v_fin)::date then
    raise exception 'Le nouveau loyer ne peut pas commencer après la fin du bail.';
  end if;

  select loyer_cents into v_ancien from echeances where bail_id = p_bail and mois = v_mois;
  v_ancien := coalesce(v_ancien, b.loyer_cents);
  if v_ancien = p_nouveau_cents then
    raise exception 'Le loyer est déjà de ce montant pour ce mois.';
  end if;

  update echeances
     set loyer_cents = p_nouveau_cents, updated_at = now()
   where bail_id = p_bail and mois >= v_mois;
  get diagnostics v_nb = row_count;

  -- Loyer de référence du bail : sert aux mois générés plus tard (bail à durée
  -- indéterminée) et à l'état des loyers pour le prêteur.
  update baux set loyer_cents = p_nouveau_cents, updated_at = now() where id = p_bail;

  insert into changements_loyer (bail_id, date_effet, ancien_loyer_cents, nouveau_loyer_cents, raison)
  values (p_bail, v_mois, v_ancien, p_nouveau_cents, nullif(btrim(p_raison), ''));

  return v_nb;
end $$;
