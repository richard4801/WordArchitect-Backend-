-- OPTIONAL seed: the author's existing rulings for book
-- a1b2c3d4-2222-4a2b-9c3d-000000000002, taken from docs/process/gatekeeper/SKILL.md
-- (the Claude-side gatekeeper) and docs/process/claude-hanami-drafting-process.txt
-- section 13. Run AFTER migration 036, and only if the author agrees with every
-- line: these become rules every reviewer enforces (the gatekeeper can BLOCK on
-- them). Edit or delete lines first if any ruling has changed.
INSERT INTO book_rulings (book_id, ruling, category, source) VALUES
('a1b2c3d4-2222-4a2b-9c3d-000000000002', 'First person, past tense.', 'house_rule', 'process doc s13'),
('a1b2c3d4-2222-4a2b-9c3d-000000000002', 'No dashes, except a dash for cut-off dialogue; ellipses for trailing words.', 'house_rule', 'process doc s13'),
('a1b2c3d4-2222-4a2b-9c3d-000000000002', 'Never use "felt", "realized" or "suddenly".', 'banned_pattern', 'process doc s13'),
('a1b2c3d4-2222-4a2b-9c3d-000000000002', 'Figures of speech only if fresh (the blanket simile ban was reversed).', 'house_rule', 'process doc s13'),
('a1b2c3d4-2222-4a2b-9c3d-000000000002', 'No invented eye or hair colours, names or history.', 'house_rule', 'process doc s13'),
('a1b2c3d4-2222-4a2b-9c3d-000000000002', 'A POV character cannot name places nobody told them about, and cannot see a look, only what a face does.', 'house_rule', 'process doc s13'),
('a1b2c3d4-2222-4a2b-9c3d-000000000002', 'Secrets show as shape until another character''s mouth lands them; the narrator does not conclude a reveal for the reader.', 'ruling', 'process doc s13'),
('a1b2c3d4-2222-4a2b-9c3d-000000000002', 'A blow needs a trigger and the other person''s reaction, written through the body. Every turn gets a beat of stillness.', 'house_rule', 'process doc s13'),
('a1b2c3d4-2222-4a2b-9c3d-000000000002', 'No filler that re-narrates. Recognition is a process. Each POV colours the moment; never re-run another POV''s scene.', 'house_rule', 'process doc s13'),
('a1b2c3d4-2222-4a2b-9c3d-000000000002', 'Chapters of about 800 to 1,300 words; splits are welcome.', 'house_rule', 'process doc s13'),
('a1b2c3d4-2222-4a2b-9c3d-000000000002', 'Explicit menace and nudity are allowed in the torture scenes; a sexual assault is never shown being carried out.', 'ruling', 'process doc s13'),
('a1b2c3d4-2222-4a2b-9c3d-000000000002', 'Never quote past dialogue when a character remembers it; retell it in the narrator''s own words.', 'banned_pattern', 'ch574'),
('a1b2c3d4-2222-4a2b-9c3d-000000000002', 'Never "put his/her hand(s) on" anyone, in narration or dialogue: say plainly what was done.', 'banned_pattern', 'ch573'),
('a1b2c3d4-2222-4a2b-9c3d-000000000002', 'No open-and-close-mouth pattern ("opened my mouth... nothing came out", "shut my mouth").', 'banned_pattern', 'gatekeeper SKILL.md'),
('a1b2c3d4-2222-4a2b-9c3d-000000000002', '"Man" is Jace''s word; Kane does not use it.', 'voice', 'gatekeeper SKILL.md'),
('a1b2c3d4-2222-4a2b-9c3d-000000000002', 'No frost, ice or snow words in Southern scenes (the North only).', 'house_rule', 'gatekeeper SKILL.md'),
('a1b2c3d4-2222-4a2b-9c3d-000000000002', 'Northerners speak normal everyday speech, not stiff or old-fashioned.', 'voice', 'gatekeeper SKILL.md'),
('a1b2c3d4-2222-4a2b-9c3d-000000000002', 'Every saved chapter has a specific (never generic) title, the POV name on the first line, and ends with * * *.', 'house_rule', 'process doc step 12');
