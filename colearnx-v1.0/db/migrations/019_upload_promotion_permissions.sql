-- Forward-only, least-privilege repair for W8 verified-object promotion.
-- The API copies a checked incoming object to an immutable delivery key, then
-- atomically updates the existing pending asset row to reference that key.
-- 005/008 already grant the other completion fields; only object_key is missing.
-- Do not change file records, ownership, historical migrations, or grant options.
GRANT UPDATE (object_key)
  ON public.storage_assets TO colearnx_app;

GRANT UPDATE (object_key)
  ON public.course_delivery_assets TO colearnx_app;
