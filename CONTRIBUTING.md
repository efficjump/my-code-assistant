# Contributing

Thanks for helping improve Code Assistant. Focused issues and pull requests are easiest to review and verify.

## Before opening a change

1. Check existing issues and pull requests for overlapping work.
2. Keep provider-specific transport behavior behind the assistant driver contract.
3. Preserve Workspace Trust, approval, revision, and workspace-boundary checks.
4. Add or update tests for observable behavior.
5. Avoid credentials, private repository content, personal identifiers, absolute machine paths, generated bundles, and local signing material.

## Local verification

Install the pinned toolchain and run the complete deterministic check:

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm build
```

Run `pnpm test:e2e` when changing IPC, renderer flows, provider setup, approvals, or mutation behavior. Live provider evaluations are opt-in and must never write credentials or raw private prompts to the repository.

## Pull requests

Describe what changed, why the change is needed, the user-visible impact, and the checks you ran. Keep unrelated refactors separate. Security-sensitive changes should explain the trust boundary and include negative tests.

By contributing, you agree that your contribution is licensed under the repository's MIT License.
