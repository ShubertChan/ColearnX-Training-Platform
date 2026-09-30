-- Forward-only permission repair for expired upload-intent retries.
-- 005/008 grant column-level storage updates, but not upload_expires_at.
-- Renew the existing reservation without granting table-wide UPDATE or
-- changing any stored file metadata, historical migration, or quota limit.
GRANT UPDATE (upload_expires_at)
  ON public.storage_assets TO colearnx_app;

GRANT UPDATE (upload_expires_at)
  ON public.course_delivery_assets TO colearnx_app;
