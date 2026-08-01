export type CodexEntryType = "character" | "location" | "item" | "lore";

export interface CodexEntry {
  id: string;
  user_id: string;
  book_id: string;
  name: string;
  aliases: string[] | null;
  entry_type: CodexEntryType;
  description: string;
  created_at: string;
}

export interface ManuscriptChunkMatch {
  id: string;
  raw_text: string;
  similarity: number;
}
