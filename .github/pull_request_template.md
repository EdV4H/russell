## 概要

<!-- 何を・なぜ。関連 Issue / フェーズ（P0〜P3）・準備物 -->

## チェック

- [ ] `pnpm typecheck` / `pnpm lint` が通る
- [ ] 変更したプラグイン/装備が conformance suite（docs/preparation/acceptance/equipment-conformance-suite.md）を満たす
- [ ] 破壊的/対外的な副作用は Policy Gate（default-deny）と HITL/事前承認を通る（§12）
- [ ] untrusted テキストを特権ツール引数に直接渡していない（§12-3）

## 発注側レビュー重点パス（該当すれば要重点確認・A-3 §5）

- [ ] `packages/core/` / Policy Gate 原値・効果分類
- [ ] 生成プロンプト（人格・日記・日報・読書カード・ガード）
- [ ] retention・削除・opt-in に関わる記憶実装 / 記憶スキーマ
- [ ] 装備スコープ・danger_level / Finding kind・reason_code 辞書

<!-- 全 PR は発注側レビュー承認が必須（CODEOWNERS で強制）。main への直 push は不可。 -->
