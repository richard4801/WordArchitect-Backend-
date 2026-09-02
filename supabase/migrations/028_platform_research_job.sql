-- Makes Platform Craft Notes research survive the writer closing the tab
-- or switching away mid-research. Previously POST /platform-craft-notes/
-- research awaited the full Claude + web_search/web_fetch call inline in
-- the HTTP request/response cycle -- if the browser navigated away, the
-- draft had nowhere to land even if the backend kept working. Now the
-- route kicks the call off detached from the request and persists its
-- progress/result directly on this row, so GET /platform-craft-notes
-- (already polled the same way the Planning Engine's run is polled) is
-- enough to pick the result up later, in any tab, on any device.
ALTER TABLE platform_craft_notes
  ADD COLUMN draft_status VARCHAR(20) NOT NULL DEFAULT 'idle',
  ADD COLUMN draft_content TEXT,
  ADD COLUMN draft_error TEXT,
  ADD COLUMN draft_updated_at TIMESTAMPTZ;
