-- phase: expand
-- The next maker slice: persist safe editor geometry and hold member-uploaded templates for review.

ALTER TABLE meme_templates ADD COLUMN moderation_status text NOT NULL DEFAULT 'approved';
ALTER TABLE meme_templates ADD COLUMN uploaded_by text;
ALTER TABLE meme_templates ADD CONSTRAINT meme_templates_moderation_status CHECK (moderation_status IN ('pending', 'approved', 'rejected'));
ALTER TABLE meme_templates ADD CONSTRAINT meme_templates_uploaded_by CHECK (uploaded_by IS NULL OR length(uploaded_by) BETWEEN 1 AND 180);

ALTER TABLE meme_captions ADD COLUMN editor_state jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE meme_captions ADD CONSTRAINT meme_captions_editor_state CHECK (jsonb_typeof(editor_state) = 'object' AND octet_length(editor_state::text) <= 8192);
