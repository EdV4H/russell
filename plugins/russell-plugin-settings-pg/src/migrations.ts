import type { MigrationSet } from "@edv4h/russell-migrate";

export const SETTINGS_MIGRATIONS: MigrationSet = {
  namespace: "settings-pg",
  migrations: [
    {
      // 運用設定。**env ではなくここに置く**（§6.1「変更履歴は event_log へ」）。
      // env は秘密と接続先の置き場所で、「日報をどこへ出すか」は運用の判断。
      // 変えるたびに再起動が要るのも、誰が変えたか残らないのも、設定としては筋が悪い。
      id: "0001_agent_settings",
      phase: "expand",
      sql: `
CREATE TABLE IF NOT EXISTS agent_settings (
  agent_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT,
  PRIMARY KEY (agent_id, key)
);
`,
    },
  ],
};
