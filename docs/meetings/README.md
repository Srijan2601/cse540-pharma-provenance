# Sync notes

The team holds a weekly sync on Sundays, a mid-week check-in in the group chat, and an integration session before each due date. This folder holds one note per Sunday sync, from 11/01 to 11/22, and the milestones up to 11/27.

**Public repository:** the notes record decisions, progress and action items only. Attendance, absences and anything personal stay in the team's private log, as [`TEMPLATE.md`](TEMPLATE.md) says.

**How these notes were written.** They were written up on 2026-11-27 from the repository's history: its pull requests, its commits, and the roadmap that the root README carried at each date. They state what the repository held at each sync, which roadmap items were open, and how each was resolved; every completed item links to the pull request that delivered it. They do not reconstruct what was said at a sync.

## Notes

| Sync | State of `main` at the sync | Next deadline then |
|---|---|---|
| [2026-11-01](2026-11-01.md) | Project set up; contract API fixed in the interface; all ten write functions are stubs ([#1](https://github.com/Srijan2601/cse540-pharma-provenance/pull/1), [#2](https://github.com/Srijan2601/cse540-pharma-provenance/pull/2)) | Draft Smart Contract Design, 11/01 |
| [2026-11-08](2026-11-08.md) | Unchanged since 11/01 | Interim Demo, 11/15 |
| [2026-11-15](2026-11-15.md) | Custody journey implemented: four of the ten write functions, and the terminal demo script ([#3](https://github.com/Srijan2601/cse540-pharma-provenance/pull/3)) | Interim Demo, 11/15 |
| [2026-11-22](2026-11-22.md) | Unchanged since 11/15 | Final deliverables, 12/04 |

## Since the 11/22 sync

The action items of the 11/22 sync were completed in the week that followed:

- **Wed 11/25, features complete** ([#4](https://github.com/Srijan2601/cse540-pharma-provenance/pull/4)), on the date planned in design decision D3.
  - Contracts: all ten write functions, split into a base and three modules; 495 tests and 100% line coverage.
  - Oracle / IPFS: file store, upload and gateway service, encryption of confidential attachments, sensor simulator and the oracle; 523 tests.
  - Frontend: role dashboards, a QR code per lot and the patient verify page; 190 tests.
  - Docs / QA / analysis: README, test plan, document schemas, the gas report, CI jobs for the two new packages, the MIT license.
- **Thu 11/26, Polygon Amoy** ([#5](https://github.com/Srijan2601/cse540-pharma-provenance/pull/5)). The registry was deployed and the terminal demo ran on the network once. See [`../amoy-deployment.md`](../amoy-deployment.md).
- **Fri 11/27, final documentation.** The README was restructured for the final submission, and the manual test plan, the Amoy deployment record and these notes were added.

## Milestones

| Date | Milestone | Where |
|---|---|---|
| 10/25 | Proposal and team contract submitted | not in this repository |
| 11/01 | Draft Smart Contract Design submitted | [#1](https://github.com/Srijan2601/cse540-pharma-provenance/pull/1), [#2](https://github.com/Srijan2601/cse540-pharma-provenance/pull/2) |
| 11/15 | Interim Demo submitted | [#3](https://github.com/Srijan2601/cse540-pharma-provenance/pull/3) |
| 11/25 | Features complete | [#4](https://github.com/Srijan2601/cse540-pharma-provenance/pull/4) |
| 11/26 | Registry deployed on Polygon Amoy and the terminal demo run there | [#5](https://github.com/Srijan2601/cse540-pharma-provenance/pull/5), [`../amoy-deployment.md`](../amoy-deployment.md) |
| 11/27 | README and documentation finalized for the submission | the root [README](../../README.md) |
