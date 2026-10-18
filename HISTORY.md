# Historical snapshot import / 历史快照导入

This commit imports a retained pre-refactor snapshot at publication time. It is not an original historical Git commit, supported release, or recommended installation. Earlier Git history was not available. Author/date describe this import only.

本提交是在发布时导入的修复前保留快照，不是原始历史 Git 提交，也不是建议安装的正式版本。旧版可能缺少后续安全修复；请使用 main 最新版本。没有伪造中间版本、作者或旧时间。

## Imported sequence

1. Retained baseline: helper 0.3.1 and pre-refactor instructions/runner/tests. Historical comparison only; no supported release tag.
2. Retained tested final: helper 0.4.0/schema 2, safety contract and Idle documentation fixes.
3. Public packaging: portable regressions, docs, license and CI. Installed skills are untouched.

Snapshots were imported using current commit timestamps and the publishing account's no-reply author identity. No intervening versions or original creation dates are claimed. Only these retained snapshots are available; private runtime artifacts and local reports were excluded. Public packaging does not reconstruct unavailable development history.
