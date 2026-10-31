# NFL Pool Center — Claude Code essentials

- This repository contains the personal pool website. Consult relevant source and project records for the requested task, not all documentation at session start.
- Treat picks, Survivor rulings, grading, score feeds, and published results as high-integrity data; verify evidence before claims or changes.
- Preserve existing security, release, and rollback gates. Never merge, deploy, change secrets, or modify production data without explicit authorization.
- Delegate large **read-only** multi-file searches to `context-scout` and request a short evidence summary; handle small lookups directly.
- Use `/focused-debug` only when deliberate troubleshooting is needed. Follow the actual repository runbooks and tests.
