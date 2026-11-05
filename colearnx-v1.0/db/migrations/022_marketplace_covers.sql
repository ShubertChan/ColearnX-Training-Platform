-- Public artwork is separate from protected delivery files and bound to the reviewed offering/version.
ALTER TABLE course_runs ADD COLUMN cover_image bytea
  CHECK (octet_length(cover_image) BETWEEN 1 AND 262144);
ALTER TABLE content_versions ADD COLUMN cover_image bytea
  CHECK (octet_length(cover_image) BETWEEN 1 AND 262144);
