-- phase: expand
-- OpenVibe.Meme M6: the generator. A template now carries its own text layout (boxes, font, size, colour, outline,
-- alignment and wrap), so a rendered meme uses the format's layout rather than plain text over a picture. A saved
-- caption keeps the labels the AI suggested and the Media object id of the rendered PNG; the daily generation
-- budget is counted per UTC day.

ALTER TABLE meme_templates ADD COLUMN layout jsonb;
ALTER TABLE meme_captions ADD COLUMN labels text[] NOT NULL DEFAULT '{}'::text[];
ALTER TABLE meme_captions ADD COLUMN media_id text COLLATE "C";
ALTER TABLE meme_captions ADD CONSTRAINT meme_captions_labels CHECK (
    labels <@ ARRAY['nudity', 'language', 'graphic', '18+', 'flashing', 'spoilers']::text[]
    AND coalesce(array_position(labels, NULL), 0) = 0
    AND cardinality(labels) <= 6
);
ALTER TABLE meme_captions ADD CONSTRAINT meme_captions_media CHECK (media_id IS NULL OR media_id ~ '^med_[0-9A-HJKMNP-TV-Z]{26}$');

-- The three seeded templates get a layout in the same 440×280 canvas as their placeholder artwork. A box is
-- {x,y,w,h,font,size,color,outline,outline_width,align,valign,uppercase,wrap}; `font` names a file under
-- server/assets/fonts (no system font is trusted).
UPDATE meme_templates SET layout = $json${
  "width": 440, "height": 280,
  "boxes": [
    {"x": 34, "y": 34, "w": 372, "h": 72, "font": "DejaVuSans-Bold", "size": 26, "color": "#ffffff", "outline": "#000000", "outline_width": 2, "align": "center", "valign": "middle", "uppercase": true, "wrap": true},
    {"x": 34, "y": 192, "w": 372, "h": 66, "font": "DejaVuSans-Bold", "size": 26, "color": "#ffffff", "outline": "#000000", "outline_width": 2, "align": "center", "valign": "middle", "uppercase": true, "wrap": true}
  ]
}$json$::jsonb WHERE id = 'tpl_classic';

UPDATE meme_templates SET layout = $json${
  "width": 440, "height": 280,
  "boxes": [
    {"x": 60, "y": 204, "w": 320, "h": 34, "font": "DejaVuSans-Bold", "size": 20, "color": "#ffffff", "outline": "#000000", "outline_width": 2, "align": "center", "valign": "middle", "uppercase": false, "wrap": true}
  ]
}$json$::jsonb WHERE id = 'tpl_reaction';

UPDATE meme_templates SET layout = $json${
  "width": 440, "height": 280,
  "boxes": [
    {"x": 30, "y": 60, "w": 108, "h": 120, "font": "DejaVuSans-Bold", "size": 16, "color": "#ffffff", "outline": "#000000", "outline_width": 2, "align": "center", "valign": "middle", "uppercase": false, "wrap": true},
    {"x": 166, "y": 60, "w": 108, "h": 120, "font": "DejaVuSans-Bold", "size": 16, "color": "#ffffff", "outline": "#000000", "outline_width": 2, "align": "center", "valign": "middle", "uppercase": false, "wrap": true},
    {"x": 302, "y": 60, "w": 108, "h": 120, "font": "DejaVuSans-Bold", "size": 16, "color": "#ffffff", "outline": "#000000", "outline_width": 2, "align": "center", "valign": "middle", "uppercase": false, "wrap": true}
  ]
}$json$::jsonb WHERE id = 'tpl_triptych';

-- Generation's own budget: one research.gather and one ai.extract per request, reserved before the first.
CREATE TABLE meme_generate_usage (
    day        date PRIMARY KEY,
    calls      integer NOT NULL DEFAULT 0,
    cost_usd   numeric(14, 6) NOT NULL DEFAULT 0,
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT meme_generate_usage_calls CHECK (calls >= 0),
    CONSTRAINT meme_generate_usage_cost CHECK (cost_usd >= 0)
);
