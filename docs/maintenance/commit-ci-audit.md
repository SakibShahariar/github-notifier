# Commit CI Audit Ledger

Persistent repository-specific record of commit-level CI checks and red-cross investigations.

## How to use this ledger

1. Read this file before auditing commit checks.
2. Check only commits newer than the checkpoint, plus older **red**, **pending**, or explicitly unresolved entries.
3. Record exact commit SHAs and observed results; never infer from missing badges or empty API responses.
4. Preserve failures and append diagnosis, fix, rerun, and final-outcome evidence.
5. Advance the checkpoint only after reviewing the range; carry unresolved entries forward.

## Result meanings

| Result | Meaning |
|---|---|
| **green** | Completed successful check/run directly observed. |
| **red** | Completed failing check/run directly observed. |
| **pending** | Check/run exists but is unfinished. |
| **unavailable** | Available evidence did not expose a result; not a pass or failure. |
| **not applicable** | Workflow configuration confirms no relevant check is triggered. |

## Checkpoint

- Repository: `SakibShahariar/github-notifier`
- Default branch: `main`
- Checkpoint SHA: `e91dc83cc9279105c6362140976460d4882ceaa5`
- Initialized: 2026-11-02
- Latest reviewed: 2026-11-09
- Baseline: latest branch tip queried through combined commit-status endpoint; empty status list recorded as **unavailable**, not green/red. Older history was not retroactively audited during setup.
- Next session: review commits after `e91dc83cc9279105c6362140976460d4882ceaa5`, including this ledger update commit; older failures in the range below have documented fixes and final green follow-up runs.

## Initial baseline

| Commit SHA | Subject | CI result | Checked | Follow-up |
|---|---|---|---|---|
| `73159be5552892b6ddb2548e5917067f4ad49f96` | Default-branch tip at ledger initialization | unavailable | 2026-11-02 | Combined status lookup returned no entries. Revisit if new run or visible failure evidence appears. |

## Red-cross investigation log

No red result was confirmed from the status data retrieved during setup.

### Failure record template

- Commit SHA:
- Commit subject:
- First observed (date):
- Workflow / run URL:
- Failed job / step:
- Failure summary:
- Classification: regression / pre-existing / inconclusive
- Fix commit(s):
- Rerun attempt(s) and result:
- Final verified outcome:
- Remaining follow-up:


## Incremental audit — 2026-11-02 through 2026-11-09

Reviewed every commit after the initial checkpoint through `e91dc83cc9279105c6362140976460d4882ceaa5`. All 21 commits had a corresponding completed validation run. Eight runs were red; their failing tests, diagnoses, and follow-up fixes are recorded below. The current UI fix commit is green.

| Commit SHA | Subject | Result | Date | Workflow run |
|---|---|---|---|---|
| `ae76d3b6f9c30af7a48872955bc9b7d992ea8e00` | docs: add persistent commit CI audit ledger | green | 2026-11-02 | [#41456587612](https://github.com/SakibShahariar/github-notifier/actions/runs/41456587612) |
| `2c80ef19e98031e0672c6b8434c09cf97d3170e3` | docs: document incremental commit CI auditing | green | 2026-11-02 | [#41456592578](https://github.com/SakibShahariar/github-notifier/actions/runs/41456592578) |
| `1f06ae46f120ca446e4f77b1ebb5259c447d24b9` | docs: define issue triage categories | green | 2026-11-03 | [#41573391424](https://github.com/SakibShahariar/github-notifier/actions/runs/41573391424) |
| `e2ea44105604d0e7364ec35df24f0f49a7f0112f` | docs(agents): define administrative commit hygiene | green | 2026-11-03 | [#41598058551](https://github.com/SakibShahariar/github-notifier/actions/runs/41598058551) |
| `d926425407d55c343c3816c441bd571bec17e6fd` | docs(agents): clarify acceptance criteria evidence | green | 2026-11-04 | [#41864117808](https://github.com/SakibShahariar/github-notifier/actions/runs/41864117808) |
| `e07e3d7e67711820676cc505ac865e3aa3b46a70` | docs: improve README navigation and quick start | green | 2026-11-08 | [#42506467886](https://github.com/SakibShahariar/github-notifier/actions/runs/42506467886) |
| `afbc8b4fa0eb761d988d66e943a82d650ce7e109` | docs: polish README feature overview | green | 2026-11-08 | [#42506664633](https://github.com/SakibShahariar/github-notifier/actions/runs/42506664633) |
| `fa758f11356af4acfcf5fbecb69016737747901a` | docs: streamline README and add user guide | red | 2026-11-08 | [#42506995165](https://github.com/SakibShahariar/github-notifier/actions/runs/42506995165) |
| `8d14f32bfff4def94aad7acfc5c98645e6558ffa` | docs: preserve tested installation instructions | green | 2026-11-08 | [#42507044238](https://github.com/SakibShahariar/github-notifier/actions/runs/42507044238) |
| `c146ffa9299230f01df507a5e7f01a9d6daf15d8` | docs: trim README to a project landing page | green | 2026-11-08 | [#42508498938](https://github.com/SakibShahariar/github-notifier/actions/runs/42508498938) |
| `9ebc08cea095b9405324fbe230d16eaa92b17d08` | docs: restore a complete project README | green | 2026-11-08 | [#42508915284](https://github.com/SakibShahariar/github-notifier/actions/runs/42508915284) |
| `89d6ddaafd7c640a1592f3589451cc7950685a74` | fix(panel): load bundled GitHub SVG through Gio.FileIcon | green | 2026-11-09 | [#42629763594](https://github.com/SakibShahariar/github-notifier/actions/runs/42629763594) |
| `91482cdecad0028b85709fb192bccbd3ca0804d4` | test(panel): cover bundled SVG icon loading | red | 2026-11-09 | [#42629777604](https://github.com/SakibShahariar/github-notifier/actions/runs/42629777604) |
| `11b0630cec3ba8aa155787ff638b08f5f5fc3397` | fix(auth): validate API hosts without runtime URL constructor | red | 2026-11-09 | [#42634914164](https://github.com/SakibShahariar/github-notifier/actions/runs/42634914164) |
| `f83c640d7d1dddba2e0e18ba4ef7a1c8054ae851` | test(auth): accept GitHub web host as public API alias | red | 2026-11-09 | [#42634930489](https://github.com/SakibShahariar/github-notifier/actions/runs/42634930489) |
| `b66a9bb7133d2d26dfe52c59d6ef31855f3cf153` | fix(auth): correct API host character validation | red | 2026-11-09 | [#42635000768](https://github.com/SakibShahariar/github-notifier/actions/runs/42635000768) |
| `0d7cc1e21ec8d520187da87dca51e9b9f4954e73` | fix(auth): handle API host validation escapes correctly | red | 2026-11-09 | [#42635038442](https://github.com/SakibShahariar/github-notifier/actions/runs/42635038442) |
| `c2fa14478cb7371431f4ae3cbcddce9d101f2885` | fix(ui): correct popup layout, hover, icon, and tooltips | red | 2026-11-09 | [#42647907903](https://github.com/SakibShahariar/github-notifier/actions/runs/42647907903) |
| `ce92dbcd33fd17e8bfbc8c6428872fb4949156ef` | fix(ui): inherit shell tooltip and hover colors | green | 2026-11-09 | [#42648046926](https://github.com/SakibShahariar/github-notifier/actions/runs/42648046926) |
| `a64612c923318ae85bbb1426a81a8ddd9becde6d` | fix(ui): size tooltips to their content | red | 2026-11-09 | [#42648220595](https://github.com/SakibShahariar/github-notifier/actions/runs/42648220595) |
| `e91dc83cc9279105c6362140976460d4882ceaa5` | fix(ui): preserve theme-aware popup styling | green | 2026-11-09 | [#42648304659](https://github.com/SakibShahariar/github-notifier/actions/runs/42648304659) |

### Red-cross diagnoses and follow-ups

- `fa758f11356af4acfcf5fbecb69016737747901a`: the install-instructions test expected the README to preserve the tested copy command for every JavaScript module. The README rewrite omitted it. Classification: documentation/test regression. Follow-up: `8d14f32bfff4def94aad7acfc5c98645e6558ffa` restored the installation instructions; its workflow run is green.
- `91482cdecad0028b85709fb192bccbd3ca0804d4`: the bundled SVG source-test used an incorrectly escaped regular expression and matched zero FileIcon constructions. Follow-up: `ce92dbcd33fd17e8bfbc8c6428872fb4949156ef` corrected the expression; its workflow run is green.
- `11b0630cec3ba8aa155787ff638b08f5f5fc3397`, `f83c640d7d1dddba2e0e18ba4ef7a1c8054ae851`, and `b66a9bb7133d2d26dfe52c59d6ef31855f3cf153`: API-host validation did not consistently handle percent-encoded backslashes and escaped host/path input. Follow-up: `0d7cc1e21ec8d520187da87dca51e9b9f4954e73` corrected the validation logic; the API-host tests passed in that run, although the run remained red because of the separate bundled-icon test failure. The later `ce92dbcd33fd17e8bfbc8c6428872fb4949156ef` run is green.
- `0d7cc1e21ec8d520187da87dca51e9b9f4954e73`: the remaining failure was the same FileIcon source-test regex described above; corrected and green in `ce92dbcd33fd17e8bfbc8c6428872fb4949156ef`.
- `c2fa14478cb7371431f4ae3cbcddce9d101f2885`: the new tooltip CSS introduced hard-coded foreground/background colors, violating the existing theme-inheritance test. Follow-up: `ce92dbcd33fd17e8bfbc8c6428872fb4949156ef` removed those overrides and restored Shell theme inheritance; green.
- `a64612c923318ae85bbb1426a81a8ddd9becde6d`: the tooltip-sizing commit was built from a stale tree and unintentionally reverted the theme-safe stylesheet changes, causing the same theme-inheritance test to fail. Follow-up: `e91dc83cc9279105c6362140976460d4882ceaa5` restored the intended stylesheet and test; green.

### Current UI fix verification

- Commit: `e91dc83cc9279105c6362140976460d4882ceaa5`
- Workflow: [#42648304659](https://github.com/SakibShahariar/github-notifier/actions/runs/42648304659)
- Result: **green** — JavaScript syntax, all 179 Node tests, extension metadata JSON, and strict GSettings schema validation passed.
- Live GNOME visual/hover/keyboard validation is not covered by CI and remains open on issues #24, #70, #71, and #72.

## Session history

| Date | Reviewed range / checkpoint | Result summary |
|---|---|---|
| 2026-11-02 | Initial checkpoint: `73159be5552892b6ddb2548e5917067f4ad49f96` | Latest commit queried; empty status response recorded as unavailable. Earlier history not retroactively audited. |
| 2026-11-09 | `73159be5552892b6ddb2548e5917067f4ad49f96` → `e91dc83cc9279105c6362140976460d4882ceaa5` | Reviewed 21 commits and all 21 workflow runs; 13 green, 8 red with follow-up diagnoses/fixes recorded above. Current UI fix is green (179/179 tests). Live GNOME validation remains open. |
